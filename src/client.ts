// Minimal Glasscubes API client used by the MCP tools.
// Docs: https://www.glasscubes.com/api-documentation/index.html
// Spec: https://api.glasscubes.com/rest/swagger.json (Swagger 2.0, "Glasscubes API" 1.0.0)
import { redactContacts } from "./format.js";

export class GlasscubesError extends Error {
  constructor(message: string, public readonly status?: number, public readonly errCode?: number) {
    super(message);
    this.name = "GlasscubesError";
  }
}

// A 429 means the request was not processed, so it is safe to repeat for any method. A 502/503/504
// from a gateway does not prove the upstream did not process the request, so those are only retried
// for GET: repeating a PUT /v2/task could create the same task twice. Glasscubes documents neither
// a rate limit nor a 429; both rules are defensive.
const RETRY_ANY_METHOD = new Set([429]);
const RETRY_GET_ONLY = new Set([502, 503, 504]);
const MAX_ATTEMPTS = 3;
// Longest single wait honoured from Retry-After. The MCP SDK's default request timeout is 60 s
// (DEFAULT_REQUEST_TIMEOUT_MSEC), so the whole retry budget (at most two waits) must stay well
// under that; a longer Retry-After makes the call give up at once with the wait time in the message.
export const MAX_RETRY_AFTER_S = 10;

// Spec: host api.glasscubes.com, basePath /rest, scheme https.
export const DEFAULT_BASE_URL = "https://api.glasscubes.com/rest";
// Spec: POST /v2/auth/refresh, consumes application/x-www-form-urlencoded, formData client_id,
// client_secret, refresh_token; 200 TokenResponse {access_token, refresh_token, expiresIn}.
export const REFRESH_PATH = "/v2/auth/refresh";

// The API documentation page ("Errors"): an API error is "STATUS_CODE=400 ... with a { 'errCode': xxx,
// 'errMsg': 'verbal description of error'} JSON error response". The general codes listed there that
// concern the token: 121 "OAuth problem, possible reason missing or not correct oauth parameter" and
// 115 "Unauthorised access". Which of them the live API returns for an expired token is not documented.
const TOKEN_ERRORS = new Set([115, 121]);
// 120 "Item deleted" (documented on several endpoints as "when the workspace is not found") and 133
// "Workspace deleted" / "The workspace does not exists or was deleted".
const NOT_FOUND_ERRORS = new Set([120, 133, 200]);
// 116 "Access Denied" and its per-endpoint variants.
const ACCESS_DENIED = 116;
// Account-level errors from the same general list: 100 unknown authentication error, 109 company
// disabled, 110 user disabled, 111 user unconfirmed, 112 user locked, 113 too many users, 119
// application deleted.
const ACCOUNT_ERRORS = new Set([100, 109, 110, 111, 112, 113, 119]);

export type QueryValue = string | number | boolean | undefined;

export interface ClientOptions {
  accessToken?: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  baseUrl?: string;
}

export class GlasscubesClient {
  private readonly baseUrl: string;
  private accessToken?: string;
  private refreshToken?: string;
  private readonly clientId?: string;
  private readonly clientSecret?: string;
  // Set once a refresh has told us how long the new token lives. A token supplied in the environment
  // has an unknown age, so it is used until the API rejects it.
  private expiresAt?: number;
  private refreshInFlight?: Promise<string>;
  // Every value that must never appear in an error message: tokens (configured and issued), the
  // refresh tokens and the client secret. Messages are scrubbed against this list before they leave.
  private readonly secrets = new Set<string>();
  // Glasscubes does not document a rate limit. Space requests at about four per second so a tool call
  // that pages through a list stays polite; 429s are retried using Retry-After.
  private nextSlot = 0;
  private readonly minIntervalMs = 250;

