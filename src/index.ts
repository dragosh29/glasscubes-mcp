#!/usr/bin/env node
// Glasscubes MCP server: lets Claude, ChatGPT and other MCP clients work with a Glasscubes client portal.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { GlasscubesClient, GlasscubesError } from "./client.js";
import * as fmt from "./format.js";

const env = (name: string) => process.env[name]?.trim() || undefined;
const accessToken = env("GLASSCUBES_ACCESS_TOKEN");
const refreshToken = env("GLASSCUBES_REFRESH_TOKEN");
const clientId = env("GLASSCUBES_CLIENT_ID");
const clientSecret = env("GLASSCUBES_CLIENT_SECRET");
if (refreshToken && !(clientId && clientSecret)) {
  console.error("GLASSCUBES_REFRESH_TOKEN needs GLASSCUBES_CLIENT_ID and GLASSCUBES_CLIENT_SECRET (the pair Glasscubes issued for your application): POST /v2/auth/refresh takes all three.");
  process.exit(1);
}
const allowWrites = /^(1|true|yes)$/i.test(process.env.GLASSCUBES_ALLOW_WRITES ?? "");
let api: GlasscubesClient;
try {
  api = new GlasscubesClient({ accessToken, refreshToken, clientId, clientSecret, baseUrl: env("GLASSCUBES_BASE_URL") });
} catch (err) {
  console.error((err as Error).message + " Glasscubes issues the client ID and secret on request; see the README for how tokens are obtained.");
  process.exit(1);
}

const server = new McpServer(
  { name: "glasscubes", version: "0.1.0" },
  {
    instructions: [
      "Tools for a Glasscubes client portal (workspaces, information requests, tasks, file metadata, members, calendar events). Every call acts as the user whose token is configured and sees what that user can see.",
      "IDs are numbers (workspace, information request, task, folder, user and group IDs).",
      "Typical flow for 'which clients still owe us documents?': list_workspaces (a practice usually has one workspace per client), then list_information_requests for a workspace, then get_information_request to see each item's status (WAITING presumably means the client has not provided it yet; the API does not document what the statuses mean).",
      "Information request statuses: Error, IsDraft, OnHold, Waiting, Delivered, Opened, InProgress, Updated, Overdue, Submitted, Verified, Prepared, Completed. Item statuses: WAITING, COMPLETE, DELEGETED, AMEND, RESUBMITED, VERIFIED, DECLINED (spelled as the API spells them).",
      "Recipient and member email addresses, event locations, and the links into a client's view of a request, are only returned when explicitly requested with include_contact_details; emails, phone numbers, postcodes and NI numbers in names and free text are redacted until then. Files are never downloaded; only their metadata is listed.",
    ].join("\n"),
  },
);

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;

// Every ID in the spec's paths is typed integer/int64. Digits only, so nothing but a number can
// reach a path segment, and at most 15 of them: every such ID is below 2^53, so the Number() that
// create_task applies to workspace and assignee IDs (the TaskRequest body wants integers), and the
// JSON numbers the API returns, stay exact.
const numericId = (what: string) => z.string().regex(/^[1-9]\d{0,14}$/, `${what} IDs are positive whole numbers of up to 15 digits, e.g. 1001`);
const includeContact = z
  .boolean()
  .default(false)
  .describe("Include email addresses, event locations and the links into a client's view of a request, and stop redacting emails, phone numbers, postcodes and NI numbers from names, labels and other free text");

const REQUEST_STATUSES = ["Error", "IsDraft", "OnHold", "Waiting", "Delivered", "Opened", "InProgress", "Updated", "Overdue", "Submitted", "Verified", "Prepared", "Completed"] as const;

type Json = Record<string, unknown> | unknown[];
const ok = (data: Json) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (err: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: err instanceof GlasscubesError ? err.message : `Unexpected error: ${(err as Error)?.message ?? String(err)}` }],
});
const safe = <A>(fn: (args: A) => Promise<Json>) => async (args: A) => {
  try {
    return ok(await fn(args));
  } catch (err) {
    return fail(err);
  }
};

