// Local stand-in for api.glasscubes.com/rest, serving the fixtures under the spec's basePath /rest with
// the documented auth ("Authorization: Bearer access_token" on every API operation), the documented
// token refresh (POST /v2/auth/refresh, application/x-www-form-urlencoded client_id, client_secret,
// refresh_token -> TokenResponse) and the documented error convention: "STATUS_CODE=400 ... with a
// { 'errCode': xxx, 'errMsg': 'verbal description of error'} JSON error response" (API documentation
// page, "Errors"). The error codes and messages below are the documented ones: 121 for a missing or
// wrong token, 120 "Item deleted" for an unknown ID, 104 "Invalid refresh token", 130 for a task whose
// start is after its end. Which of them the live API sends in each case is an assumption (see README).
import http from "node:http";
import * as fx from "./fixtures.mjs";

export const ACCESS_TOKEN = "gc-test-token-not-real";
export const REFRESH_TOKEN = "gc-test-refresh-not-real";
export const CLIENT_ID = "gc-test-client-not-real";
export const CLIENT_SECRET = "gc-test-secret-not-real";
export const BASE_PATH = "/rest";
export const REFRESH_PATH = "/v2/auth/refresh";

export const ERR_TOKEN = { errCode: 121, errMsg: "OAuth problem, possible reason missing or not correct oauth parameter" };
export const ERR_DELETED = { errCode: 120, errMsg: "Item deleted" };
export const ERR_REFRESH = { errCode: 104, errMsg: "Invalid refresh token" };

