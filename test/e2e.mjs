// End-to-end test: fixtures are validated against the definitions in Glasscubes' published Swagger 2.0
// document, then the built MCP server is driven over stdio by a real MCP client against a local mock of
// the API (including its token refresh endpoint).
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv04 from "ajv-draft-04";
import addFormats from "ajv-formats";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fx from "./fixtures.mjs";
import { redactContacts } from "../dist/format.js";
import { startMock, ACCESS_TOKEN, REFRESH_TOKEN, CLIENT_ID, CLIENT_SECRET, BASE_PATH, REFRESH_PATH, ERR_TOKEN, ERR_DELETED, ERR_REFRESH } from "./mock-server.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const started = Date.now();
let passed = 0;
const check = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
};

// 1. Fixtures match the published spec (so the mock returns what the real API documents).
const SPEC_URL = "https://api.glasscubes.com/rest/swagger.json";
if (!existsSync(`${root}spec.json`)) {
  try {
    const text = await (await fetch(SPEC_URL, { headers: { Accept: "application/json" } })).text();
    JSON.parse(text); // fail here, not later, if the download was an error page
    writeFileSync(`${root}spec.json`, text);
  } catch (err) {
    console.error(`Could not download the Glasscubes swagger (${err?.cause?.code ?? err.message}). Save it manually:\n  curl -o spec.json ${SPEC_URL}`);
    process.exit(1);
  }
}
const spec = JSON.parse(readFileSync(`${root}spec.json`, "utf8"));
assert.equal(spec.swagger, "2.0", "the Glasscubes API document is Swagger 2.0");
assert.equal(spec.basePath, BASE_PATH);
// Swagger 2.0 definitions are JSON Schema draft-04; ajv-draft-04 is Ajv with that dialect.
const ajv = new Ajv04({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ id: "gc", definitions: spec.definitions });
// Inline response schemas (the bare arrays) refer to "#/definitions/..." relative to the swagger document.
const inline = (schema) => JSON.parse(JSON.stringify(schema).replaceAll('"#/definitions/', '"gc#/definitions/'));
// The definitions set no additionalProperties:false and mark almost nothing required, so Ajv alone would
// accept a fixture field the spec never defines. This walk reports every key the definition does not declare.
const resolveRef = (schema) => (schema?.$ref ? spec.definitions[schema.$ref.replace(/^(gc)?#\/definitions\//, "")] : schema);
const unknownKeys = (schema, value, path, out = []) => {
  const s = resolveRef(schema);
  if (!s || value === null || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    value.forEach((item, i) => unknownKeys(s.items, item, `${path}[${i}]`, out));
    return out;
  }
  if (s.type === "object" && !s.properties) return out; // free-form objects such as UserDto.customProperties
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined) continue;
    const prop = s.properties?.[k];
    if (!prop) out.push(`${path}.${k}`);
    else unknownKeys(prop, v, `${path}.${k}`, out);
  }
  return out;
};
const validateWith = (schema, obj, label) => {
  const v = typeof schema === "string" ? ajv.getSchema(`gc#/definitions/${schema}`) ?? ajv.compile({ $ref: `gc#/definitions/${schema}` }) : ajv.compile(inline(schema));
  assert.ok(v(obj), `${label}: ${ajv.errorsText(v.errors)}`);
  const unknown = unknownKeys(typeof schema === "string" ? { $ref: `#/definitions/${schema}` } : schema, obj, label);
  assert.deepEqual(unknown, [], `${label}: keys the spec does not declare: ${unknown.join(", ")}`);
};
const validate = (name, obj, id = "") => validateWith(name, obj, `${name} ${id}`);
const responseSchema = (path, method = "get") => spec.paths[path][method].responses["200"].schema;
// The spec publishes no schema for error bodies. This one is written from the API documentation page:
// "STATUS_CODE=400 is returned with a { 'errCode': xxx, 'errMsg': 'verbal description of error'} JSON error response".
const ERROR_SCHEMA = { type: "object", required: ["errCode", "errMsg"], properties: { errCode: { type: "integer" }, errMsg: { type: "string" } }, additionalProperties: false };

console.log("fixtures vs Swagger definitions");
await check("workspaces, labels, workspace details, members, information requests, templates, tasks, files and folders, calendar events", async () => {
  fx.workspaces.forEach((w) => validate("WorkspaceListItem", w, w.id));
  fx.labels.forEach((l) => validate("WorkspaceListLabel", l, l.name));
  Object.values(fx.workspaceDetails).forEach((w) => validate("WorkspaceInfoV3", w, w.id));
  Object.values(fx.members).flat().forEach((m, i) => validate("WorkspaceMemberInfo", m, i));
  fx.informationRequests.forEach((r) => validate("InformationRequestReadDto", r, r.id));
  [...fx.accountTemplates, ...Object.values(fx.workspaceTemplates).flat()].forEach((t) => validate("InformationRequestTemplateReadDto", t, t.id));
  Object.values(fx.tasks).forEach((t) => validate("TaskResponse", t, t.id));
  Object.values(fx.browse).flat().forEach((d, i) => validate("DiscItem", d, i));
  Object.values(fx.events).flat().forEach((e) => validate("EventInfo", e, e.id));
  // Negative controls, so a schema that accepted anything, or a key walk that saw nothing, would be noticed.
  const v = ajv.compile({ $ref: "gc#/definitions/InformationRequestReadDto" });
  assert.equal(v({ id: "seven", status: "Pending", createdDate: "yesterday" }), false, "the schema must reject a string id, an unknown status and a non-date-time");
  assert.deepEqual(unknownKeys({ $ref: "#/definitions/TaskResponse" }, { id: 1, priority: "high", createdBy: { id: 2, nickname: "x" } }, "t"), ["t.priority", "t.createdBy.nickname"]);
});

// 2. The mock's responses (lists, single records, token refresh, errors) match the documented schemas.
const { server: mock, port, requests, arm, disarm, revoke, state, setTokenLifetime } = await startMock();
const base = `http://127.0.0.1:${port}${BASE_PATH}`;
const raw = async (method, path, { token = ACCESS_TOKEN, ...init } = {}) => {
  const res = await fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) }, body: init.body });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
};
await check("mock responses match the documented response schemas; auth, refresh and errors follow the documented 400 {errCode, errMsg} convention", async () => {
  const ws = await raw("GET", "/v3/workspace-list/0/50");
  validateWith(responseSchema("/v3/workspace-list/{first}/{count}"), ws.json, "workspace list page");
  assert.equal(ws.json.length, 50);
  assert.equal((await raw("GET", "/v3/workspace-list/100/50")).json.length, 20, "a short page marks the end");
  validateWith(responseSchema("/v3/workspace-list/labels"), (await raw("GET", "/v3/workspace-list/labels")).json, "labels");
  validateWith(responseSchema("/v2/workspace/{id}"), (await raw("GET", `/v2/workspace/${fx.WS_SHAH}`)).json, "workspace");
  validateWith(responseSchema("/v2/workspace/{id}/members"), (await raw("GET", `/v2/workspace/${fx.WS_EVANS}/members`)).json, "members");
  validateWith(responseSchema("/v2/irequest/workspace/{id}"), (await raw("GET", `/v2/irequest/workspace/${fx.WS_EVANS}`)).json, "information requests");
  validateWith(responseSchema("/v2/irequest/{id}"), (await raw("GET", `/v2/irequest/${fx.IR_YEAR_END}`)).json, "information request");
  validateWith(responseSchema("/v2/irequest/templates"), (await raw("GET", `/v2/irequest/templates?workspaceId=${fx.WS_EVANS}`)).json, "templates");
  validateWith(responseSchema("/v2/task/my"), (await raw("GET", "/v2/task/my")).json, "my tasks");
  validateWith(responseSchema("/v2/task/workspace/{id}"), (await raw("GET", `/v2/task/workspace/${fx.WS_EVANS}?order=all`)).json, "workspace tasks");
  validateWith(responseSchema("/v2/task/{id}"), (await raw("GET", `/v2/task/${fx.TASK_CHASE}`)).json, "task");
  validateWith(responseSchema("/v2/file/browse/{wid}"), (await raw("GET", `/v2/file/browse/${fx.WS_EVANS}`)).json, "browse root");
  validateWith(responseSchema("/v2/file/browse/{wid}/{fid}"), (await raw("GET", `/v2/file/browse/${fx.WS_EVANS}/${fx.FOLDER_YEAR_END}`)).json, "browse folder");
  const evs = await raw("GET", `/v2/cal/get-events/${fx.WS_EVANS}/01-10-2026/31-10-2026`);
  validateWith(responseSchema("/v2/cal/get-events/{workspaceId}/{startDate}/{endDate}"), evs.json, "events");
  assert.deepEqual(evs.json.map((e) => e.id), [7001, 7002]);
  const badDate = await raw("GET", `/v2/cal/get-events/${fx.WS_EVANS}/2026-10-01/2026-10-31`);
  assert.equal(badDate.status, 400);
  validateWith(ERROR_SCHEMA, badDate.json, "bad date error");
  // Auth: no token or a wrong token -> the documented general error 121; unknown ID -> 120 "Item deleted".
  for (const token of [null, "gc-wrong-token-not-real"]) {
    const r = await raw("GET", "/v2/task/my", { token });
    assert.equal(r.status, 400);
    validateWith(ERROR_SCHEMA, r.json, "token error");
    assert.deepEqual(r.json, ERR_TOKEN);
  }
  const missing = await raw("GET", "/v2/irequest/1");
  assert.deepEqual([missing.status, missing.json], [400, ERR_DELETED]);
  // Writes: PUT /v2/task returns a TaskResponse; POST /v2/task/{id}/state has no documented body.
  const created = await raw("PUT", "/v2/task", { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Mock check", workspaceId: fx.WS_SHAH }) });
  validateWith(responseSchema("/v2/task", "put"), created.json, "created task");
  delete fx.tasks[created.json.id];
  const stateRes = await raw("POST", `/v2/task/3003/state?state=NEW`);
  assert.deepEqual(stateRes, { status: 200, json: undefined });
  // Token refresh: documented form fields in, TokenResponse out; a wrong refresh token gets errCode 104 (documented on that endpoint).
  const form = (refresh) => ({ token: null, headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: refresh }).toString() });
  const wrongRefresh = await raw("POST", REFRESH_PATH, form("gc-wrong-refresh-not-real"));
  assert.deepEqual([wrongRefresh.status, wrongRefresh.json], [400, ERR_REFRESH]);
  const doc = spec.paths[REFRESH_PATH].post;
  assert.deepEqual(doc.consumes, ["application/x-www-form-urlencoded"]);
  assert.deepEqual(doc.parameters.map((x) => `${x.in}:${x.name}`).sort(), ["formData:client_id", "formData:client_secret", "formData:refresh_token"], "refresh takes exactly these form fields and no Authorization header");
  assert.match(doc.description, /'errCode':104, 'errMsg':'Invalid refresh token'/);
});
requests.length = 0; // only count what the MCP server does from here on
// Glasscubes documents no 429. The injected ones carry the documented general error 118 with its documented text.
const ERR_APP = { errCode: 118, errMsg: "Application error sorry, please try again or contact us if the problem persists" };
arm({ method: "GET", path: `/v2/task/${fx.TASK_CHASE}`, status: 429, headers: { "Retry-After": "1" }, body: ERR_APP });

