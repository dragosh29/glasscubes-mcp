# Glasscubes MCP server

An [MCP](https://modelcontextprotocol.io) server that lets Claude, ChatGPT and other MCP clients work with a Glasscubes client portal: workspaces, information requests (document requests sent to clients, and which items are still outstanding), tasks, file and folder metadata, workspace members and calendar events, and (when enabled) creating tasks and changing their state. It is built from Glasscubes' public API documentation and its published Swagger 2.0 document (`https://api.glasscubes.com/rest/swagger.json`).

Once it's connected, someone at the practice can ask things like:

- "Which clients still owe us year-end documents, and which items are missing?"
- "What's overdue in the Evans Bakery workspace?"
- "What are my open tasks, and what's on the Evans calendar in October?"
- "What's in the Year end 2026 folder, and who uploaded the last bank statement?"
- With writes enabled: "Create a task for Jo to chase Priya for her P60 by 20 October, and mark 'Draft Evans accounts' as completed."

## Tools

| Tool | What it does | API calls |
|---|---|---|
| `list_workspaces` | The current user's workspaces with group and pinned flag. Pages 50 at a time until a page comes back shorter than asked for, which the API documents as the end. `query`, `group_id` and `label` are passed through as the API's `q`, `g` and `l` parameters (the spec does not describe them). | `GET /v3/workspace-list/{first}/{count}` |
| `list_workspace_labels` | Labels on the workspaces the user can access. | `GET /v3/workspace-list/labels` |
| `get_workspace` | One workspace: the user's permission, modules, group, public page. | `GET /v2/workspace/{id}` |
| `list_workspace_members` | Members (users and user groups) with names, company and active status. | `GET /v2/workspace/{id}/members` |
| `list_information_requests` | Requests in a workspace with status, due date, recipient name and a count of items per item status. Optional `statuses` filter, applied by this server because the endpoint takes none. | `GET /v2/irequest/workspace/{id}` |
| `get_information_request` | One request with every item's status, file count and query/response/note counts, and its assignments. | `GET /v2/irequest/{id}` |
| `list_request_templates` | Account-wide templates, or a workspace's with `workspace_id`. | `GET /v2/irequest/templates` |
| `list_tasks` | The user's My Tasks, or a workspace's tasks with the documented `order` parameter (`todo`, `all`, `custom`). | `GET /v2/task/my`, `GET /v2/task/workspace/{id}` |
| `get_task` | One task with state, dates, assignees, labels, attachment titles and form submissions. | `GET /v2/task/{id}` |
| `list_files` | Files and folders in a workspace root or one folder: titles, versions, sizes, who updated them, labels. Metadata only. | `GET /v2/file/browse/{wid}`, `GET /v2/file/browse/{wid}/{fid}` |
| `list_calendar_events` | Events in a workspace between two dates (sent in the documented `dd-MM-yyyy` form): titles, times, attendees and responses; the location only on request. | `GET /v2/cal/get-events/{workspaceId}/{startDate}/{endDate}` |
| `create_task` | Creates a task in a workspace or in the user's My Tasks, with optional due date and user/group assignees. Title up to 253 and description up to 63,999 characters: this server's own limits, borrowed from the post endpoint (the spec documents none for tasks). Only registered when writes are enabled. | `PUT /v2/task` |
| `set_task_state` | Reads the task, sets it to `NEW`, `STARTED` or `COMPLETED`, then reads it back; returns `previous_state` so the change can be undone. Only registered when writes are enabled. | `GET /v2/task/{id}`, `POST /v2/task/{id}/state`, `GET /v2/task/{id}` |

Not covered on purpose: file downloads, previews and signed URLs (never called); sending, deleting or editing information requests; e-signatures, forms, posts, polls, portfolios, workspace creation and membership changes; the "(Internal)" operations in the spec; and GET operations that change state, which the spec contains and this server never calls: `GET /v2/cal/delete-event/{eventId}` (deletes an event), `GET /v2/file2/{id}/lock/add` and `/lock/remove`, `GET /v2/user/expiretoken` and `GET /v2/user/invalidate` (end the current token). There is no reminder endpoint for information requests in the spec, so there is no reminder tool.

## Setup

Requires Node 18 or later.

```bash
npm install
npm run build
```

### Credentials

Glasscubes issues a `client_id` and `client_secret` to an application on request ("Simply contact us for your client ID", support article "Glasscubes API"). With those, the API documentation describes getting a user's access token from `/auth/{cid}/passwd` with that user's email address and password; `/auth/code` (a code handed to your redirect URL after the user logs in) is listed in the spec but the documentation page says it "is not currently supported, however it can be implemented on request". Access tokens are valid for 24 hours; `/auth/refresh` exchanges a refresh token for a new access and refresh token pair.

**This server never takes an email address or password and never calls the password endpoint.** It takes tokens you already have:

- `GLASSCUBES_ACCESS_TOKEN` on its own works for up to 24 hours.
- Add `GLASSCUBES_REFRESH_TOKEN` with `GLASSCUBES_CLIENT_ID` and `GLASSCUBES_CLIENT_SECRET` and the server renews the access token itself through `POST /v2/auth/refresh` when the API rejects it. With these three set, the access token can be left out and the server refreshes before its first call.

**Claude Desktop:** add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "glasscubes": {
      "command": "node",
      "args": ["/absolute/path/to/glasscubes-mcp/dist/index.js"],
      "env": {
        "GLASSCUBES_ACCESS_TOKEN": "your-access-token",
        "GLASSCUBES_REFRESH_TOKEN": "your-refresh-token",
        "GLASSCUBES_CLIENT_ID": "your-client-id",
        "GLASSCUBES_CLIENT_SECRET": "your-client-secret"
      }
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add glasscubes \
  -e GLASSCUBES_ACCESS_TOKEN=your-access-token \
  -e GLASSCUBES_REFRESH_TOKEN=your-refresh-token \
  -e GLASSCUBES_CLIENT_ID=your-client-id \
  -e GLASSCUBES_CLIENT_SECRET=your-client-secret \
  -- node /absolute/path/to/glasscubes-mcp/dist/index.js
```

| Variable | Required | Meaning |
|---|---|---|
| `GLASSCUBES_ACCESS_TOKEN` | yes, unless the three refresh variables are set | A user's access token, sent as `Authorization: Bearer <token>` (a pasted `Bearer ` prefix is stripped). |
| `GLASSCUBES_REFRESH_TOKEN` | no | That user's refresh token, for `POST /v2/auth/refresh`. Needs the two variables below. |
| `GLASSCUBES_CLIENT_ID` | with a refresh token | The client ID Glasscubes issued for your application. |
| `GLASSCUBES_CLIENT_SECRET` | with a refresh token | The matching client secret. |
| `GLASSCUBES_ALLOW_WRITES` | no | `true` to register `create_task` and `set_task_state`. Off by default. |
| `GLASSCUBES_BASE_URL` | no | Defaults to `https://api.glasscubes.com/rest`. Used by the tests. |

## Safety defaults

- Read-only unless `GLASSCUBES_ALLOW_WRITES=true`. Read tools carry the MCP `readOnlyHint` annotation. `create_task` only adds, so it is marked not destructive and not idempotent. `set_task_state` overwrites a task's state, so it is marked destructive (and idempotent); it reads the task first and returns `previous_state`, which can be passed back to undo the change.
- Personal data of clients and staff: names, company names and client codes are returned; email addresses (members, task assignees, request recipients and assignments, calendar attendees), calendar event locations (often an address), an information request's `publicUrl` and each assignment's `publicUrl` (links into the client's view of the request) are only returned with `include_contact_details=true`. Profile picture URLs are never returned.
- Free text is redacted unless `include_contact_details=true`: names of people, workspaces, workspace groups, user groups, modules and labels, client codes, request subjects, descriptions and item names, task titles and descriptions, file and folder titles, form names, event titles and descriptions, a public workspace's title and description, template names, and Glasscubes' own error messages. In all of these, email addresses become `[email redacted]`, phone-number-like sequences `[phone redacted]`, UK postcodes (any case) `[postcode redacted]` and National Insurance numbers `[NI number redacted]`. A payment card number (13 to 19 digits that pass the Luhn check) becomes `[card number redacted]` whether or not contact details were requested. The phone match is a heuristic: international numbers written with `+` or `00` (optionally with a bracketed trunk prefix or area code, as in `+44 (0)7700 900123` or `+1 (415) 555-2671`), UK numbers with a bracketed area code, and UK-style `0…` numbers of 9 to 11 digits; other digit strings starting with `0` are redacted too.
- **Not redacted**, because they cannot be told apart from ordinary text, dates, references and figures: street addresses (only the postcode is caught), dates of birth, UTRs, bank sort codes and account numbers, and money amounts such as salaries. A practice that types these into request descriptions, task text or file titles will see them returned.
- Calendar events never include video-call details: Zoom host and join links and passwords, Teams join links and conference codes are dropped; `has_video_call` says whether there is one.
- No file is ever downloaded or previewed; `list_files` returns metadata only.
- IDs must be positive whole numbers of at most 15 digits (the spec types every path ID as `integer`/`int64`; 15 digits keeps every ID exact as a JSON number, which is how `create_task` sends workspace and assignee IDs); anything else is refused before a request is made. Calendar dates must be real `YYYY-MM-DD` dates with `from` not after `to`; `create_task` refuses a start date after the due date (the API's errCode 130) and a start date without a due date, before sending anything.
- Errors follow the documented convention (HTTP 400 with `{errCode, errMsg}`). errCode 121 or 115, or an HTTP 401, is treated as a rejected token: with refresh configured the token is refreshed once and the request repeated, otherwise the message says to check `GLASSCUBES_ACCESS_TOKEN`. errCode 120, 133 or 200 (or an HTTP 404) is reported as not found; 116 as access denied; 100, 109 to 113 and 119 as a problem with the account or user. The access token, refresh tokens and client secret are replaced with `[redacted]` if they ever appear in an error message.
- Glasscubes documents no rate limit and no 429. Requests are spaced 250 ms apart. A 429 is retried at most twice for any method, waiting for `Retry-After` (seconds, fractional seconds or an HTTP-date; 2 s then 4 s when absent); a wait longer than 10 seconds makes the call give up at once and say how long to wait. 502, 503 and 504 are retried the same way for `GET` only (the suite exercises 502 on a GET; 503 and 504 take the same code path). `PUT /v2/task` and `POST /v2/task/{id}/state` are never retried after a gateway error, because the request may already have been processed; the message says to check with `list_tasks` or `get_task` first. The token refresh (a POST) is not retried after a gateway error either.
- A read that gets a 200 whose body is not JSON (a proxy or login page), is empty, or is JSON of the wrong shape (`null` or an object where the API documents a list; `null`, a list or an empty object where it documents a single record) is an error saying the result is unknown, never an empty list: "no documents outstanding" must not come from a missing answer. An empty 200 body is accepted only from the writes: `POST /v2/task/{id}/state` documents no response body, and a `PUT /v2/task` that answered 200 without the created task is reported as created with a note to check `list_tasks`.

## Tests

```bash
npm test
```

The suite runs offline once `spec.json` is present (it is gitignored and downloaded from `https://api.glasscubes.com/rest/swagger.json` on the first run if missing). It takes about 45 seconds.

1. Validates every fixture record against the Swagger 2.0 definitions (`WorkspaceListItem`, `WorkspaceListLabel`, `WorkspaceInfoV3`, `WorkspaceMemberInfo`, `InformationRequestReadDto`, `InformationRequestTemplateReadDto`, `TaskResponse`, `DiscItem`, `EventInfo`) with Ajv in draft-04 mode, and also fails on any key a definition does not declare, since the definitions allow extra keys and mark almost nothing required. Two negative controls prove the schema and the key walk actually reject things.
2. Starts a local mock of the API under `/rest` that serves those fixtures and validates its list, detail and task-creation responses against each operation's documented response schema. The spec publishes no schema for errors; the mock's error bodies follow the documentation page's `{errCode, errMsg}` form and are validated against a schema written from that text. The mock answers a missing or wrong token with 400 and errCode 121, an unknown ID with 400 and errCode 120 "Item deleted", a bad calendar date with errCode 144, and a wrong refresh token with errCode 104 (all documented codes; which one the live API sends in each case is the mock's assumption). The refresh operation's documented form fields and content type are asserted from the spec.
3. Starts the built server and drives it over stdio with the official MCP client: 28 checks covering tool names and annotations (and that no task length limit is attributed to the API), every read tool, `first`/`count` paging to the documented short page with requests about 250 ms apart (and continuing from `first`), a page of `count`+1 cut to `max_results`, `max_results` caps on information requests and tasks, `q`/`g`/`l`, `workspaceId` and `order` passed through, the local `statuses` filter, the redaction patterns themselves (including what they do not catch), redaction of emails, phones, postcodes and NI numbers by default in free text and in workspace, group, module and label names and client codes, and their return on request, event locations only on request, card numbers redacted always, profile pictures and video-call secrets never returned, no download endpoint ever called, the `PUT /v2/task` body validated against the spec's `TaskRequest` (15-digit IDs sent exactly), a `PUT` answered 200 without a body, the state change as a query parameter with `previous_state` read first and used to undo, local refusals, bad IDs (including 16 digits and more), statuses, `order` and bounds refused before any request, the not-found (errCode 120, 133, 200 and HTTP 404), access-denied (116) and account-error (100, 109 to 113, 119) messages, an expired token refreshed with the documented form POST and the rotated refresh token used next time, starting with only a refresh token, a refresh that hits a 502 not retried, an early refresh before the `expiresIn` a refresh returned, three simultaneous calls sharing one refresh, and a token rejected again after refreshing reported without a second refresh, error text redacted with the access token, refresh token and client secret scrubbed, the 429 retry (seconds, fractional and HTTP-date `Retry-After`, the 2 s fallback when it is missing, a persistent 429, a wait above the cap, a 429 on `PUT /v2/task` retried once), 502 retried for GET (and reported after 3 in a row), a 502 on the PUT and a 503 on the POST never retried, a 200 that is not JSON, empty, or JSON of the wrong shape for every read tool, the write gate (unset and `false`), wrong access and refresh tokens (errCode 121 and 115, and an undocumented 401), a pasted `Bearer ` prefix, and, as the last check, that every request of the whole run went under `/rest`, carried a Bearer token the mock issued or the deliberately wrong one of the wrong-token checks (none on the refresh), and matched a documented method and path, and that the password route was never called.

## Status

This is a working prototype. It has **not been run against the live API**, because it was built without a Glasscubes account (there is no free trial and client IDs are issued on request). Everything below comes from the spec and the documentation page and should be confirmed on a real account:

- What an expired or wrong token gets back. The documentation lists general errors 121 ("OAuth problem…") and 115 ("Unauthorised access") without saying which one, and with which HTTP status, a bad token produces; the server refreshes on either (and on a 401).
- What an unknown ID gets back. The mock answers 400 with errCode 120 "Item deleted", which the spec documents for a missing workspace on several endpoints; the live API might instead answer 200 with an empty body or `null`, which this server reports as an unknown result rather than as not found.
- Token refresh: whether `POST /v2/auth/refresh` really rotates the refresh token (the documentation says it returns "a new user access token and refresh token pair") and whether the old one stops working. The new pair is kept in memory only, so after a restart the refresh token in the environment may already have been used; the error message then says to obtain a new pair.
- What `q`, `g` and `l` on `GET /v3/workspace-list/{first}/{count}` do (the spec gives no description; the mock reads them as a name search, a group ID and a label), and the largest `count` the API accepts (50 per page is this server's own choice).
- Whether that page covers `[first, first+count)` or, as the summary writes it, `[first, first+count]`. The mock serves the half-open range (at most `count` items); the server advances by the number of items actually returned and cuts the result to `max_results`, so either reading works, and the tests include a page of `count`+1.
- `order` on `GET /v2/task/workspace/{id}`: the spec says the endpoint returns tasks that are not completed, and lists `todo`, `all` and `custom` without saying whether `all` includes completed tasks. The mock ignores it.
- Task dates. The spec asks for the beginning and end of the day, then converted to UTC; this server takes the day boundaries in UTC and sends `T00:00:00.000Z` and `T23:59:59.000Z` on the given days, so during British Summer Time the task spans 01:00 to 00:59 UK time. Whether `startDate` may be omitted when `endDate` is given is not documented; the server always sends both.
- The response of `POST /v2/task/{id}/state`, documented only as "default: successful operation" with no body.
- Length limits for task titles and descriptions: the spec documents none for tasks. `create_task` refuses titles over 253 and descriptions over 63,999 characters on its own, borrowing the limit the spec documents for `PUT /v2/post` (errCode 125).
- The meaning of the item statuses (`WAITING`, `COMPLETE`, `DELEGETED`, `AMEND`, `RESUBMITED`, `VERIFIED`, `DECLINED`) and request statuses; the spec lists them without descriptions, so the server reports counts per status rather than deciding which are "outstanding". The tool descriptions say `WAITING` presumably means not yet provided, and say that this is an assumption.
- For `STANDARD` versus `PERSONAL_TAX` requests, which of `sentToUser`, `sentToEmail`, `firstName`/`lastName` and `clientCode` are filled in.
- Whether the calendar range is inclusive and in which time zone the dates are read.
- Rate limits: none documented, and no 429 appears in the spec; the throttle is a guess on the polite side.
- Whether Glasscubes' `errMsg` texts ever echo personal data or tokens; the server redacts and scrubs them regardless.

## Going to production

This version runs locally over stdio with one user's tokens. For a practice to connect from claude.ai or ChatGPT without handling tokens, the next step is a remote server (Streamable HTTP) behind OAuth, hosted by Glasscubes, built on the `/auth/code` flow the documentation says can be enabled, and then a listing in the Claude and ChatGPT connector directories.

## Licence

MIT. Built by Alexandru Dragoș (alexandru.dragos96@gmail.com) with an AI agent (Claude) working under his direction.
