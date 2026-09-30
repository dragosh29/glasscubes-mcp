// Turn Glasscubes API records into compact objects an assistant can read quickly.
// Field names follow the definitions in the Glasscubes Swagger 2.0 document (WorkspaceListItem,
// WorkspaceListLabel, WorkspaceInfoV3, WorkspaceMemberInfo, UserInfo, GroupInfo,
// InformationRequestReadDto, InformationRequestItemReadDto, InformationRequestAssignmentReadDto,
// InformationRequestTemplateReadDto, UserDto, TaskResponse, TaskAssignee, DiscItem, FileInfo,
// FolderInfo, EventInfo, EventAttendeeInfo).

type Rec = Record<string, any>;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Phone-number-like sequences, a heuristic. Three shapes, digits optionally separated by a space, dot
// or hyphen:
//   international: "+" or "00", a 1-3 digit country code, an optional bracketed group (a "(0)" trunk
//     prefix or an area code), then 6-14 digits (+44 7700 900123, +447700900321, +44 (0)7700 900123,
//     +1 (415) 555-2671, 0044 20 7946 0958, 00 44 7700 900123);
//   bracketed UK area code: "(0...)" then 5-10 digits ((020) 7946 0958, (0117) 496 0000, (07700) 900789);
//   UK national: "0" then 8-10 more digits (07700 900789, 020 7946 0958, 07 700 900 789, 07700.900123).
// Not preceded by a letter, digit, "_" or "-", and not followed by another digit (directly or after
// "_" or "-"), so numeric IDs, timestamps and hyphenated references such as YE-2026-0001 are left
// alone; a letter straight after the number ("07700900123ext") does not stop the match. Any other
// 9-11 digit string starting with 0 (an order number, say) is redacted too; the raw text is
// available with include_contact_details.
const PHONE = /(?<![\w-])(?:(?:\+|00)[ .-]?[1-9]\d{0,2}(?:[ .-]?\(\d{1,5}\))?(?:[ .-]?\d){6,14}|\(0\d{0,4}\)(?:[ .-]?\d){5,10}|0(?:[ .-]?\d){8,10})(?![_-]?\d)/g;
// UK postcodes (CF64 3DH, SW1A 1AA, M1 1AE, EC1A1BB, cf64 3dh): one or two letters, a digit, an
// optional letter or digit, an optional space, a digit and two letters, not touching other letters or
// digits. Any case. Lower-case ordinals are not taken for the last two letters, so "Q1 2nd" and
// "Q4 1st" are left alone; any other text in the same shape is redacted too.
const POSTCODE = /(?<![A-Za-z0-9])[A-Za-z]{1,2}\d[A-Za-z\d]? ?\d(?!(?:st|nd|rd|th)(?![A-Za-z0-9]))[A-Za-z]{2}(?![A-Za-z0-9])/g;
// UK National Insurance numbers (QQ 12 34 56 C, AB123456D, ab 12 34 56 c): two letters, three pairs of
// digits, a final A-D. Any case, optional spaces.
const NINO = /(?<![A-Za-z0-9])[A-Za-z]{2} ?\d{2} ?\d{2} ?\d{2} ?[A-Da-d](?![A-Za-z0-9])/g;
// A payment card number typed into free text: 13 to 19 digits, optionally grouped by spaces or
// hyphens, that pass the Luhn check. Replaced even when contact details were requested: this server
// never returns card data. Runs first so a card number is never partly consumed by the phone pattern.
const CARD = /(?<![\w-])\d(?:[ -]?\d){12,18}(?![\w-])/g;
const luhn = (digits: string): boolean => {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (double) n = n > 4 ? n * 2 - 9 : n * 2;
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
};
const redactCards = (text: string) => text.replace(CARD, (m) => (luhn(m.replace(/\D/g, "")) ? "[card number redacted]" : m));

const redactString = (text: string) =>
  redactCards(text).replace(EMAIL, "[email redacted]").replace(NINO, "[NI number redacted]").replace(PHONE, "[phone redacted]").replace(POSTCODE, "[postcode redacted]");

/**
 * Replace email addresses, phone-number-like sequences, UK postcodes and National Insurance numbers
 * inside free text (names of workspaces, groups, modules and labels, client codes, subjects,
 * descriptions, item names, titles, Glasscubes' own error messages) unless contact details were
 * requested. Luhn-valid card numbers are replaced either way. Street addresses, dates of birth, UTRs,
 * bank sort codes and account numbers and money amounts are NOT recognised: they look like ordinary
 * text, dates, references and figures.
 */
export function redactContacts(text: unknown, includeContact: boolean): string | undefined {
  if (typeof text !== "string") return undefined;
  if (text === "") return undefined;
  return includeContact ? redactCards(text) : redactString(text);
}