// 3. Drive the server through MCP. `writes` is the literal GLASSCUBES_ALLOW_WRITES value; null leaves it unset.
const connect = async ({ writes = "true", token = ACCESS_TOKEN, refresh = REFRESH_TOKEN } = {}) => {
  const client = new Client({ name: "e2e", version: "1.0.0" });
  const env = { ...process.env, GLASSCUBES_BASE_URL: base };
  for (const k of ["GLASSCUBES_ACCESS_TOKEN", "GLASSCUBES_REFRESH_TOKEN", "GLASSCUBES_CLIENT_ID", "GLASSCUBES_CLIENT_SECRET", "GLASSCUBES_ALLOW_WRITES"]) delete env[k];
  if (token) env.GLASSCUBES_ACCESS_TOKEN = token;
  if (refresh) Object.assign(env, { GLASSCUBES_REFRESH_TOKEN: refresh, GLASSCUBES_CLIENT_ID: CLIENT_ID, GLASSCUBES_CLIENT_SECRET: CLIENT_SECRET });
  if (writes !== null) env.GLASSCUBES_ALLOW_WRITES = writes;
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [`${root}dist/index.js`], env, stderr: "ignore" }));
  return client;
};
const call = async (client, name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return { res, data: res.isError ? undefined : JSON.parse(res.content[0].text), text: res.content[0].text };
};
const since = (n) => requests.slice(n);
let auditedCount = 0;
const READS = ["get_information_request", "get_task", "get_workspace", "list_calendar_events", "list_files", "list_information_requests", "list_request_templates", "list_tasks", "list_workspace_labels", "list_workspace_members", "list_workspaces"];
const WRITES = ["create_task", "set_task_state"];

const client = await connect();
console.log("mcp tools");

await check("tools/list exposes 11 read tools (read-only, non-destructive) and 2 write tools (create_task additive, set_task_state destructive and idempotent); no limit is attributed to the API that the spec does not document", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [...READS, ...WRITES].sort());
  for (const t of tools) {
    const write = WRITES.includes(t.name);
    assert.equal(t.annotations?.readOnlyHint, !write, `${t.name} readOnlyHint`);
    assert.equal(t.annotations?.destructiveHint, t.name === "set_task_state", `${t.name} destructiveHint`);
    if (write) assert.equal(t.annotations?.idempotentHint, t.name === "set_task_state", `${t.name} idempotentHint`);
  }
  // The spec states a 254/64000 length limit only for PUT /v2/post (errCode 125); the task limits are this server's own.
  assert.doesNotMatch(JSON.stringify(spec.paths["/v2/task"]), /254|64000|too long/i, "the spec states no length limit for tasks");
  assert.match(spec.paths["/v2/post"].put.description, /title>=254 or desc>=64000/, "the limit the server borrows is the post endpoint's");
  const create = tools.find((t) => t.name === "create_task");
  for (const field of ["title", "description"]) {
    const d = create.inputSchema.properties[field].description;
    assert.match(d, /this server's own limit; the API documents none for tasks/, `create_task ${field}`);
    assert.doesNotMatch(d, /the API refuses/, `create_task ${field}`);
  }
  assert.match(create.description, /day boundaries are taken in UTC/);
  assert.doesNotMatch(create.description, /following the API's note/);
  const irDescription = tools.find((t) => t.name === "list_information_requests").description;
  assert.match(irDescription, /WAITING presumably means/);
  assert.doesNotMatch(irDescription, /WAITING items are what/);
});

await check("list_workspaces pages first/count 0/50, 50/50, 100/50 (250 ms apart) and stops at the documented short page", async () => {
  const n = requests.length;
  const { data } = await call(client, "list_workspaces", { max_results: 1000 });
  assert.equal(data.count, 120);
  assert.equal(data.complete, true);
  assert.deepEqual(since(n).map((r) => r.path), ["/v3/workspace-list/0/50", "/v3/workspace-list/50/50", "/v3/workspace-list/100/50"]);
  const pages = since(n);
  // Measured when each request reaches the mock, so event-loop jitter on either side can shave a few milliseconds off a 250 ms gap.
  for (let i = 1; i < pages.length; i++) assert.ok(pages[i].t - pages[i - 1].t >= 220, `requests are spaced about 250 ms apart (gap ${pages[i].t - pages[i - 1].t} ms)`);
  assert.deepEqual(data.workspaces[0], { id: fx.WS_EVANS, name: "Evans Bakery Ltd", pinned: true, group: { id: fx.GROUP_YEAR_END, name: "Year-end clients" } });
  const part = await call(client, "list_workspaces", { max_results: 60 });
  assert.equal(part.data.count, 60);
  assert.equal(part.data.complete, false);
  assert.match(part.data.note, /first 60/);
  assert.deepEqual(requests.slice(-2).map((r) => r.path), ["/v3/workspace-list/0/50", "/v3/workspace-list/50/10"], "the last page asks only for what is still wanted");
  const next = await call(client, "list_workspaces", { first: 60, max_results: 1000 });
  assert.equal(next.data.count, 60);
  assert.equal(requests.at(-1).path, "/v3/workspace-list/110/50");
  // The summary's closed interval "[first, first+count]" would allow count+1 items in a page: the result still stops at max_results.
  arm({ method: "GET", path: "/v3/workspace-list/0/50", status: 200, body: () => fx.workspaces.slice(0, 51) });
  const over = await call(client, "list_workspaces", { max_results: 50 });
  assert.deepEqual([over.data.count, over.data.workspaces.length, over.data.complete], [50, 50, false]);
  assert.match(over.data.note, /first 50 to continue/);
  arm({ method: "GET", path: "/v3/workspace-list/10/5", status: 200, body: () => fx.workspaces.slice(10, 16) });
  const overFrom = await call(client, "list_workspaces", { first: 10, max_results: 5 });
  assert.deepEqual(overFrom.data.workspaces.map((w) => w.id), fx.workspaces.slice(10, 15).map((w) => w.id));
  assert.match(overFrom.data.note, /first 15 to continue/);
  // No disarm() here: both armed pages were used once, and the suite's initial 429 on GET /v2/task/3001 must stay armed.
});