  constructor(opts: ClientOptions) {
    this.baseUrl = withoutUserinfo(opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
    // A token pasted with its "Bearer " prefix (the spec's own "value format:'Bearer access_token'")
    // would otherwise be sent as "Bearer Bearer <token>".
    this.accessToken = opts.accessToken?.trim().replace(/^bearer\s+/i, "").trim() || undefined;
    this.refreshToken = opts.refreshToken?.trim() || undefined;
    this.clientId = opts.clientId?.trim() || undefined;
    this.clientSecret = opts.clientSecret?.trim() || undefined;
    for (const s of [this.accessToken, this.refreshToken, this.clientSecret]) if (s) this.secrets.add(s);
    if (!this.accessToken && !this.canRefresh) {
      throw new GlasscubesError("No credentials: set GLASSCUBES_ACCESS_TOKEN, or GLASSCUBES_REFRESH_TOKEN with GLASSCUBES_CLIENT_ID and GLASSCUBES_CLIENT_SECRET.");
    }
  }

  get canRefresh(): boolean {
    return Boolean(this.refreshToken && this.clientId && this.clientSecret);
  }

  /** Replace every known secret in a message with "[redacted]". */
  private scrub(message: string): string {
    let out = message;
    for (const s of this.secrets) if (s.length >= 4) out = out.split(s).join("[redacted]");
    return out;
  }

  private async scrubbed<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof GlasscubesError) throw new GlasscubesError(this.scrub(err.message), err.status, err.errCode);
      if (err instanceof Error) err.message = this.scrub(err.message);
      throw err;
    }
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const wait = Math.max(0, this.nextSlot - now);
    this.nextSlot = Math.max(now, this.nextSlot) + this.minIntervalMs;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  /** fetch() with the throttle and the 429 / gateway-error retry policy; returns the final Response. */
  private async fetchWithRetry(method: string, url: string, init: { headers: Record<string, string>; body?: string }, what: string): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      await this.throttle();
      let res: Response;
      try {
        res = await fetch(url, { method, headers: init.headers, body: init.body });
      } catch (err) {
        throw new GlasscubesError(`Could not reach Glasscubes at ${originAndPath(url)}: ${(err as Error).message}`);
      }
      const retryable = RETRY_ANY_METHOD.has(res.status) || (method === "GET" && RETRY_GET_ONLY.has(res.status));
      if (retryable && attempt < MAX_ATTEMPTS - 1) {
        const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
        if (retryAfter !== undefined && retryAfter > MAX_RETRY_AFTER_S) {
          throw new GlasscubesError(`Glasscubes asked to wait ${Math.ceil(retryAfter)} seconds before retrying ${method} ${what} (HTTP ${res.status}). Try again after that.`, res.status);
        }
        // A missing or unparsable header falls back to 2 s then 4 s; a Retry-After of 0 (or a date
        // already passed) means retry now, subject to the throttle.
        const delay = retryAfter !== undefined ? retryAfter * 1000 : 2000 * (attempt + 1);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      return res;
    }
  }

  /** The bearer token for the next request, refreshing first when there is none or it is about to expire. */
  private async token(): Promise<string> {
    if (this.accessToken && (this.expiresAt === undefined || Date.now() < this.expiresAt)) return this.accessToken;
    if (this.canRefresh) return this.refresh();
    return this.accessToken!;
  }

  /** POST /v2/auth/refresh, shared by concurrent callers. The pair it returns replaces the old one in memory. */
  private refresh(): Promise<string> {
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.doRefresh().finally(() => {
        this.refreshInFlight = undefined;
      });
    }
    return this.refreshInFlight;
  }

  private async doRefresh(): Promise<string> {
    const form = new URLSearchParams({ client_id: this.clientId!, client_secret: this.clientSecret!, refresh_token: this.refreshToken! });
    // Not retried after a gateway error (it is a POST); a 429 is retried like any request.
    const res = await this.fetchWithRetry(
      "POST",
      this.baseUrl + REFRESH_PATH,
      { headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: form.toString() },
      REFRESH_PATH,
    );
    const text = await res.text();
    const json = text ? safeJson(text) : undefined;
    if (!res.ok) {
      const e = apiError(json);
      const detail = e ? ` Glasscubes said: errCode ${e.code ?? "?"}${e.msg ? `, "${redactContacts(e.msg, false)}"` : ""}.` : "";
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        throw new GlasscubesError(
          `Glasscubes refused to refresh the access token (${res.status}).${detail} Check GLASSCUBES_REFRESH_TOKEN, GLASSCUBES_CLIENT_ID and GLASSCUBES_CLIENT_SECRET. A refresh token is replaced every time it is used, so one that this server (or another app) has already used may no longer work: obtain a new token pair.`,
          res.status,
          e?.code,
        );
      }
      throw new GlasscubesError(`Glasscubes returned ${res.status} when refreshing the access token. The refresh was not retried; try again in a few minutes.${detail}`, res.status);
    }
    const token = json && typeof json === "object" ? json.access_token : undefined;
    if (typeof token !== "string" || !token) {
      throw new GlasscubesError(`Glasscubes answered ${res.status} to the token refresh but the body had no access_token (${describeBody(res, text, json)}). Check GLASSCUBES_BASE_URL.`, res.status);
    }
    this.accessToken = token;
    this.secrets.add(token);
    if (typeof json.refresh_token === "string" && json.refresh_token) {
      this.refreshToken = json.refresh_token;
      this.secrets.add(json.refresh_token);
    }
    // TokenResponse.expiresIn: "token expires after issued in seconds" (the documentation page: valid
    // for 24 hours). Refresh a minute early, or halfway through a lifetime shorter than two minutes.
    const expiresIn = Number(json.expiresIn);
    this.expiresAt = Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 - Math.min(60_000, (expiresIn * 1000) / 2) : undefined;
    return token;
  }

  /**
   * One API call. A 200 with an empty body is an error unless `allowEmpty` is set: only the writes
   * pass it (POST /v2/task/{id}/state documents no response body, and a PUT /v2/task that answered 200
   * has been processed whatever its body), so a read can never turn "no answer" into "nothing there".
   */
  request<T = any>(method: string, path: string, opts: { query?: Record<string, QueryValue>; body?: unknown; allowEmpty?: boolean } = {}): Promise<T> {
    return this.scrubbed(() => this.send<T>(method, path, opts));
  }

  private async send<T>(method: string, path: string, opts: { query?: Record<string, QueryValue>; body?: unknown; allowEmpty?: boolean }): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));

    for (let authAttempt = 0; ; authAttempt++) {
      const bearer = await this.token();
      const res = await this.fetchWithRetry(
        method,
        url.toString(),
        {
          headers: {
            Authorization: `Bearer ${bearer}`,
            Accept: "application/json",
            ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        },
        path,
      );

      const text = await res.text();
      const json = text ? safeJson(text) : undefined;
      if (res.ok) {
        // Some operations document only a "default" response with no body (POST /v2/task/{id}/state).
        if (text.trim() === "") {
          if (opts.allowEmpty) return undefined as T;
          throw new GlasscubesError(`Glasscubes returned ${res.status} for ${method} ${path} with an empty body, where the API documents data. The result is unknown, not empty: check the ID, try again, and check GLASSCUBES_BASE_URL if it keeps happening.`, res.status);
        }
        // A 200 with HTML (a proxy, a login page) must not be mistaken for an empty list.
        if (json === undefined) {
          throw new GlasscubesError(`Glasscubes returned ${res.status} for ${method} ${path} but the body was not JSON (${describeBody(res, text, json)}). Check GLASSCUBES_BASE_URL and whether a proxy or login page is in the way.`, res.status);
        }
        return json as T;
      }

      const e = apiError(json);
      // errMsg is free text: redact anything that looks like a contact detail before passing it on.
      const detail = e ? ` Glasscubes said: errCode ${e.code ?? "?"}${e.msg ? `, "${redactContacts(e.msg, false)}"` : ""}.` : "";
      const tokenProblem = res.status === 401 || (res.status === 400 && e?.code !== undefined && TOKEN_ERRORS.has(e.code));
      if (tokenProblem) {
        // The token was rejected, so the request was not processed: refresh once and repeat it.
        if (this.canRefresh && authAttempt === 0) {
          await this.refresh();
          continue;
        }
        throw new GlasscubesError(
          this.canRefresh
            ? `Glasscubes rejected the access token (${res.status}) even after refreshing it.${detail} Check that the user behind GLASSCUBES_REFRESH_TOKEN still has access to this account.`
            : `Glasscubes rejected the access token (${res.status}).${detail} Check GLASSCUBES_ACCESS_TOKEN: access tokens are valid for 24 hours. To renew them automatically, also set GLASSCUBES_REFRESH_TOKEN, GLASSCUBES_CLIENT_ID and GLASSCUBES_CLIENT_SECRET.`,
          res.status,
          e?.code,
        );
      }
      if (res.status === 403 || e?.code === ACCESS_DENIED) {
        throw new GlasscubesError(`Glasscubes refused ${method} ${path}: access denied (${res.status}).${detail} The user behind the token may not be a member of this workspace or may lack the permission this needs.`, res.status, e?.code);
      }
      if (res.status === 404 || (e?.code !== undefined && NOT_FOUND_ERRORS.has(e.code))) {
        throw new GlasscubesError(`Not found: ${path}. Glasscubes reports it as missing or deleted; check the ID.${detail}`, 404, e?.code);
      }
      if (e?.code !== undefined && ACCOUNT_ERRORS.has(e.code)) {
        throw new GlasscubesError(`Glasscubes refused ${method} ${path} because of the account or user behind the token (${res.status}).${detail} An administrator of the Glasscubes account needs to look at this.`, res.status, e.code);
      }
      if (res.status === 429) throw new GlasscubesError("Glasscubes rate limit reached (the limit is not documented). Wait a minute and try again.", 429);
      if (method !== "GET" && RETRY_GET_ONLY.has(res.status)) {
        throw new GlasscubesError(
          `Glasscubes returned ${res.status} for ${method} ${path}. The request was not retried because it may already have been processed: check with list_tasks or get_task before repeating it.${e ? detail : ""}`,
          res.status,
        );
      }
      if (RETRY_GET_ONLY.has(res.status)) {
        throw new GlasscubesError(`Glasscubes returned ${res.status} for ${method} ${path} ${MAX_ATTEMPTS} times in a row. The service may be unavailable; try again in a few minutes.${e ? detail : ""}`, res.status);
      }
      if (res.status === 400) throw new GlasscubesError(`Glasscubes refused ${method} ${path} (400).${detail}`, 400, e?.code);
      throw new GlasscubesError(`Glasscubes returned ${res.status} for ${method} ${path}.${detail}`, res.status, e?.code);
    }
  }

  get<T = any>(path: string, query?: Record<string, QueryValue>) {
    return this.request<T>("GET", path, { query });
  }

  /** A GET whose documented 200 is a JSON array. Anything else (null, an object) is an error, never an empty list. */
  async getList<T = any>(path: string, query?: Record<string, QueryValue>): Promise<T[]> {
    const res = await this.get<unknown>(path, query);
    if (!Array.isArray(res)) throw unexpectedShape("GET", path, "a list", res);
    return res as T[];
  }

  /** A GET whose documented 200 is a JSON object (a record). null, an array, {} or a bare value is an error. */
  async getObject<T = Record<string, any>>(path: string, query?: Record<string, QueryValue>): Promise<T> {
    const res = await this.get<unknown>(path, query);
    if (!res || typeof res !== "object" || Array.isArray(res) || Object.keys(res).length === 0) throw unexpectedShape("GET", path, "a record", res);
    return res as T;
  }

  /**
   * GET /v3/workspace-list/{first}/{count}: "Returns the current user's [first, first+count]
   * workspaces, indexing starts from 0, if it returns less then count, that means user has no more
   * workspaces". Pages of `pageSize` from `first` until a page shorter than requested (the documented
   * end), `maxItems` or `maxPages`. The summary's closed interval would allow count+1 items in a
   * page; the cursor advances by what actually came back, and the result is cut to `maxItems` with
   * `next_first` pointing just after the last item returned.
   */
  async listWorkspaces<T = any>(
    { first = 0, maxItems = 50, maxPages = 20, pageSize = 50, query = {} as Record<string, QueryValue> } = {},
  ): Promise<{ items: T[]; complete: boolean; next_first?: number }> {
    const items: T[] = [];
    let cursor = first;
    for (let n = 0; n < maxPages; n++) {
      const count = Math.max(1, Math.min(pageSize, maxItems - items.length));
      const data = await this.getList<T>(`/v3/workspace-list/${cursor}/${count}`, query);
      items.push(...data);
      cursor += data.length;
      if (items.length > maxItems) {
        items.length = maxItems;
        return { items, complete: false, next_first: first + maxItems };
      }
      if (data.length < count) return { items, complete: true };
      if (items.length >= maxItems) return { items, complete: false, next_first: cursor };
    }
    return { items, complete: false, next_first: cursor };
  }
}