server.registerTool(
  "list_workspaces",
  {
    title: "List workspaces",
    description:
      "The current user's workspaces (a practice usually keeps one per client), with their group and whether they are pinned. Pages through the API 50 at a time until it returns a short page, which the API documents as the end of the list. q, group_id and label are passed through as the API's q, g and l parameters; the spec does not describe them further.",
    inputSchema: {
      query: z.string().min(1).max(200).optional().describe("Passed as the API's q parameter (undocumented; presumably a name search)"),
      group_id: numericId("Group").optional().describe("Passed as the API's g parameter (undocumented; presumably a workspace group ID)"),
      label: z.string().min(1).max(200).optional().describe("Passed as the API's l parameter (undocumented; presumably a workspace label from list_workspace_labels)"),
      max_results: z.number().int().min(1).max(1000).default(200),
      first: z.number().int().min(0).default(0).describe("Index of the first workspace (0-based), for continuing a previous call"),
      include_contact_details: includeContact,
    },
    annotations: READ,
  },
  safe(async ({ query, group_id, label, max_results, first, include_contact_details }) => {
    const r = await api.listWorkspaces({ first, maxItems: max_results, query: { q: query, g: group_id, l: label } });
    return {
      count: r.items.length,
      first,
      complete: r.complete,
      note: r.complete ? undefined : `More workspaces may exist; call again with first ${r.next_first} to continue.`,
      workspaces: r.items.map((w) => fmt.workspaceListItem(w, include_contact_details)),
    };
  }),
);

server.registerTool(
  "list_workspace_labels",
  {
    title: "List workspace labels",
    description:
      "Labels applied to the workspaces the current user can access, sorted alphabetically (as documented). A label containing an email, phone number, postcode or NI number is redacted unless include_contact_details is set; use the unredacted name for list_workspaces' label filter.",
    inputSchema: { include_contact_details: includeContact },
    annotations: READ,
  },
  safe(async ({ include_contact_details }) => ({ labels: fmt.labelNames(await api.getList("/v3/workspace-list/labels"), include_contact_details) })),
);

server.registerTool(
  "get_workspace",
  {
    title: "Get workspace",
    description: "One workspace: name, the current user's permission (READ, COMMENTER, WRITE, OWNERSHIP), enabled modules, group and public page details.",
    inputSchema: { workspace_id: numericId("Workspace").describe("Workspace ID"), include_contact_details: includeContact },
    annotations: READ,
  },
  safe(async ({ workspace_id, include_contact_details }) => ({ workspace: fmt.workspace(await api.getObject(`/v2/workspace/${workspace_id}`), include_contact_details) })),
);

server.registerTool(
  "list_workspace_members",
  {
    title: "List workspace members",
    description: "Members of one workspace (users and user groups) with their names, company and active status. Email addresses only with include_contact_details.",
    inputSchema: { workspace_id: numericId("Workspace").describe("Workspace ID"), include_contact_details: includeContact },
    annotations: READ,
  },
  safe(async ({ workspace_id, include_contact_details }) => {
    const members = (await api.getList(`/v2/workspace/${workspace_id}/members`)).map((m) => fmt.member(m, include_contact_details));
    return { count: members.length, members };
  }),
);

server.registerTool(
  "list_information_requests",
  {
    title: "List information requests",
    description:
      "Information requests (document requests sent to clients) in one workspace: subject, status, due date, recipient name, and how many items are in each item status (WAITING presumably means the client has not provided the item yet; the API lists the statuses without saying what they mean). The statuses filter is applied by this server after fetching, because the API endpoint takes no filter.",
    inputSchema: {
      workspace_id: numericId("Workspace").describe("Workspace ID"),
      statuses: z.array(z.enum(REQUEST_STATUSES)).min(1).optional().describe("Only requests with one of these statuses (filtered locally)"),
      max_results: z.number().int().min(1).max(1000).default(200),
      include_contact_details: includeContact,
    },
    annotations: READ,
  },
  safe(async ({ workspace_id, statuses, max_results, include_contact_details }) => {
    const all = await api.getList(`/v2/irequest/workspace/${workspace_id}`);
    const wanted = statuses ? new Set<string>(statuses) : undefined;
    const matching = all.filter((r) => !wanted || wanted.has(r?.status));
    const requests = matching.slice(0, max_results).map((r) => fmt.informationRequestSummary(r, include_contact_details));
    const byStatus: Record<string, number> = {};
    for (const r of all) byStatus[r?.status ?? "unknown"] = (byStatus[r?.status ?? "unknown"] ?? 0) + 1;
    return {
      total_in_workspace: all.length,
      status_counts_in_workspace: byStatus,
      matching: matching.length,
      count: requests.length,
      note: matching.length > requests.length ? `Only the first ${requests.length} of ${matching.length} matching requests are listed; raise max_results.` : undefined,
      requests,
    };
  }),
);

server.registerTool(
  "get_information_request",
  {
    title: "Get information request",
    description: "One information request with every item (name, status, number of files provided, queries/responses/notes on it) and its assignments. Files are not downloaded.",
    inputSchema: { request_id: numericId("Information request").describe("Information request ID"), include_contact_details: includeContact },
    annotations: READ,
  },
  safe(async ({ request_id, include_contact_details }) => ({ request: fmt.informationRequestDetail(await api.getObject(`/v2/irequest/${request_id}`), include_contact_details) })),
);