const str = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : String(v));
const num = (v: unknown) => {
  const n = Number(v);
  return v === undefined || v === null || v === "" || !Number.isFinite(n) ? undefined : n;
};
const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined);
const arr = (v: unknown): Rec[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : []);
const fullName = (first: unknown, last: unknown) => [str(first), str(last)].filter(Boolean).join(" ") || undefined;

// ---- people ----

/**
 * UserInfo (members, task assignees, creators, file updaters). The name, active/deleted flags and the
 * user's company name are returned; the email only on request. profilePictureURL is never returned.
 */
export function user(u: Rec | undefined, includeContact: boolean) {
  if (!u || typeof u !== "object") return undefined;
  return {
    id: num(u.id),
    name: redactContacts(fullName(u.firstName, u.lastName), includeContact),
    company: redactContacts(u.company?.name, includeContact),
    active: bool(u.active),
    deleted: bool(u.deleted),
    ...(includeContact ? { email: str(u.email) } : {}),
  };
}

/** Just the name of a UserInfo, for "created by" style fields. */
const userName = (u: Rec | undefined, includeContact: boolean) => (u && typeof u === "object" ? redactContacts(fullName(u.firstName, u.lastName), includeContact) : undefined);

/** UserDto (information request recipients). Name only by default; email only on request. */
function userDto(u: Rec | undefined, includeContact: boolean) {
  if (!u || typeof u !== "object") return undefined;
  return {
    id: num(u.id),
    name: redactContacts(str(u.name) ?? fullName(u.firstName, u.lastName), includeContact),
    external: bool(u.external),
    ...(includeContact ? { email: str(u.email) } : {}),
  };
}

export function member(m: Rec, includeContact: boolean) {
  if (m.user) return { kind: "user", ...user(m.user, includeContact) };
  if (m.group) return { kind: "group", id: num(m.group.id), name: redactContacts(m.group.name, includeContact), member_count: Array.isArray(m.group.members) ? m.group.members.length : undefined };
  return { kind: "unknown" };
}

// ---- workspaces ----

/** A workspace or group reference {id, name}; the name is free text typed by the practice. */
const ref = (r: Rec | undefined, includeContact: boolean) => (r && typeof r === "object" ? { id: num(r.id), name: redactContacts(r.name, includeContact) } : undefined);
/** Label names ({name} objects, as on tasks, files, events and the workspace label list). */
export const labelNames = (v: unknown, includeContact: boolean): string[] =>
  arr(v).map((l) => redactContacts(l.name, includeContact)).filter((n): n is string => !!n);

export function workspaceListItem(w: Rec, includeContact: boolean) {
  return {
    id: num(w.id),
    name: redactContacts(w.name, includeContact),
    pinned: bool(w.pinned),
    group: ref(w.group, includeContact),
  };
}

// WorkspaceInfoV3. Workspace, group and module names are free text typed by the practice (a
// workspace is usually named after the client) and get the same redaction as any other free text.
export function workspace(w: Rec, includeContact: boolean) {
  return {
    id: num(w.id),
    name: redactContacts(w.name, includeContact),
    permission: str(w.permission),
    company_workspace: bool(w.companyWorkspace),
    public_workspace: bool(w.publicWorkspace),
    modules: arr(w.modules).map((m) => redactContacts(m.friendlyName, includeContact)).filter(Boolean),
    group: ref(w.group, includeContact),
    public_info: w.publicInfo
      ? { title: redactContacts(w.publicInfo.title, includeContact), description: redactContacts(w.publicInfo.description, includeContact), current_user_member_of: bool(w.publicInfo.currentUserMemberOf) }
      : undefined,
  };
}

// ---- information requests ----