/** A 200 whose JSON is not the documented shape: reported, never read as "nothing there". */
function unexpectedShape(method: string, path: string, wanted: string, got: unknown): GlasscubesError {
  const kind =
    got === null ? "null"
    : Array.isArray(got) ? "a list"
    : typeof got === "object" ? (Object.keys(got as object).length ? `an object with keys [${Object.keys(got as object).slice(0, 10).join(", ")}]` : "an empty object")
    : `a ${typeof got}`;
  return new GlasscubesError(
    `Glasscubes returned 200 for ${method} ${path} but the body was ${kind}, not ${wanted} as the API documents. The result is unknown, not empty: check the ID (an unknown one may be answered this way), and check GLASSCUBES_BASE_URL if it keeps happening.`,
    200,
  );
}

/** The documented error body {errCode, errMsg}, if that is what came back. */
function apiError(json: any): { code?: number; msg?: string } | undefined {
  if (!json || typeof json !== "object" || Array.isArray(json)) return undefined;
  const code = Number.isInteger(json.errCode) ? json.errCode : /^\d+$/.test(String(json.errCode ?? "")) ? Number(json.errCode) : undefined;
  const msg = typeof json.errMsg === "string" && json.errMsg.trim() ? json.errMsg.trim() : undefined;
  return code === undefined && msg === undefined ? undefined : { code, msg };
}