server.registerTool(
  "list_request_templates",
  {
    title: "List information request templates",
    description: "Information request templates with their item names: account-wide templates, or with workspace_id the templates within that workspace (as documented).",
    inputSchema: { workspace_id: numericId("Workspace").optional().describe("Passed as the API's workspaceId query parameter") },
    annotations: READ,
  },
  safe(async ({ workspace_id }) => {
    const templates = (await api.getList("/v2/irequest/templates", { workspaceId: workspace_id })).map(fmt.requestTemplate);
    return { count: templates.length, templates };
  }),
);

server.registerTool(
  "list_tasks",
  {
    title: "List tasks",
    description:
      "Without workspace_id: the current user's My Tasks that are not completed (GET /v2/task/my). With workspace_id: the workspace's tasks; the API documents that it returns tasks that are not completed, with an order parameter of 'todo' (its default), 'all' or 'custom'.",
    inputSchema: {
      workspace_id: numericId("Workspace").optional().describe("Workspace ID; omit for the current user's own tasks"),
      order: z.enum(["todo", "all", "custom"]).optional().describe("Passed as the API's order parameter; only with workspace_id"),
      max_results: z.number().int().min(1).max(1000).default(200),
      include_contact_details: includeContact,
    },
    annotations: READ,
  },
  safe(async ({ workspace_id, order, max_results, include_contact_details }) => {
    if (order && !workspace_id) throw new GlasscubesError("order only applies to a workspace's tasks: give workspace_id as well, or leave order out for your own tasks.");
    const all = workspace_id ? await api.getList(`/v2/task/workspace/${workspace_id}`, { order }) : await api.getList("/v2/task/my");
    const tasks = all.slice(0, max_results).map((t) => fmt.task(t, include_contact_details));
    return { total: all.length, count: tasks.length, note: all.length > tasks.length ? `Only the first ${tasks.length} of ${all.length} tasks are listed; raise max_results.` : undefined, tasks };
  }),
);

server.registerTool(
  "get_task",
  {
    title: "Get task",
    description: "One task with its state (NEW, STARTED, COMPLETED), dates, assignees, labels, attachment titles and form submissions.",
    inputSchema: { task_id: numericId("Task").describe("Task ID"), include_contact_details: includeContact },
    annotations: READ,
  },
  safe(async ({ task_id, include_contact_details }) => ({ task: fmt.task(await api.getObject(`/v2/task/${task_id}`), include_contact_details) })),
);