await check("list_workspaces passes q, g and l through as documented query parameters", async () => {
  const byName = await call(client, "list_workspaces", { query: "evans" });
  assert.deepEqual(byName.data.workspaces.map((w) => w.id), [fx.WS_EVANS]);
  assert.deepEqual(requests.at(-1).query, { q: "evans" });
  const byGroup = await call(client, "list_workspaces", { group_id: String(fx.GROUP_YEAR_END) });
  assert.equal(byGroup.data.count, 41);
  assert.deepEqual(requests.at(-1).query, { g: "7" });
  const byLabel = await call(client, "list_workspaces", { label: "Payroll", query: "ltd" });
  assert.deepEqual(byLabel.data.workspaces.map((w) => w.id), [fx.WS_EVANS, 2003]);
  assert.deepEqual(requests.at(-1).query, { q: "ltd", l: "Payroll" });
});

await check("list_workspace_labels and get_workspace (public description redacted by default)", async () => {
  const labels = await call(client, "list_workspace_labels");
  assert.deepEqual(labels.data.labels, ["Payroll", "Self assessment", "Year end"]);
  const { data } = await call(client, "get_workspace", { workspace_id: String(fx.WS_SHAH) });
  assert.equal(data.workspace.permission, "WRITE");
  assert.deepEqual(data.workspace.modules, ["Files", "Tasks", "Information Requests"]);
  assert.equal(data.workspace.public_info.description, "Questions? Email [email redacted] or call [phone redacted].");
  const raw2 = await call(client, "get_workspace", { workspace_id: String(fx.WS_SHAH), include_contact_details: true });
  assert.equal(raw2.data.workspace.public_info.description, fx.workspaceDetails[fx.WS_SHAH].publicInfo.description);
});

await check("list_workspace_members returns names and companies; emails only on request; profile pictures never", async () => {
  const { data } = await call(client, "list_workspace_members", { workspace_id: String(fx.WS_EVANS) });
  assert.deepEqual(data.members.map((m) => [m.kind, m.name]), [["user", "Alex Example"], ["user", "Sam Evans"], ["group", "Tax team"]]);
  assert.equal(data.members[1].company, "Evans Bakery Ltd");
  assert.equal(data.members[2].member_count, 2);
  assert.ok(!data.members.some((m) => "email" in m));
  assert.ok(!JSON.stringify(data).includes("@example.com") && !JSON.stringify(data).includes("/p/"));
  const withEmail = await call(client, "list_workspace_members", { workspace_id: String(fx.WS_EVANS), include_contact_details: true });
  assert.equal(withEmail.data.members[1].email, "sam.evans@example.com");
  assert.ok(!JSON.stringify(withEmail.data).includes("/p/"), "profile picture URLs are never returned");
});

await check("list_information_requests: item status counts, recipient names, the statuses filter applied locally, contact data only on request", async () => {
  const { data } = await call(client, "list_information_requests", { workspace_id: String(fx.WS_EVANS) });
  assert.equal(data.total_in_workspace, 3);
  assert.deepEqual(data.status_counts_in_workspace, { Waiting: 1, Completed: 1, Overdue: 1 });
  const ye = data.requests[0];
  assert.deepEqual([ye.id, ye.status, ye.due, ye.items_total], [fx.IR_YEAR_END, "Waiting", "2026-10-31T23:59:00.000Z", 4]);
  assert.deepEqual(ye.item_status_counts, { WAITING: 2, COMPLETE: 1, AMEND: 1 });
  assert.deepEqual(ye.recipient, { name: "Sam Evans", user_id: 21, client_code: "EVA001" });
  assert.deepEqual(data.requests[2].recipient, { name: "Priya Shah", client_code: "SHA001" }, "a personal-tax request names the client from firstName/lastName");
  const text = JSON.stringify(data);
  assert.ok(!text.includes("@example.com") && !text.includes("public"), "no email or public link by default");
  const n = requests.length;
  const open = await call(client, "list_information_requests", { workspace_id: String(fx.WS_EVANS), statuses: ["Waiting", "Overdue"] });
  assert.deepEqual(open.data.requests.map((r) => r.id), [fx.IR_YEAR_END, fx.IR_TAX]);
  assert.deepEqual(since(n).map((r) => [r.path, r.query]), [[`/v2/irequest/workspace/${fx.WS_EVANS}`, {}]], "the endpoint takes no filter, so none is sent");
  const withContact = await call(client, "list_information_requests", { workspace_id: String(fx.WS_EVANS), include_contact_details: true });
  assert.equal(withContact.data.requests[0].recipient.email, "sam.evans@example.com");
  assert.equal(withContact.data.requests[2].recipient.email, "priya.shah@example.com");
  assert.equal(withContact.data.requests[0].public_url, "https://example.glasscubes.com/r/ir-5001-public");
  const capped = await call(client, "list_information_requests", { workspace_id: String(fx.WS_EVANS), max_results: 1 });
  assert.deepEqual([capped.data.count, capped.data.requests.length, capped.data.matching, capped.data.total_in_workspace], [1, 1, 3, 3]);
  assert.match(capped.data.note, /Only the first 1 of 3 matching requests are listed; raise max_results/);
  assert.equal(data.note, undefined, "no note when nothing was cut");
});

await check("get_information_request lists items with status and activity; emails, phones and postcodes redacted by default, card numbers always", async () => {
  const { data } = await call(client, "get_information_request", { request_id: String(fx.IR_YEAR_END) });
  const r = data.request;
  assert.equal(r.description, "Please upload everything by 31 October. Queries to [email redacted] or [phone redacted].");
  assert.deepEqual(r.items.map((i) => [i.id, i.status, i.file_count]), [[60011, "WAITING", 0], [60012, "COMPLETE", 2], [60013, "AMEND", 1], [60014, "WAITING", 0]]);
  assert.equal(r.items[2].name, "Payroll summary (ring [phone redacted] if unsure)");
  assert.deepEqual(r.items[2].update_counts, { RESPONSE: 1, QUERY: 1 });
  assert.equal(r.items[2].last_update, "2026-09-08T11:00:00.000Z");
  assert.equal(r.items[3].name, "Card used for business: [card number redacted]");
  assert.deepEqual(r.assignments, [{ id: 70011, name: "Sam Evans" }]);
  const text = JSON.stringify(data);
  assert.ok(!text.includes("@example.com") && !text.includes("07700") && !text.includes("public") && !text.includes("4111"));
  const tax = await call(client, "get_information_request", { request_id: String(fx.IR_TAX) });
  // Street addresses are not recognised (the README says so); the postcode is.
  assert.equal(tax.data.request.description, "Home address on file: 1 Plymouth Road, Penarth [postcode redacted].");
  assert.equal(tax.data.request.request_type, "PERSONAL_TAX");
  const withContact = await call(client, "get_information_request", { request_id: String(fx.IR_YEAR_END), include_contact_details: true });
  const w = withContact.data.request;
  assert.equal(w.description, fx.informationRequests[0].description);
  assert.equal(w.items[2].name, fx.informationRequests[0].items[2].itemName);
  assert.equal(w.items[3].name, "Card used for business: [card number redacted]", "card numbers are redacted even on request");
  assert.deepEqual([w.assignments[0].email, w.assignments[0].public_url], ["sam.evans@example.com", "https://example.glasscubes.com/r/as-70011-public"]);
});