const countBy = (items: Rec[], key: string) => {
  const out: Record<string, number> = {};
  for (const i of items) {
    const k = str(i[key]) ?? "unknown";
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
};

/**
 * The recipient of an information request: the linked user's name, or for a personal-tax request the
 * client's firstName/lastName and clientCode. The address it was sent to (sentToEmail) and the
 * request's publicUrl (a link into the client's view of the request) only on request.
 */
function recipient(r: Rec, includeContact: boolean) {
  const u = userDto(r.sentToUser, includeContact);
  return {
    name: u?.name ?? redactContacts(fullName(r.firstName, r.lastName), includeContact),
    user_id: u?.id,
    client_code: redactContacts(r.clientCode, includeContact),
    ...(includeContact ? { email: str(r.sentToEmail) ?? u?.email } : {}),
  };
}

export function informationRequestSummary(r: Rec, includeContact: boolean) {
  const items = arr(r.items);
  return {
    id: num(r.id),
    subject: redactContacts(r.subject, includeContact),
    status: str(r.status),
    request_type: str(r.requestType),
    workspace_id: num(r.workspaceId),
    created: str(r.createdDate),
    viewed: str(r.viewedDate),
    due: str(r.requestDue),
    recipient: recipient(r, includeContact),
    assignee_count: arr(r.assignments).length,
    items_total: items.length,
    item_status_counts: countBy(items, "status"),
    ...(includeContact ? { public_url: str(r.publicUrl) } : {}),
  };
}

export function informationRequestDetail(r: Rec, includeContact: boolean) {
  return {
    ...informationRequestSummary(r, includeContact),
    description: redactContacts(r.description, includeContact),
    folder_id: num(r.folderId),
    created_by_user_id: num(r.createdByUserId),
    items: arr(r.items).map((i) => {
      const updates = arr(i.updates);
      const last = updates.map((u) => str(u.createdDate)).filter((d): d is string => !!d).sort().pop();
      return {
        id: num(i.id),
        name: redactContacts(i.itemName, includeContact),
        status: str(i.status),
        file_count: Array.isArray(i.files) ? i.files.length : 0,
        update_counts: countBy(updates, "type"),
        last_update: last,
      };
    }),
    assignments: arr(r.assignments).map((a) => ({
      id: num(a.id),
      name: userDto(a.sentToUser, includeContact)?.name,
      muted_since: str(a.muted),
      send_error_at: str(a.sendError),
      ...(includeContact ? { email: str(a.sentToEmail) ?? str(a.sentToUser?.email), public_url: str(a.publicUrl) } : {}),
    })),
  };
}

export function requestTemplate(t: Rec) {
  // Template names and item names are the practice's own text; the templates tool has no
  // include_contact_details switch, so the free-text redaction always applies.
  return { id: num(t.id), name: redactContacts(t.name, false), items: (Array.isArray(t.items) ? t.items : []).map((i: unknown) => redactContacts(i, false)).filter(Boolean) };
}

// ---- tasks ----

export function task(t: Rec, includeContact: boolean) {
  return {
    id: num(t.id),
    type: str(t.taskType),
    title: redactContacts(t.title, includeContact),
    description: redactContacts(t.description, includeContact),
    state: str(t.state),
    start: str(t.startDate),
    due: str(t.endDate),
    created: str(t.creationDate),
    created_by: userName(t.createdBy, includeContact),
    workspace: ref(t.workspace, includeContact),
    group_id: num(t.groupId),
    labels: labelNames(t.labels, includeContact),
    assignees: arr(t.assignee).map((a) =>
      a.user
        ? { kind: "user", id: num(a.user.id), name: userName(a.user, includeContact), ...(includeContact ? { email: str(a.user.email) } : {}) }
        : { kind: "group", id: num(a.group?.id), name: redactContacts(a.group?.name, includeContact) },
    ),
    attachments: arr(t.attachments).map((f) => ({ id: num(f.id), title: redactContacts(f.title, includeContact) })),
    form_submissions: arr(t.formSubmits).map((f) => ({ id: num(f.id), form: redactContacts(f.formName, includeContact), created: str(f.creationDate) })),
  };
}

// ---- files (metadata only) ----

export function fileInfo(f: Rec, includeContact: boolean) {
  return {
    id: num(f.id),
    title: redactContacts(f.title, includeContact),
    version: num(f.version),
    size_bytes: num(f.fileSize),
    updated: str(f.updateDate),
    updated_by: userName(f.updatedBy, includeContact),
    requested_by: userName(f.whoRequested, includeContact),
    labels: labelNames(f.labels, includeContact),
  };
}

export function discItem(d: Rec, includeContact: boolean) {
  if (d.folderInfo) return { kind: "folder", id: num(d.folderInfo.id), name: redactContacts(d.folderInfo.name, includeContact) };
  if (d.fileInfo) return { kind: "file", ...fileInfo(d.fileInfo, includeContact) };
  return { kind: "unknown" };
}

// ---- calendar ----

/**
 * EventInfo. Attendee names and RSVP responses are returned; attendee emails and the location (often
 * an address) only on request. Video
 * call details (zoomInfo with its host link and password, msTeamsJoinUrl, conferenceCode) are never
 * returned: only whether the event has one. Comments and the debug date strings are left out.
 */
export function calendarEvent(e: Rec, includeContact: boolean) {
  return {
    id: num(e.id),
    title: redactContacts(e.title, includeContact),
    start: str(e.startDate),
    end: str(e.endDate),
    all_day: bool(e.allDay),
    repeats: bool(e.repeats),
    ...(includeContact ? { location: redactContacts(e.location, true) } : {}),
    description: redactContacts(e.description, includeContact),
    created_by: userName(e.createdBy, includeContact),
    workspace: ref(e.workspace, includeContact),
    has_video_call: Boolean(e.zoomCall || e.zoomInfo || str(e.msTeamsJoinUrl) || str(e.conferenceCode)),
    attendees: arr(e.attendees).map((a) => ({
      name: userName(a.user, includeContact),
      response: str(a.response),
      ...(includeContact ? { email: str(a.email) ?? str(a.user?.email) } : {}),
    })),
    labels: labelNames(e.labels, includeContact),
    attachment_count: arr(e.attachments).length,
  };
}