function originAndPath(url: string): string {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return "(invalid URL)";
  }
}

function withoutUserinfo(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new GlasscubesError("GLASSCUBES_BASE_URL is not a valid URL.");
  }
  if (u.username || u.password) throw new GlasscubesError("GLASSCUBES_BASE_URL must not contain a username or password.");
  return url;
}

/** What a body was, without quoting it: content type, size, and the JSON keys when it parsed as an object. */
function describeBody(res: Response, text: string, json: unknown): string {
  const type = res.headers.get("content-type")?.split(";")[0].trim() || "no content-type";
  const size = `${Buffer.byteLength(text)} bytes`;
  if (json === undefined) return `${type}, ${size}`;
  if (json && typeof json === "object" && !Array.isArray(json)) return `${type}, ${size}, JSON with keys [${Object.keys(json).slice(0, 10).join(", ")}]`;
  return `${type}, ${size}`;
}

/**
 * Retry-After in seconds, from either form allowed by RFC 9110 (delay-seconds or an HTTP-date).
 * A fractional number is accepted as seconds too. Anything else that is not an HTTP-date (which always
 * names a month, so contains letters) gives undefined, so the caller's fallback applies; without that
 * check Date.parse("1.5") would be read as a date in 2001 and the retry would happen at once.
 */
export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const h = header.trim();
  if (/^\d+(\.\d+)?$/.test(h)) return Number(h);
  if (!/[A-Za-z]/.test(h)) return undefined;
  const at = Date.parse(h);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, (at - now) / 1000);
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