await check("list_request_templates: account-wide without workspaceId, the workspace's with it", async () => {
  const all = await call(client, "list_request_templates");
  assert.deepEqual(all.data.templates.map((t) => t.name), ["Year-end accounts", "Self assessment"]);
  assert.deepEqual(requests.at(-1).query, {});
  const ws = await call(client, "list_request_templates", { workspace_id: String(fx.WS_EVANS) });
  assert.deepEqual(ws.data.templates, [{ id: 403, name: "Evans payroll month end", items: ["Timesheets", "Starters and leavers (send to [email redacted])"] }], "template text is always redacted (the tool has no include_contact_details)");
  assert.deepEqual(requests.at(-1).query, { workspaceId: String(fx.WS_EVANS) });
});

await check("list_tasks: my tasks, a workspace's tasks with order passed through; order without a workspace refused locally", async () => {
  const mine = await call(client, "list_tasks");
  assert.deepEqual(mine.data.tasks.map((t) => t.id), [3101, 3102, fx.TASK_CHASE]);
  assert.equal(requests.at(-1).path, "/v2/task/my");
  const ws = await call(client, "list_tasks", { workspace_id: String(fx.WS_EVANS), order: "all" });
  assert.deepEqual(ws.data.tasks.map((t) => [t.id, t.state]), [[fx.TASK_CHASE, "STARTED"], [3002, "NEW"], [3003, "NEW"]]);
  assert.deepEqual([requests.at(-1).path, requests.at(-1).query], [`/v2/task/workspace/${fx.WS_EVANS}`, { order: "all" }]);
  const noOrder = await call(client, "list_tasks", { workspace_id: String(fx.WS_EVANS) });
  assert.deepEqual(requests.at(-1).query, {}, "no order sent unless asked");
  assert.equal(noOrder.data.total, 3);
  assert.equal(noOrder.data.note, undefined);
  const capped = await call(client, "list_tasks", { workspace_id: String(fx.WS_EVANS), max_results: 2 });
  assert.deepEqual([capped.data.count, capped.data.tasks.length, capped.data.total], [2, 2, 3]);
  assert.deepEqual(capped.data.tasks.map((t) => t.id), [fx.TASK_CHASE, 3002]);
  assert.match(capped.data.note, /Only the first 2 of 3 tasks are listed; raise max_results/);
  const n = requests.length;
  const bad = await call(client, "list_tasks", { order: "todo" });
  assert.ok(bad.res.isError);
  assert.match(bad.text, /order only applies to a workspace's tasks/);
  assert.equal(requests.length, n);
});

await check("get_task (after a 429 retry that waits for Retry-After) returns assignees, labels, attachments and form submissions, with free text redacted", async () => {
  const n = requests.length;
  const { data } = await call(client, "get_task", { task_id: String(fx.TASK_CHASE) });
  const tries = since(n).filter((r) => r.path === `/v2/task/${fx.TASK_CHASE}`);
  assert.equal(tries.length, 2, "retried once after the 429");
  const gap = tries[1].t - tries[0].t;
  assert.ok(gap >= 1000 && gap < 1900, `retry should wait the Retry-After of 1 s, not the 2 s fallback (waited ${gap} ms)`);
  const t = data.task;
  assert.equal(t.description, "Sam said to text him on [phone redacted] or email [email redacted].");
  assert.deepEqual(t.assignees, [{ kind: "user", id: 12, name: "Jo Bloggs" }, { kind: "group", id: 31, name: "Tax team" }]);
  assert.deepEqual([t.labels, t.attachments, t.form_submissions.map((f) => f.form)], [["Year end"], [{ id: 9001, title: "Engagement letter 2026.pdf" }], ["Year-end checklist"]]);
  assert.equal(t.created_by, "Alex Example");
  const withContact = await call(client, "get_task", { task_id: String(fx.TASK_CHASE), include_contact_details: true });
  assert.equal(withContact.data.task.assignees[0].email, "jo.bloggs@example.com");
  assert.equal(withContact.data.task.description, fx.tasks[fx.TASK_CHASE].description);
});

await check("list_files lists folder and file metadata for the root and a folder; nothing is downloaded", async () => {
  const rootList = await call(client, "list_files", { workspace_id: String(fx.WS_EVANS) });
  assert.deepEqual(rootList.data.folders, [{ kind: "folder", id: fx.FOLDER_YEAR_END, name: "Year end 2026" }]);
  assert.deepEqual(rootList.data.files.map((f) => [f.id, f.title, f.labels]), [[9001, "Engagement letter 2026.pdf", ["Signed"]]]);
  const folder = await call(client, "list_files", { workspace_id: String(fx.WS_EVANS), folder_id: String(fx.FOLDER_YEAR_END) });
  assert.equal(requests.at(-1).path, `/v2/file/browse/${fx.WS_EVANS}/${fx.FOLDER_YEAR_END}`);
  assert.deepEqual(folder.data.files[0], { kind: "file", id: 9101, title: "Sales invoices Q1.pdf", version: 2, size_bytes: 102400, updated: "2026-09-10T16:00:00.000Z", updated_by: "Sam Evans", requested_by: "Jo Bloggs", labels: [] });
  assert.equal(folder.data.files[1].title, "Bank statement March (from [email redacted]).pdf");
  assert.ok(!requests.some((r) => /download|viewfile|preview|\/url$/.test(r.path)), "no download, preview or signed-URL endpoint is ever called");
});

await check("list_calendar_events sends dd-MM-yyyy dates, never returns video links or passwords, and hides attendee emails unless asked", async () => {
  const { data } = await call(client, "list_calendar_events", { workspace_id: String(fx.WS_EVANS), from: "2026-10-01", to: "2026-10-31" });
  assert.equal(requests.at(-1).path, `/v2/cal/get-events/${fx.WS_EVANS}/01-10-2026/31-10-2026`);
  assert.deepEqual(data.events.map((e) => [e.id, e.has_video_call]), [[7001, true], [7002, false]]);
  assert.ok(data.events.every((e) => !("location" in e)), "the location (often an address) only on request");
  assert.ok(!JSON.stringify(data).includes("Plymouth"));
  assert.equal(data.events[0].description, "Dial in on [phone redacted] if the video fails.");
  assert.deepEqual(data.events[0].attendees, [{ name: "Sam Evans", response: "YES" }, { name: "Jo Bloggs", response: "MAYBE" }]);
  const withContact = await call(client, "list_calendar_events", { workspace_id: String(fx.WS_EVANS), from: "2026-10-01", to: "2026-10-31", include_contact_details: true });
  assert.equal(withContact.data.events[0].attendees[0].email, "sam.evans@example.com");
  assert.equal(withContact.data.events[0].location, fx.events[fx.WS_EVANS][0].location);
  for (const text of [JSON.stringify(data), JSON.stringify(withContact.data)]) {
    for (const secret of [fx.FAKE_ZOOM_PASSWORD, "host-link-not-real", "join-link-not-real", "123-456-789"]) assert.ok(!text.includes(secret), `${secret} must never be returned`);
  }
  const n = requests.length;
  const backwards = await call(client, "list_calendar_events", { workspace_id: String(fx.WS_EVANS), from: "2026-10-31", to: "2026-10-01" });
  assert.match(backwards.text, /is after to/);
  const notADate = await call(client, "list_calendar_events", { workspace_id: String(fx.WS_EVANS), from: "2026-02-30", to: "2026-03-01" });
  assert.match(notADate.text, /Not a calendar date: 2026-02-30/);
  assert.equal(requests.length, n, "refused locally");
});


await check("the redaction patterns: international numbers with a bracketed area code, a trailing extension, lower-case postcodes and NI numbers are caught; ordinals, references and timestamps are not", async () => {
  const cases = [
    ["+1 (415) 555-2671", "[phone redacted]"],
    ["+44 (0)7700 900123", "[phone redacted]"],
    ["call 07700900123ext 4", "call [phone redacted]ext 4"],
    ["cf64 3dh", "[postcode redacted]"],
    ["Penarth CF64 3DH.", "Penarth [postcode redacted]."],
    ["NI QQ 12 34 56 C", "NI [NI number redacted]"],
    ["ni: ab123456d", "ni: [NI number redacted]"],
    ["VAT Q1 2nd reminder, Q4 1st payment", "VAT Q1 2nd reminder, Q4 1st payment"],
    ["YE-2026-0001 due 2026-10-31T23:59:00.000Z, ref 123456789012", "YE-2026-0001 due 2026-10-31T23:59:00.000Z, ref 123456789012"],
    // Not recognised, as the README says: street addresses, dates of birth, UTRs, sort codes and account numbers, amounts.
    ["1 Plymouth Road, DOB 14/03/1985, UTR 1234567890, sort 12-34-56 acc 12345678, £45,000 salary", "1 Plymouth Road, DOB 14/03/1985, UTR 1234567890, sort 12-34-56 acc 12345678, £45,000 salary"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(redactContacts(input, false), expected, input);
    assert.equal(redactContacts(input, true), input, `${input} is returned as is on request`);
  }
});

await check("names of workspaces, groups, modules and labels, and client codes, are redacted like any free text by default and returned on request", async () => {
  const CONTACT = " (sam.evans@example.com, 07700 900111, cf64 3dh, QQ 12 34 56 C)";
  const REDACTED = " ([email redacted], [phone redacted], [postcode redacted], [NI number redacted])";
  const saved = [];
  const poke = (obj, key) => {
    saved.push([obj, key, obj[key]]);
    obj[key] = obj[key] + CONTACT;
  };
  const listItem = fx.workspaces.find((w) => w.id === fx.WS_EVANS);
  poke(listItem, "name");
  poke(listItem.group, "name");
  poke(fx.labels[0], "name");
  const detail = fx.workspaceDetails[fx.WS_EVANS];
  saved.push([detail, "group", detail.group], [detail, "modules", detail.modules]);
  detail.group = { ...detail.group };
  detail.modules = detail.modules.map((m) => ({ ...m }));
  poke(detail, "name");
  poke(detail.group, "name");
  poke(detail.modules[0], "friendlyName");
  poke(fx.tasks[fx.TASK_CHASE].workspace, "name");
  poke(fx.tasks[fx.TASK_CHASE].labels[0], "name");
  const rootFile = fx.browse[fx.WS_EVANS][1].fileInfo;
  poke(rootFile.labels[0], "name");
  poke(fx.events[fx.WS_EVANS][0].workspace, "name");
  poke(fx.events[fx.WS_EVANS][1].labels[0], "name");
  poke(fx.informationRequests[0], "clientCode");
  try {
    const calls = [
      ["list_workspaces", { query: "evans" }, (d) => [d.workspaces[0].name, d.workspaces[0].group.name]],
      ["list_workspace_labels", {}, (d) => [d.labels[0]]],
      ["get_workspace", { workspace_id: String(fx.WS_EVANS) }, (d) => [d.workspace.name, d.workspace.group.name, d.workspace.modules[0]]],
      ["get_task", { task_id: String(fx.TASK_CHASE) }, (d) => [d.task.workspace.name, d.task.labels[0]]],
      ["list_tasks", { workspace_id: String(fx.WS_EVANS) }, (d) => [d.tasks[0].workspace.name, d.tasks[0].labels[0]]],
      ["list_files", { workspace_id: String(fx.WS_EVANS) }, (d) => [d.files[0].labels[0]]],
      ["list_calendar_events", { workspace_id: String(fx.WS_EVANS), from: "2026-10-01", to: "2026-10-31" }, (d) => [d.events[0].workspace.name, d.events[1].labels[0]]],
      ["get_information_request", { request_id: String(fx.IR_YEAR_END) }, (d) => [d.request.recipient.client_code]],
      ["list_information_requests", { workspace_id: String(fx.WS_EVANS) }, (d) => [d.requests[0].recipient.client_code]],
    ];
    for (const [tool, args, pick] of calls) {
      const plain = await call(client, tool, args);
      assert.ok(!plain.res.isError, `${tool}: ${plain.text}`);
      for (const v of pick(plain.data)) assert.ok(v.endsWith(REDACTED), `${tool} returned ${v}`);
      for (const leak of ["@example.com", "07700 900111", "cf64", "QQ 12"]) assert.ok(!plain.text.includes(leak), `${tool} leaked ${leak}`);
      const open = await call(client, tool, { ...args, include_contact_details: true });
      for (const v of pick(open.data)) assert.ok(v.endsWith(CONTACT), `${tool} with include_contact_details returned ${v}`);
    }
  } finally {
    for (const [obj, key, value] of saved.reverse()) obj[key] = value;
  }
  assert.equal(fx.workspaceDetails[fx.WS_EVANS].name, "Evans Bakery Ltd");
  assert.equal(fx.informationRequests[0].clientCode, "EVA001");
});

const taskRequest = spec.paths["/v2/task"].put.parameters.find((x) => x.in === "body").schema;
await check("create_task sends a body that validates against the spec's TaskRequest and returns the created task", async () => {
  const { data } = await call(client, "create_task", { title: "Chase Priya for P60", description: "Due before the tax return", workspace_id: String(fx.WS_EVANS), due_date: "2026-10-20", assignee_user_ids: ["12"], assignee_group_ids: ["31"] });
  const put = requests.at(-1);
  assert.deepEqual([put.method, put.path, put.contentType], ["PUT", "/v2/task", "application/json"]);
  validateWith(taskRequest, put.body, "PUT /v2/task body vs TaskRequest");
  assert.deepEqual(put.body, {
    title: "Chase Priya for P60", description: "Due before the tax return", startDate: "2026-10-20T00:00:00.000Z", endDate: "2026-10-20T23:59:59.000Z", workspaceId: fx.WS_EVANS,
    assignee: [{ id: 12, type: "USER" }, { id: 31, type: "GROUP" }],
  });
  assert.equal(data.result, "created");
  assert.equal(data.task.title, "Chase Priya for P60");
  assert.deepEqual(data.task.assignees.map((a) => a.name), ["Jo Bloggs", "Tax team"]);
  const myTask = await call(client, "create_task", { title: "Personal reminder" });
  assert.deepEqual(requests.at(-1).body, { title: "Personal reminder" }, "no workspaceId creates a My Task, as documented");
  validateWith(taskRequest, requests.at(-1).body, "minimal TaskRequest");
  assert.ok(!myTask.res.isError);
  const n = requests.length;
  const backwards = await call(client, "create_task", { title: "x", start_date: "2026-10-21", due_date: "2026-10-20" });
  assert.match(backwards.text, /Not created\. start_date .* is after due_date/);
  const startOnly = await call(client, "create_task", { title: "x", start_date: "2026-10-21" });
  assert.match(startOnly.text, /Give a due_date with start_date/);
  const tooLong = await client.callTool({ name: "create_task", arguments: { title: "x".repeat(254) } });
  assert.ok(tooLong.isError, "a 254-character title is refused by this server's own limit");
  assert.equal(requests.length, n, "refused locally, nothing sent");
  // 15-digit IDs (the most the server accepts) reach the body exactly.
  await call(client, "create_task", { title: "Big IDs", workspace_id: "123456789012345", assignee_user_ids: ["987654321098765"] });
  assert.equal(requests.at(-1).body.workspaceId, 123456789012345);
  assert.equal(requests.at(-1).body.assignee[0].id, 987654321098765);
  assert.ok(Number.isSafeInteger(requests.at(-1).body.workspaceId) && Number.isSafeInteger(requests.at(-1).body.assignee[0].id));
  // A 200 that does not carry the created task is reported as created, with a pointer to list_tasks, not as a failure.
  arm({ method: "PUT", path: "/v2/task", status: 200, body: () => undefined });
  const bare = await call(client, "create_task", { title: "Empty answer" });
  assert.ok(!bare.res.isError, bare.text);
  assert.equal(bare.data.result, "created");
  assert.match(bare.data.note, /did not return the created task as documented; check list_tasks/);
  disarm();
});

await check("set_task_state reads the task first (previous_state, for undoing), posts the state as a query parameter, then reads the task back", async () => {
  const n = requests.length;
  const { data } = await call(client, "set_task_state", { task_id: "3002", state: "COMPLETED" });
  assert.deepEqual(since(n).map((r) => [r.method, r.path, r.query, r.body]), [
    ["GET", "/v2/task/3002", {}, undefined],
    ["POST", "/v2/task/3002/state", { state: "COMPLETED" }, undefined],
    ["GET", "/v2/task/3002", {}, undefined],
  ]);
  assert.deepEqual([data.result, data.previous_state, data.requested_state, data.task.state], ["state changed", "NEW", "COMPLETED", "COMPLETED"]);
  const undo = await call(client, "set_task_state", { task_id: "3002", state: data.previous_state });
  assert.deepEqual([undo.data.previous_state, undo.data.task.state], ["COMPLETED", "NEW"], "previous_state puts the task back");
  const m = requests.length;
  for (const state of ["DONE", "completed"]) {
    const bad = await client.callTool({ name: "set_task_state", arguments: { task_id: "3002", state } });
    assert.ok(bad.isError, state);
  }
  assert.equal(requests.length, m);
  const unknown = await call(client, "set_task_state", { task_id: "1", state: "STARTED" });
  assert.match(unknown.text, /^Not found: \/v2\/task\/1\./);
  assert.ok(!requests.slice(m).some((r) => r.method === "POST"), "an unknown task is found missing before anything is changed");
});

await check("bad IDs are rejected before any API call; an unknown ID (errCode 120) gives a clear not-found message", async () => {
  const before = requests.length;
  for (const [tool, args] of [
    ["get_workspace", { workspace_id: "../v2/user" }],
    ["get_information_request", { request_id: "12a" }],
    ["get_task", { task_id: "0" }],
    ["list_files", { workspace_id: String(fx.WS_EVANS), folder_id: "1/2" }],
    ["list_calendar_events", { workspace_id: String(fx.WS_EVANS), from: "01-10-2026", to: "31-10-2026" }],
    ["create_task", { title: "x", assignee_user_ids: ["jo"] }],
    ["create_task", { title: "   " }],
    // 16 digits and more could lose precision as a JSON number, so they are refused.
    ["get_task", { task_id: "1234567890123456" }],
    ["create_task", { title: "x", workspace_id: "123456789012345678" }],
    ["create_task", { title: "x", assignee_user_ids: ["987654321098765432"] }],
    ["get_workspace", { workspace_id: "01001" }],
    ["get_workspace", { workspace_id: 1001 }],
    // Enums and bounds are checked before any request too.
    ["list_information_requests", { workspace_id: String(fx.WS_EVANS), statuses: ["Pending"] }],
    ["list_information_requests", { workspace_id: String(fx.WS_EVANS), statuses: ["waiting"] }],
    ["list_information_requests", { workspace_id: String(fx.WS_EVANS), statuses: [] }],
    ["list_tasks", { workspace_id: String(fx.WS_EVANS), order: "bogus" }],
    ["list_tasks", { max_results: 0 }],
    ["list_workspaces", { max_results: 1001 }],
    ["list_workspaces", { first: -1 }],
    ["list_workspaces", { query: "" }],
  ]) {
    const bad = await client.callTool({ name: tool, arguments: args });
    assert.ok(bad.isError, `${tool} should reject ${JSON.stringify(args)}`);
  }
  assert.equal(requests.length, before, "no request for invalid input");
  const missing = await call(client, "get_information_request", { request_id: "1" });
  assert.ok(missing.res.isError);
  assert.match(missing.text, /^Not found: \/v2\/irequest\/1\. Glasscubes reports it as missing or deleted; check the ID\. Glasscubes said: errCode 120, "Item deleted"\./);
  const missingWs = await call(client, "list_tasks", { workspace_id: "999" });
  assert.match(missingWs.text, /Not found: \/v2\/task\/workspace\/999/);
});

await check("an expired access token is refreshed once with the documented form POST (no Authorization header) and the request repeated; the new pair is used from then on", async () => {
  revoke(ACCESS_TOKEN);
  const n = requests.length;
  const { res, data } = await call(client, "get_workspace", { workspace_id: String(fx.WS_EVANS) });
  assert.ok(!res.isError, res.content[0].text);
  assert.equal(data.workspace.name, "Evans Bakery Ltd");
  const seq = since(n);
  assert.deepEqual(seq.map((r) => `${r.method} ${r.path}`), [`GET /v2/workspace/${fx.WS_EVANS}`, `POST ${REFRESH_PATH}`, `GET /v2/workspace/${fx.WS_EVANS}`]);
  assert.equal(seq[0].auth, `Bearer ${ACCESS_TOKEN}`);
  assert.equal(seq[1].auth, undefined, "the refresh operation declares no Authorization header");
  assert.equal(seq[1].contentType, "application/x-www-form-urlencoded");
  assert.deepEqual(seq[1].body, { client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: REFRESH_TOKEN });
  assert.equal(seq[2].auth, "Bearer gc-test-token-refreshed-1");
  await call(client, "list_workspace_labels");
  assert.equal(requests.at(-1).auth, "Bearer gc-test-token-refreshed-1");
  // The mock rotated the refresh token; a second expiry must be refreshed with the new one.
  revoke("gc-test-token-refreshed-1");
  const m = requests.length;
  const again = await call(client, "list_workspace_labels");
  assert.ok(!again.res.isError, again.text);
  const refresh2 = since(m).find((r) => r.path === REFRESH_PATH);
  assert.equal(refresh2.body.refresh_token, "gc-test-refresh-refreshed-1", "the rotated refresh token is used");
  assert.equal(state().refreshes, 2);
});

await check("Glasscubes error text is passed on redacted with tokens and secret scrubbed; access-denied, account and not-found codes get their own messages", async () => {
  arm({ method: "GET", path: "/v2/task/my", status: 400, body: (r) => ({ errCode: 118, errMsg: `Application error for ${r.auth} (support: help@example.com) ${CLIENT_SECRET} ${state().currentRefresh}` }) });
  const { res, text } = await call(client, "list_tasks");
  assert.ok(res.isError);
  assert.match(text, /Glasscubes refused GET \/v2\/task\/my \(400\)\. Glasscubes said: errCode 118, "Application error for Bearer \[redacted\] \(support: \[email redacted\]\) \[redacted\] \[redacted\]"/);
  assert.ok(!text.includes("gc-test-token") && !text.includes("gc-test-refresh") && !text.includes(CLIENT_SECRET), "access token, current refresh token and client secret are all scrubbed");
  disarm();
  // 116 "Access Denied" and an account-level code (110 "User disabled"), both from the documented general list.
  arm({ method: "GET", path: "/v2/task/my", status: 400, body: { errCode: 116, errMsg: "Access Denied" } });
  const denied = await call(client, "list_tasks");
  assert.match(denied.text, /Glasscubes refused GET \/v2\/task\/my: access denied \(400\)\. Glasscubes said: errCode 116, "Access Denied"\. The user behind the token may not be a member/);
  disarm();
  arm({ method: "GET", path: "/v2/task/my", status: 400, body: { errCode: 110, errMsg: "User disabled" } });
  const disabled = await call(client, "list_tasks");
  assert.match(disabled.text, /because of the account or user behind the token \(400\)\. Glasscubes said: errCode 110, "User disabled"\. An administrator/);
  disarm();
  for (const code of [100, 109, 111, 112, 113, 119]) {
    arm({ method: "GET", path: "/v2/task/my", status: 400, body: { errCode: code, errMsg: "x" } });
    assert.match((await call(client, "list_tasks")).text, /because of the account or user behind the token/, `errCode ${code}`);
  }
  for (const code of [133, 200]) {
    arm({ method: "GET", path: "/v2/task/my", status: 400, body: { errCode: code, errMsg: "x" } });
    assert.match((await call(client, "list_tasks")).text, /^Not found: \/v2\/task\/my\./, `errCode ${code}`);
  }
  arm({ method: "GET", path: "/v2/task/my", status: 404 });
  assert.match((await call(client, "list_tasks")).text, /^Not found: \/v2\/task\/my\./, "HTTP 404");
  disarm();
});

await check("a persistent 429 gives up after 3 attempts; a Retry-After above the 10 s cap gives up at once", async () => {
  arm({ method: "GET", path: "/v3/workspace-list/labels", status: 429, times: 3, headers: { "Retry-After": "0" }, body: ERR_APP });
  const n = requests.length;
  const persistent = await call(client, "list_workspace_labels");
  assert.ok(persistent.res.isError);
  assert.equal(since(n).length, 3);
  assert.match(persistent.text, /Glasscubes rate limit reached \(the limit is not documented\)/);
  disarm();
  arm({ method: "GET", path: "/v3/workspace-list/labels", status: 429, headers: { "Retry-After": "600" }, body: {} });
  const m = requests.length;
  const long = await call(client, "list_workspace_labels");
  assert.equal(since(m).length, 1);
  assert.match(long.text, /asked to wait 600 seconds before retrying GET \/v3\/workspace-list\/labels \(HTTP 429\)/);
  disarm();
});

await check("an HTTP-date, a fractional and a missing Retry-After are honoured (the last with the 2 s fallback)", async () => {
  // HTTP-dates have 1 s resolution, so aim at a whole second 4 to 5 s ahead: after the first request's
  // round trip the wait is 3.5 to 5 s, clearly apart from both "retry at once" and the 2 s fallback.
  arm({ method: "GET", path: "/v3/workspace-list/labels", status: 429, headers: { "Retry-After": new Date(Math.ceil((Date.now() + 4000) / 1000) * 1000).toUTCString() }, body: {} });
  let n = requests.length;
  assert.ok(!(await call(client, "list_workspace_labels")).res.isError);
  let tries = since(n);
  assert.equal(tries.length, 2);
  let gap = tries[1].t - tries[0].t;
  assert.ok(gap >= 3000 && gap < 5600, `waited ${gap} ms for an HTTP-date 4 to 5 s ahead`);
  arm({ method: "GET", path: "/v3/workspace-list/labels", status: 429, headers: { "Retry-After": "1.5" }, body: {} });
  n = requests.length;
  assert.ok(!(await call(client, "list_workspace_labels")).res.isError);
  tries = since(n);
  gap = tries[1].t - tries[0].t;
  assert.ok(gap >= 1400 && gap < 1900, `retry should wait 1.5 s (waited ${gap} ms)`);
  arm({ method: "GET", path: "/v3/workspace-list/labels", status: 429, body: {} }); // no Retry-After header
  n = requests.length;
  assert.ok(!(await call(client, "list_workspace_labels")).res.isError);
  tries = since(n);
  gap = tries[1].t - tries[0].t;
  assert.ok(gap >= 1900 && gap < 2600, `without Retry-After the first retry waits 2 s (waited ${gap} ms)`);
  disarm();
});

await check("a 502 on a GET is retried, and gives up after 3 in a row; a 429 on PUT /v2/task is retried once; a 502 on PUT /v2/task or a 503 on POST .../state is never retried and says to check first", async () => {
  arm({ method: "GET", path: "/v3/workspace-list/labels", status: 502, headers: { "Retry-After": "0" } });
  let n = requests.length;
  assert.ok(!(await call(client, "list_workspace_labels")).res.isError);
  assert.equal(since(n).length, 2);
  arm({ method: "GET", path: "/v3/workspace-list/labels", status: 502, times: 3, headers: { "Retry-After": "0" } });
  n = requests.length;
  const down = await call(client, "list_workspace_labels");
  assert.ok(down.res.isError);
  assert.equal(since(n).length, 3);
  assert.match(down.text, /^Glasscubes returned 502 for GET \/v3\/workspace-list\/labels 3 times in a row\. The service may be unavailable/);
  assert.ok(!down.text.includes("<html>"));
  arm({ method: "PUT", path: "/v2/task", status: 429, headers: { "Retry-After": "0" }, body: {} });
  n = requests.length;
  const limited = await call(client, "create_task", { title: "Rate-limited once" });
  assert.ok(!limited.res.isError, limited.text);
  assert.equal(since(n).filter((r) => r.method === "PUT").length, 2, "a 429 on PUT is retried once (a rate-limited request is assumed not processed)");
  arm({ method: "PUT", path: "/v2/task", status: 502, headers: { "Retry-After": "0" } });
  n = requests.length;
  const put = await call(client, "create_task", { title: "Gateway test" });
  assert.ok(put.res.isError);
  assert.equal(since(n).filter((r) => r.method === "PUT").length, 1, "exactly one PUT");
  assert.match(put.text, /returned 502 for PUT \/v2\/task\. The request was not retried because it may already have been processed: check with list_tasks/);
  assert.ok(!put.text.includes("<html>"));
  arm({ method: "POST", path: "/v2/task/3003/state", status: 503 });
  n = requests.length;
  const st = await call(client, "set_task_state", { task_id: "3003", state: "STARTED" });
  assert.ok(st.res.isError);
  assert.deepEqual(since(n).map((r) => r.method), ["GET", "POST"], "the task is read first; the POST is sent once");
  assert.match(st.text, /returned 503 for POST \/v2\/task\/3003\/state\. The request was not retried/);
  disarm();
});

await check("a 200 whose body is not JSON, is empty, or is JSON of the wrong shape is an error that says the result is unknown, never an empty list", async () => {
  arm({ method: "GET", path: `/v2/irequest/workspace/${fx.WS_EVANS}`, status: 200 });
  const { res, text } = await call(client, "list_information_requests", { workspace_id: String(fx.WS_EVANS) });
  assert.ok(res.isError);
  assert.match(text, /returned 200 for GET \/v2\/irequest\/workspace\/1001 but the body was not JSON \(text\/html, \d+ bytes\)\. Check GLASSCUBES_BASE_URL/);
  // body () => undefined makes the mock answer 200 with an empty body.
  const cases = [
    ["list_information_requests", { workspace_id: String(fx.WS_EVANS) }, `/v2/irequest/workspace/${fx.WS_EVANS}`, () => undefined, /with an empty body, where the API documents data\. The result is unknown, not empty/],
    ["list_information_requests", { workspace_id: String(fx.WS_EVANS) }, `/v2/irequest/workspace/${fx.WS_EVANS}`, null, /but the body was null, not a list as the API documents\. The result is unknown, not empty/],
    ["list_workspaces", {}, "/v3/workspace-list/0/50", null, /but the body was null, not a list/],
    ["list_workspaces", {}, "/v3/workspace-list/0/50", { items: [] }, /but the body was an object with keys \[items\], not a list/],
    ["list_tasks", {}, "/v2/task/my", { tasks: [] }, /not a list/],
    ["list_workspace_labels", {}, "/v3/workspace-list/labels", () => undefined, /with an empty body/],
    ["list_workspace_members", { workspace_id: String(fx.WS_EVANS) }, `/v2/workspace/${fx.WS_EVANS}/members`, null, /not a list/],
    ["list_files", { workspace_id: String(fx.WS_EVANS) }, `/v2/file/browse/${fx.WS_EVANS}`, {}, /not a list/],
    ["list_calendar_events", { workspace_id: String(fx.WS_EVANS), from: "2026-10-01", to: "2026-10-31" }, `/v2/cal/get-events/${fx.WS_EVANS}/01-10-2026/31-10-2026`, null, /not a list/],
    ["list_request_templates", {}, "/v2/irequest/templates", "none", /but the body was a string, not a list/],
    ["get_information_request", { request_id: String(fx.IR_YEAR_END) }, `/v2/irequest/${fx.IR_YEAR_END}`, () => undefined, /with an empty body/],
    ["get_information_request", { request_id: String(fx.IR_YEAR_END) }, `/v2/irequest/${fx.IR_YEAR_END}`, null, /but the body was null, not a record as the API documents\. The result is unknown, not empty: check the ID/],
    ["get_workspace", { workspace_id: String(fx.WS_EVANS) }, `/v2/workspace/${fx.WS_EVANS}`, {}, /but the body was an empty object, not a record/],
    ["get_workspace", { workspace_id: String(fx.WS_EVANS) }, `/v2/workspace/${fx.WS_EVANS}`, [], /but the body was a list, not a record/],
    ["get_task", { task_id: String(fx.TASK_CHASE) }, `/v2/task/${fx.TASK_CHASE}`, () => undefined, /with an empty body/],
  ];
  for (const [tool, args, path, body, message] of cases) {
    arm({ method: "GET", path, status: 200, body });
    const r = await call(client, tool, args);
    assert.ok(r.res.isError, `${tool} with a 200 body of ${typeof body === "function" ? "nothing" : JSON.stringify(body)} must be an error, got ${r.text}`);
    assert.match(r.text, message, tool);
    disarm();
  }
});

await client.close();

await check("writes are off when GLASSCUBES_ALLOW_WRITES is unset, and when it is 'false'", async () => {
  for (const value of [null, "false"]) {
    const ro = await connect({ writes: value, token: "gc-test-token-refreshed-2", refresh: null });
    const { tools } = await ro.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), READS, `GLASSCUBES_ALLOW_WRITES ${value === null ? "unset" : `= "${value}"`}`);
    await ro.close();
  }
});