server.registerTool(
  "list_files",
  {
    title: "List files and folders",
    description: "Files and folders in a workspace's root, or in one folder with folder_id: titles, versions, sizes, who last updated them and labels. Metadata only; this server never downloads or previews a file.",
    inputSchema: {
      workspace_id: numericId("Workspace").describe("Workspace ID"),
      folder_id: numericId("Folder").optional().describe("Folder ID (from a previous list_files); omit for the workspace root"),
      include_contact_details: includeContact,
    },
    annotations: READ,
  },
  safe(async ({ workspace_id, folder_id, include_contact_details }) => {
    const path = folder_id ? `/v2/file/browse/${workspace_id}/${folder_id}` : `/v2/file/browse/${workspace_id}`;
    const items = (await api.getList(path)).map((d) => fmt.discItem(d, include_contact_details));
    return { folders: items.filter((i) => i.kind === "folder"), files: items.filter((i) => i.kind === "file") };
  }),
);

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Dates look like 2026-10-31");
const validDate = (d: string) => {
  const t = Date.parse(`${d}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d;
};
// The endpoint's summary: "NB: acceptable date format dd-MM-yyyy".
const ddMMyyyy = (d: string) => `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}`;

server.registerTool(
  "list_calendar_events",
  {
    title: "List calendar events",
    description:
      "Calendar events in one workspace between two dates: title, times, attendees and their responses; the location (often an address) and attendee emails only with include_contact_details. Video-call links, host links and passwords are never returned.",
    inputSchema: {
      workspace_id: numericId("Workspace").describe("Workspace ID"),
      from: isoDate.describe("First day, YYYY-MM-DD"),
      to: isoDate.describe("Last day, YYYY-MM-DD"),
      include_contact_details: includeContact,
    },
    annotations: READ,
  },
  safe(async ({ workspace_id, from, to, include_contact_details }) => {
    if (!validDate(from) || !validDate(to)) throw new GlasscubesError(`Not a calendar date: ${!validDate(from) ? from : to}.`);
    if (from > to) throw new GlasscubesError(`from (${from}) is after to (${to}).`);
    const events = (await api.getList(`/v2/cal/get-events/${workspace_id}/${ddMMyyyy(from)}/${ddMMyyyy(to)}`)).map((e) => fmt.calendarEvent(e, include_contact_details));
    return { count: events.length, events };
  }),
);

if (allowWrites) {
  server.registerTool(
    "create_task",
    {
      title: "Create a task",
      description:
        "Create a task in a workspace (or, without workspace_id, in the current user's My Tasks), optionally with a due date and assignees. Dates are whole days, and the day boundaries are taken in UTC: the start is sent as 00:00:00.000Z and the due date as 23:59:59.000Z on that day. The API's note asks for the start and end of the local day converted to UTC, so during British Summer Time the task spans 01:00 to 00:59 UK time. If Glasscubes answers with a gateway error (502/503/504) the request is NOT retried, because the task may already exist: check list_tasks first. Only available when GLASSCUBES_ALLOW_WRITES=true.",
      inputSchema: {
        // The spec documents no length limit for tasks. These are this server's own limits, borrowed
        // from the one limit the spec does state (PUT /v2/post, errCode 125: title >= 254 or desc >= 64000).
        title: z.string().trim().min(1).max(253).describe("Task title, at most 253 characters (this server's own limit; the API documents none for tasks)"),
        description: z.string().max(63999).optional().describe("Task description, at most 63,999 characters (this server's own limit; the API documents none for tasks)"),
        workspace_id: numericId("Workspace").optional().describe("Workspace ID; omit to create a My Task for the current user"),
        start_date: isoDate.optional().describe("Start day, YYYY-MM-DD (defaults to the due date when a due date is given)"),
        due_date: isoDate.optional().describe("Due day, YYYY-MM-DD"),
        assignee_user_ids: z.array(numericId("User")).max(50).default([]).describe("User IDs to assign (see list_workspace_members)"),
        assignee_group_ids: z.array(numericId("Group")).max(50).default([]).describe("User group IDs to assign"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    safe(async ({ title, description, workspace_id, start_date, due_date, assignee_user_ids, assignee_group_ids }) => {
      for (const d of [start_date, due_date]) if (d && !validDate(d)) throw new GlasscubesError(`Not created. Not a calendar date: ${d}.`);
      if (start_date && !due_date) throw new GlasscubesError("Not created. Give a due_date with start_date (the API takes both dates together).");
      const start = start_date ?? due_date;
      if (start && due_date && start > due_date) throw new GlasscubesError(`Not created. start_date (${start}) is after due_date (${due_date}); the API refuses that (errCode 130).`);
      // Body shape: spec definition TaskRequest {title (required), description, startDate, endDate,
      // workspaceId, assignee: [TaskRequestAssignee {id, type: USER | GROUP}]}.
      const assignee = [...assignee_user_ids.map((id) => ({ id: Number(id), type: "USER" })), ...assignee_group_ids.map((id) => ({ id: Number(id), type: "GROUP" }))];
      const body = {
        title,
        ...(description ? { description } : {}),
        ...(start && due_date ? { startDate: `${start}T00:00:00.000Z`, endDate: `${due_date}T23:59:59.000Z` } : {}),
        ...(workspace_id ? { workspaceId: Number(workspace_id) } : {}),
        ...(assignee.length ? { assignee } : {}),
      };
      // A 200 means the task was created, so an empty or unexpected body is reported, not raised.
      const res = await api.request("PUT", "/v2/task", { body, allowEmpty: true });
      if (!res || typeof res !== "object" || Array.isArray(res)) {
        return { result: "created", task: undefined, note: "Glasscubes answered 200 but did not return the created task as documented; check list_tasks to see it." };
      }
      return { result: "created", task: fmt.task(res, false) };
    }),
  );

  server.registerTool(
    "set_task_state",
    {
      title: "Set task state",
      description:
        "Change a task's state to NEW (not started), STARTED (in progress) or COMPLETED. The task is read first, so the result includes previous_state (call again with it to undo), and read back afterwards. Setting the same state twice has the same effect. Only available when GLASSCUBES_ALLOW_WRITES=true.",
      inputSchema: {
        task_id: numericId("Task").describe("Task ID"),
        state: z.enum(["NEW", "STARTED", "COMPLETED"]).describe("New state"),
      },
      // Destructive in the MCP sense: it overwrites the task's state rather than only adding.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ task_id, state }) => {
      const before = await api.getObject(`/v2/task/${task_id}`);
      const previous = typeof before.state === "string" ? before.state : undefined;
      // Spec: POST /v2/task/{id}/state with the state as a query parameter; the only documented
      // response is "default: successful operation" with no body.
      await api.request("POST", `/v2/task/${task_id}/state`, { query: { state }, allowEmpty: true });
      const after = await api.getObject(`/v2/task/${task_id}`);
      return { result: "state changed", previous_state: previous, requested_state: state, task: fmt.task(after, false) };
    }),
  );
}

await server.connect(new StdioServerTransport());
console.error(`Glasscubes MCP server running (writes ${allowWrites ? "enabled" : "disabled"}, token refresh ${api.canRefresh ? "enabled" : "not configured"}).`);