export function startMock() {
  const requests = [];
  const validTokens = new Set([ACCESS_TOKEN]);
  let currentRefresh = REFRESH_TOKEN;
  let refreshes = 0;
  // TokenResponse.expiresIn for the next refreshes (the documentation page: tokens last 24 hours).
  let lifetime = 86400;
  // Injected failures: { method, path, status, times, headers, body }. `body` is JSON, a function of the
  // request that returns JSON, or undefined for a gateway-style HTML page. The suite starts with a
  // single 429 on GET /v2/task/3001 so the retry path is exercised.
  let failures = [];
  let createdTaskId = 3900;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    let body = "";
    for await (const chunk of req) body += chunk;
    const path = url.pathname.startsWith(BASE_PATH + "/") ? url.pathname.slice(BASE_PATH.length) : url.pathname;
    const contentType = req.headers["content-type"];
    let parsed;
    if (body && contentType?.startsWith("application/json")) parsed = JSON.parse(body);
    else if (body && contentType?.startsWith("application/x-www-form-urlencoded")) parsed = Object.fromEntries(new URLSearchParams(body));
    else if (body) parsed = body;
    const record = { method: req.method, path, basePathOk: url.pathname.startsWith(BASE_PATH + "/"), query: Object.fromEntries(url.searchParams), auth: req.headers.authorization, contentType, body: parsed, t: Date.now() };
    requests.push(record);

    const send = (status, json, headers = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(json === undefined ? "" : JSON.stringify(json));
    };

    const failure = failures.find((f) => f.times > 0 && f.method === req.method && f.path === path);
    if (failure) {
      failure.times--;
      if (failure.body === undefined) {
        res.writeHead(failure.status, { "Content-Type": "text/html", ...(failure.headers ?? {}) });
        return res.end(`<html><body><h1>${failure.status}</h1></body></html>`);
      }
      return send(failure.status, typeof failure.body === "function" ? failure.body(record) : failure.body, failure.headers ?? {});
    }

    if (!record.basePathOk) return send(404, undefined);

    // Token refresh: no Authorization header is declared on this operation.
    if (req.method === "POST" && path === REFRESH_PATH) {
      const f = parsed ?? {};
      if (!contentType?.startsWith("application/x-www-form-urlencoded") || f.client_id !== CLIENT_ID || f.client_secret !== CLIENT_SECRET || f.refresh_token !== currentRefresh) return send(400, ERR_REFRESH);
      refreshes++;
      const token = `gc-test-token-refreshed-${refreshes}`;
      // The documentation page: refresh "will then return a new user access token and refresh token
      // pair". The mock assumes the old refresh token stops working once used.
      currentRefresh = `gc-test-refresh-refreshed-${refreshes}`;
      validTokens.add(token);
      return send(200, { access_token: token, refresh_token: currentRefresh, expiresIn: lifetime });
    }

    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    if (!bearer || !validTokens.has(bearer)) return send(400, ERR_TOKEN);

    const p = path.split("/").filter(Boolean);
    const m = req.method;
    const deleted = () => send(400, ERR_DELETED);

    // GET /v3/workspace-list/{first}/{count}: "[first, first+count] workspaces, indexing starts from 0,
    // if it returns less then count, that means user has no more workspaces". The mock serves the
    // half-open range [first, first+count), i.e. at most count items; whether the live API can return
    // count+1 (as the closed interval in the summary reads) is unconfirmed, and e2e.mjs arms a page of
    // count+1 to check the server copes. q, g and l are not described by the spec; the mock reads them
    // as a name search, a group ID and a label.
    if (m === "GET" && p[0] === "v3" && p[1] === "workspace-list") {
      if (p[2] === "labels" && p.length === 3) return send(200, fx.labels);
      if (p.length === 4 && /^\d+$/.test(p[2]) && /^\d+$/.test(p[3])) {
        const q = url.searchParams.get("q")?.toLowerCase();
        const g = url.searchParams.get("g");
        const l = url.searchParams.get("l");
        const items = fx.workspaces.filter((w) => (!q || w.name.toLowerCase().includes(q)) && (!g || String(w.group?.id) === g) && (!l || (fx.workspaceLabels[w.id] ?? []).includes(l)));
        const first = Number(p[2]);
        return send(200, items.slice(first, first + Number(p[3])));
      }
    }

    if (m === "GET" && p[0] === "v2" && p[1] === "workspace" && /^\d+$/.test(p[2] ?? "")) {
      const w = fx.workspaceDetails[p[2]];
      if (!w) return deleted();
      if (p.length === 3) return send(200, w);
      if (p.length === 4 && p[3] === "members") return send(200, fx.members[p[2]] ?? []);
    }

    if (m === "GET" && p[0] === "v2" && p[1] === "irequest") {
      if (p[2] === "templates" && p.length === 3) {
        const wid = url.searchParams.get("workspaceId");
        return send(200, wid ? fx.workspaceTemplates[wid] ?? [] : fx.accountTemplates);
      }
      if (p[2] === "workspace" && p.length === 4) {
        if (!fx.workspaceDetails[p[3]]) return deleted();
        return send(200, fx.informationRequests.filter((r) => String(r.workspaceId) === p[3]));
      }
      if (p.length === 3 && /^\d+$/.test(p[2])) {
        const r = fx.informationRequests.find((x) => String(x.id) === p[2]);
        return r ? send(200, r) : deleted();
      }
    }

    if (p[0] === "v2" && p[1] === "task") {
      if (m === "GET" && p[2] === "my" && p.length === 3) return send(200, fx.myTasks.map((id) => fx.tasks[id]));
      if (m === "GET" && p[2] === "workspace" && p.length === 4) {
        if (!fx.workspaceDetails[p[3]]) return deleted();
        return send(200, (fx.workspaceTasks[p[3]] ?? []).map((id) => fx.tasks[id]));
      }
      if (m === "GET" && p.length === 3 && /^\d+$/.test(p[2])) return fx.tasks[p[2]] ? send(200, fx.tasks[p[2]]) : deleted();
      if (m === "POST" && p.length === 4 && p[3] === "state") {
        const t = fx.tasks[p[2]];
        if (!t) return deleted();
        const state = url.searchParams.get("state");
        if (!["NEW", "STARTED", "COMPLETED"].includes(state)) return send(400, { errCode: 132, errMsg: "Task's state is invalid allowed NEW, STARTED, COMPLETED" });
        t.state = state;
        return send(200, undefined); // documented only as "default: successful operation", no body
      }
      if (m === "PUT" && p.length === 2) {
        const b = parsed ?? {};
        if (!b.title) return send(400, { errCode: 131, errMsg: "Task's title can't be empty" });
        if (b.startDate && b.endDate && b.startDate > b.endDate) return send(400, { errCode: 130, errMsg: "Task start date can't be after task end date" });
        const id = ++createdTaskId;
        const ws = b.workspaceId ? fx.workspaceDetails[b.workspaceId] : undefined;
        const task = {
          id, taskType: "TASK", title: b.title, description: b.description ?? "", ...(b.startDate ? { startDate: b.startDate, endDate: b.endDate } : {}), state: "NEW",
          createdBy: fx.users.alex, creationDate: "2026-09-30T12:00:00.000Z",
          ...(ws ? { workspace: { id: ws.id, name: ws.name, permission: ws.permission, companyWorkspace: false, modules: ws.modules } } : {}),
          labels: [], assignee: (b.assignee ?? []).map((a) => (a.type === "USER" ? { user: Object.values(fx.users).find((u) => u.id === a.id) ?? { id: a.id } } : { group: { id: a.id, name: "Tax team", members: [] } })),
          attachments: [], formSubmits: [],
        };
        fx.tasks[id] = task;
        return send(200, task);
      }
    }

    if (m === "GET" && p[0] === "v2" && p[1] === "file" && p[2] === "browse" && (p.length === 4 || p.length === 5)) {
      if (!fx.workspaceDetails[p[3]]) return deleted();
      const key = p.length === 4 ? p[3] : `${p[3]}/${p[4]}`;
      return fx.browse[key] ? send(200, fx.browse[key]) : deleted();
    }

    // GET /v2/cal/get-events/{workspaceId}/{startDate}/{endDate}: "acceptable date format dd-MM-yyyy";
    // errCode 144 "Invalid date format, valid format: dd-MM-yyyy" is documented on the sibling endpoints.
    if (m === "GET" && p[0] === "v2" && p[1] === "cal" && p[2] === "get-events" && p.length === 6) {
      if (!fx.workspaceDetails[p[3]]) return deleted();
      const parse = (s) => (/^\d{2}-\d{2}-\d{4}$/.test(s) ? `${s.slice(6)}-${s.slice(3, 5)}-${s.slice(0, 2)}` : undefined);
      const from = parse(p[4]);
      const to = parse(p[5]);
      if (!from || !to) return send(400, { errCode: 144, errMsg: "Invalid date format, valid format: dd-MM-yyyy" });
      return send(200, (fx.events[p[3]] ?? []).filter((e) => e.startDate.slice(0, 10) >= from && e.startDate.slice(0, 10) <= to));
    }

    return send(404, undefined);
  });

  const arm = ({ method, path, status, times = 1, headers, body }) => failures.push({ method, path, status, times, headers, body });
  const disarm = () => {
    failures = [];
  };
  /** Make a token stop working, as an expired one would. */
  const revoke = (token) => validTokens.delete(token);
  const state = () => ({ refreshes, currentRefresh, validTokens: [...validTokens] });
  /** expiresIn (seconds) returned by the refreshes that follow. */
  const setTokenLifetime = (seconds) => {
    lifetime = seconds;
  };
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, requests, arm, disarm, revoke, state, setTokenLifetime })));
}