await check("a wrong access token (errCode 121 or 115, or an undocumented 401) and a wrong refresh token give actionable errors; a pasted Bearer prefix is stripped", async () => {
  const bad = await connect({ token: "gc-wrong-token-not-real", refresh: null });
  const r1 = await call(bad, "list_workspace_labels");
  assert.ok(r1.res.isError);
  assert.match(r1.text, /Glasscubes rejected the access token \(400\)\. Glasscubes said: errCode 121, "OAuth problem, possible reason missing or not correct oauth parameter"\. Check GLASSCUBES_ACCESS_TOKEN: access tokens are valid for 24 hours/);
  assert.ok(!r1.text.includes("gc-wrong-token-not-real"));
  arm({ method: "GET", path: "/v3/workspace-list/labels", status: 401, body: {} });
  const r401 = await call(bad, "list_workspace_labels");
  assert.match(r401.text, /Glasscubes rejected the access token \(401\)/);
  arm({ method: "GET", path: "/v3/workspace-list/labels", status: 400, body: { errCode: 115, errMsg: "Unauthorised access" } });
  assert.match((await call(bad, "list_workspace_labels")).text, /Glasscubes rejected the access token \(400\)\. Glasscubes said: errCode 115/);
  disarm();
  await bad.close();
  const prefixed = await connect({ token: `Bearer gc-test-token-refreshed-${state().refreshes}`, refresh: null });
  const p = await call(prefixed, "list_workspace_labels");
  assert.ok(!p.res.isError, p.text);
  assert.equal(requests.at(-1).auth, `Bearer gc-test-token-refreshed-${state().refreshes}`, "a pasted Bearer prefix is not doubled");
  await prefixed.close();
  const badRefresh = await connect({ token: "gc-wrong-token-not-real", refresh: "gc-wrong-refresh-not-real" });
  const n = requests.length;
  const r2 = await call(badRefresh, "list_workspace_labels");
  assert.ok(r2.res.isError);
  assert.deepEqual(since(n).map((r) => r.path), ["/v3/workspace-list/labels", REFRESH_PATH]);
  assert.match(r2.text, /Glasscubes refused to refresh the access token \(400\)\. Glasscubes said: errCode 104, "Invalid refresh token"\. Check GLASSCUBES_REFRESH_TOKEN/);
  assert.ok(!r2.text.includes("gc-wrong-refresh-not-real") && !r2.text.includes(CLIENT_SECRET));
  await badRefresh.close();
});

await check("with only a refresh token configured, the first call refreshes before calling the API; a refresh that hits a 502 is not retried", async () => {
  const onlyRefresh = await connect({ token: null, refresh: state().currentRefresh });
  arm({ method: "POST", path: REFRESH_PATH, status: 502, headers: { "Retry-After": "0" } });
  const g = requests.length;
  const gw = await call(onlyRefresh, "list_workspace_labels");
  assert.ok(gw.res.isError);
  assert.deepEqual(since(g).map((r) => r.path), [REFRESH_PATH], "the refresh POST is not retried after a gateway error");
  assert.match(gw.text, /Glasscubes returned 502 when refreshing the access token\. The refresh was not retried/);
  disarm();
  const n = requests.length;
  const { res } = await call(onlyRefresh, "list_workspace_labels");
  assert.ok(!res.isError, res.content[0].text);
  const seq = since(n);
  assert.deepEqual(seq.map((r) => `${r.method} ${r.path}`), [`POST ${REFRESH_PATH}`, "GET /v3/workspace-list/labels"]);
  assert.equal(seq[1].auth, `Bearer gc-test-token-refreshed-${state().refreshes}`);
  await onlyRefresh.close();
});

await check("refresh: a token is renewed early, before the expiresIn a refresh returned; simultaneous calls share one refresh; a token rejected again after refreshing is not refreshed a second time", async () => {
  // Early refresh: expiresIn 2 s means the server refreshes after 1 s (halfway through a lifetime under two minutes).
  setTokenLifetime(2);
  const c = await connect({ token: null, refresh: state().currentRefresh });
  let n = requests.length;
  assert.ok(!(await call(c, "list_workspace_labels")).res.isError);
  const firstToken = `gc-test-token-refreshed-${state().refreshes}`;
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok(state().validTokens.includes(firstToken), "the mock still accepts the first token");
  assert.ok(!(await call(c, "list_workspace_labels")).res.isError);
  assert.deepEqual(since(n).map((r) => `${r.method} ${r.path}`), [`POST ${REFRESH_PATH}`, "GET /v3/workspace-list/labels", `POST ${REFRESH_PATH}`, "GET /v3/workspace-list/labels"], "refreshed ahead of expiry, without waiting for a rejection");
  assert.equal(since(n)[3].auth, `Bearer gc-test-token-refreshed-${state().refreshes}`);
  setTokenLifetime(86400);
  // Three calls at once with a token that has stopped working: one refresh, all three repeated with the new token.
  assert.ok(!(await call(c, "list_workspace_labels")).res.isError); // refresh to a long-lived token first
  revoke(`gc-test-token-refreshed-${state().refreshes}`);
  const before = state().refreshes;
  n = requests.length;
  const results = await Promise.all([call(c, "list_workspace_labels"), call(c, "list_tasks"), call(c, "get_workspace", { workspace_id: String(fx.WS_EVANS) })]);
  for (const r of results) assert.ok(!r.res.isError, r.text);
  assert.equal(since(n).filter((r) => r.path === REFRESH_PATH).length, 1, "one refresh shared by the three calls");
  assert.equal(state().refreshes, before + 1);
  assert.equal(since(n).filter((r) => r.path !== REFRESH_PATH).length, 6, "each call sent once with the old token and once with the new");
  // Rejected again after the refresh: give up with a clear message instead of refreshing in a loop.
  arm({ method: "GET", path: "/v3/workspace-list/labels", status: 401, times: 2, body: {} });
  n = requests.length;
  const again = await call(c, "list_workspace_labels");
  assert.ok(again.res.isError);
  assert.deepEqual(since(n).map((r) => `${r.method} ${r.path}`), ["GET /v3/workspace-list/labels", `POST ${REFRESH_PATH}`, "GET /v3/workspace-list/labels"]);
  assert.match(again.text, /^Glasscubes rejected the access token \(401\) even after refreshing it\. .*Check that the user behind GLASSCUBES_REFRESH_TOKEN still has access/);
  disarm();
  await c.close();
});

await check("every request of the whole run went under /rest, used Bearer auth with a token the mock issued (or the deliberately wrong one of the wrong-token checks; none on the refresh), and matched a documented method+path", async () => {
  const templates = Object.entries(spec.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => ({ m: m.toUpperCase(), re: new RegExp("^" + p.replace(/\{[^}]+\}/g, "[^/]+") + "$") })));
  const issued = [ACCESS_TOKEN, ...Array.from({ length: state().refreshes }, (_, i) => `gc-test-token-refreshed-${i + 1}`)].map((t) => `Bearer ${t}`);
  const wrong = "Bearer gc-wrong-token-not-real";
  assert.ok(requests.length > 40);
  for (const r of requests) {
    assert.ok(r.basePathOk, `${r.path} not under ${BASE_PATH}`);
    if (r.path === REFRESH_PATH) assert.equal(r.auth, undefined);
    else assert.ok(issued.includes(r.auth) || r.auth === wrong, `${r.method} ${r.path} sent ${r.auth}`);
    assert.ok(templates.some((t) => t.m === r.method && t.re.test(r.path)), `undocumented call ${r.method} ${r.path}`);
  }
  const used = new Set(requests.map((r) => `${r.method} ${r.path.replace(/\/\d{2}-\d{2}-\d{4}/g, "/{date}").replace(/\/\d+(?=\/|$)/g, "/{id}")}`));
  assert.deepEqual([...used].sort(), [
    "GET /v2/cal/get-events/{id}/{date}/{date}", "GET /v2/file/browse/{id}", "GET /v2/file/browse/{id}/{id}", "GET /v2/irequest/templates", "GET /v2/irequest/workspace/{id}", "GET /v2/irequest/{id}",
    "GET /v2/task/my", "GET /v2/task/workspace/{id}", "GET /v2/task/{id}", "GET /v2/workspace/{id}", "GET /v2/workspace/{id}/members", "GET /v3/workspace-list/labels", "GET /v3/workspace-list/{id}/{id}",
    "POST /v2/auth/refresh", "POST /v2/task/{id}/state", "PUT /v2/task",
  ]);
  assert.ok(!requests.some((r) => /\/auth\/(\{cid\}\/|\d+\/)?passwd/.test(r.path)), "the email/password route is never used");
  auditedCount = requests.length;
});
assert.equal(auditedCount, requests.length, "the audit saw every request of the run");
mock.close();
console.log(`\n${passed} checks passed, ${requests.length} API calls made against the mock, ${((Date.now() - started) / 1000).toFixed(1)} s.`);
