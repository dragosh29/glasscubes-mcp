// Built at run time so secret scanners do not read a test value as a real password.
export const FAKE_ZOOM_PASSWORD = ["zoom", "value", "not", "real"].join("-");
// Fake Glasscubes data shaped exactly like the definitions in the published Swagger 2.0 document
// (validated in e2e.mjs, including a check that no fixture carries a key the definition does not declare).
// All names, emails, phone numbers and postcodes are invented; emails use example.com.
const at = (d, h = 9, m = 0) => `2026-${d}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;

// ---- workspaces (WorkspaceListItem, WorkspaceInfoV3, WorkspaceListLabel) ----
export const WS_EVANS = 1001;
export const WS_SHAH = 1002;
export const GROUP_YEAR_END = 7;
const yearEnd = { id: GROUP_YEAR_END, name: "Year-end clients" };
export const workspaces = [
  { id: WS_EVANS, name: "Evans Bakery Ltd", pinned: true, group: yearEnd },
  { id: WS_SHAH, name: "Priya Shah (personal tax)", pinned: false, group: { id: 8, name: "Personal tax" } },
  ...Array.from({ length: 118 }, (_, i) => ({ id: 2000 + i, name: `Client ${String(i + 1).padStart(3, "0")} Ltd`, pinned: false, ...(i % 3 === 0 ? { group: yearEnd } : {}) })),
];
// Labels per workspace (WorkspaceListItem has no labels field; the mock uses this map to serve l=).
export const workspaceLabels = { [WS_EVANS]: ["Payroll", "Year end"], [WS_SHAH]: ["Self assessment"], 2003: ["Payroll"] };
export const labels = [...new Set(Object.values(workspaceLabels).flat())].sort().map((name) => ({ name }));

const modules = [{ friendlyName: "Files" }, { friendlyName: "Tasks" }, { friendlyName: "Information Requests" }];
export const workspaceDetails = {
  [WS_EVANS]: { id: WS_EVANS, name: "Evans Bakery Ltd", permission: "OWNERSHIP", companyWorkspace: false, publicWorkspace: false, modules, group: yearEnd },
  [WS_SHAH]: {
    id: WS_SHAH, name: "Priya Shah (personal tax)", permission: "WRITE", companyWorkspace: false, publicWorkspace: true, modules, group: { id: 8, name: "Personal tax" },
    publicInfo: { currentUserMemberOf: true, title: "Self assessment 2025/26", description: "Questions? Email tax@example.com or call 020 7946 0958.", color: "#ffffff", backgroundColor: "#003366", imageDocId: 5 },
  },
};

// ---- users (UserInfo, UserDto) ----
const company = { id: 42, name: "Example Accountants Ltd", companyURL: "https://example.com", companyLogo: "https://example.com/logo.png", hideZopimChat: true, accountType: "PROFESSIONAL" };
const clientCo = { id: 43, name: "Evans Bakery Ltd", companyURL: "", companyLogo: "", hideZopimChat: true, accountType: "GUEST" };
export const users = {
  alex: { id: 11, firstName: "Alex", lastName: "Example", email: "alex@example.com", company, profilePictureURL: "https://example.com/p/11.png", deleted: false, active: true },
  jo: { id: 12, firstName: "Jo", lastName: "Bloggs", email: "jo.bloggs@example.com", company, profilePictureURL: "https://example.com/p/12.png", deleted: false, active: true },
  sam: { id: 21, firstName: "Sam", lastName: "Evans", email: "sam.evans@example.com", company: clientCo, profilePictureURL: "https://example.com/p/21.png", deleted: false, active: true },
};
const samDto = {
  id: 21, email: "sam.evans@example.com", firstName: "Sam", lastName: "Evans", profileThumbName: "sam.png", roundAvatar: "https://example.com/r/21.png",
  lastRecordedActionTime: at("09-20", 10), inviteSentDate: at("05-01"), external: true, mtdOnly: false, active: true, locked: false,
  customProperties: {}, name: "Sam Evans", nameAndEmail: "Sam Evans <sam.evans@example.com>", userImageUrl: "https://example.com/u/21.png", initials: "SE", key: "u21",
  group: false, team: false, user: true, projectContact: true,
};

export const members = {
  [WS_EVANS]: [{ user: users.alex }, { user: users.sam }, { group: { id: 31, name: "Tax team", members: [users.alex, users.jo] } }],
  [WS_SHAH]: [{ user: users.jo }],
};

// ---- information requests (InformationRequestReadDto) ----
export const IR_YEAR_END = 5001;
export const IR_VAT = 5002;
export const IR_TAX = 5003;
export const CARD_NUMBER = "4111 1111 1111 1111"; // the well-known Luhn-valid test card number
const upd = (id, type, d) => ({ id, type, createdDate: at(d, 11) });
export const informationRequests = [
  {
    uuid: "ir-5001-uuid-not-real", id: IR_YEAR_END, subject: "Year-end 2026 records", description: "Please upload everything by 31 October. Queries to jo.bloggs@example.com or 07700 900123.",
    workspaceId: WS_EVANS, folderId: 801, status: "Waiting", createdByUserId: 12, createdDate: at("09-01"), viewedDate: at("09-02", 14), sentToUser: samDto, sentToEmail: "sam.evans@example.com",
    requestDue: at("10-31", 23, 59), publicUrl: "https://example.glasscubes.com/r/ir-5001-public",
    items: [
      { id: 60011, itemName: "Bank statements Apr 2025 to Mar 2026", status: "WAITING", updates: [], files: [] },
      { id: 60012, itemName: "Sales invoices", status: "COMPLETE", updates: [upd(1, "RESPONSE", "09-05")], files: [9101, 9102] },
      { id: 60013, itemName: "Payroll summary (ring 07700 900456 if unsure)", status: "AMEND", updates: [upd(2, "RESPONSE", "09-06"), upd(3, "QUERY", "09-08")], files: [9103] },
      { id: 60014, itemName: "Card used for business: " + CARD_NUMBER, status: "WAITING", updates: [upd(4, "NOTE", "09-03")], files: [] },
    ],
    assignments: [{ id: 70011, uuid: "as-70011-not-real", sentToUser: samDto, sentToEmail: "sam.evans@example.com", publicUrl: "https://example.glasscubes.com/r/as-70011-public" }],
    requestType: "STANDARD", clientCode: "EVA001",
  },
  {
    uuid: "ir-5002-uuid-not-real", id: IR_VAT, subject: "VAT Q2 2026", description: "", workspaceId: WS_EVANS, folderId: 801, status: "Completed", createdByUserId: 11,
    createdDate: at("07-01"), viewedDate: at("07-02"), sentToUser: samDto, sentToEmail: "sam.evans@example.com", requestDue: at("07-31"), publicUrl: "https://example.glasscubes.com/r/ir-5002-public",
    items: [{ id: 60021, itemName: "Purchase invoices", status: "VERIFIED", updates: [upd(5, "RESPONSE", "07-10")], files: [9201] }],
    assignments: [], requestType: "STANDARD", clientCode: "EVA001",
  },
  {
    uuid: "ir-5003-uuid-not-real", id: IR_TAX, subject: "Self assessment 2025/26", description: "Home address on file: 1 Plymouth Road, Penarth CF64 3DH.",
    workspaceId: WS_EVANS, folderId: 802, status: "Overdue", createdByUserId: 12, createdDate: at("08-01"), sentToEmail: "priya.shah@example.com", requestDue: at("09-15"),
    publicUrl: "https://example.glasscubes.com/r/ir-5003-public",
    items: [
      { id: 60031, itemName: "P60", status: "WAITING", updates: [], files: [] },
      { id: 60032, itemName: "Pension statements", status: "DELEGETED", updates: [upd(6, "DELEGATION", "08-20")], files: [] },
    ],
    assignments: [], requestType: "PERSONAL_TAX", clientCode: "SHA001", firstName: "Priya", lastName: "Shah",
  },
];

// ---- templates (InformationRequestTemplateReadDto) ----
export const accountTemplates = [
  { id: 401, name: "Year-end accounts", items: ["Bank statements", "Sales invoices", "Purchase invoices"] },
  { id: 402, name: "Self assessment", items: ["P60", "Pension statements", "Rental income"] },
];
export const workspaceTemplates = { [WS_EVANS]: [{ id: 403, name: "Evans payroll month end", items: ["Timesheets", "Starters and leavers (send to payroll@example.com)"] }] };

// ---- tasks (TaskResponse) ----
const wsInfo = (id) => ({ id, name: workspaceDetails[id].name, permission: workspaceDetails[id].permission, companyWorkspace: false, modules });
const file = (id, title, extra = {}) => ({ id, title, updatedBy: users.jo, updateDate: at("09-10", 16), workspace: wsInfo(WS_EVANS), labels: [], likes: [], inline: false, version: 1, fileSize: 20480, ...extra });
const mkTask = (id, title, state, extra = {}) => ({
  id, taskType: "TASK", title, description: "", startDate: at("10-01", 0), endDate: at("10-15", 23, 59), state,
  createdBy: users.alex, creationDate: at("09-15"), workspace: wsInfo(WS_EVANS), labels: [], assignee: [{ user: users.jo }], attachments: [], formSubmits: [], ...extra,
});
export const TASK_CHASE = 3001;
export const tasks = {
  [TASK_CHASE]: mkTask(TASK_CHASE, "Chase Sam for bank statements", "STARTED", {
    description: "Sam said to text him on 07700 900789 or email sam.evans@example.com.",
    labels: [{ id: 1, name: "Year end", color: "#ff0000" }],
    assignee: [{ user: users.jo }, { group: { id: 31, name: "Tax team", members: [users.alex, users.jo] } }],
    attachments: [file(9001, "Engagement letter 2026.pdf")],
    formSubmits: [{ id: 601, formName: "Year-end checklist", createdBy: users.jo, creationDate: at("09-16"), deleted: false }],
  }),
  3002: mkTask(3002, "Draft Evans accounts", "NEW"),
  3003: mkTask(3003, "Book year-end meeting", "NEW", { assignee: [] }),
  3101: mkTask(3101, "Review my CPD log", "NEW", { workspace: undefined }),
  3102: mkTask(3102, "Renew practising certificate", "STARTED", { workspace: undefined }),
};
for (const t of Object.values(tasks)) if (t.workspace === undefined) delete t.workspace;
export const workspaceTasks = { [WS_EVANS]: [TASK_CHASE, 3002, 3003] };
export const myTasks = [3101, 3102, TASK_CHASE];

// ---- files (DiscItem) ----
export const FOLDER_YEAR_END = 801;
export const browse = {
  [WS_EVANS]: [{ folderInfo: { id: FOLDER_YEAR_END, name: "Year end 2026", projectId: WS_EVANS } }, { fileInfo: file(9001, "Engagement letter 2026.pdf", { labels: [{ id: 2, name: "Signed", color: "#00ff00" }] }) }],
  [`${WS_EVANS}/${FOLDER_YEAR_END}`]: [
    { fileInfo: file(9101, "Sales invoices Q1.pdf", { updatedBy: users.sam, whoRequested: users.jo, version: 2, fileSize: 102400 }) },
    { fileInfo: file(9102, "Bank statement March (from sam.evans@example.com).pdf", { updatedBy: users.sam }) },
  ],
};

// ---- calendar (EventInfo) ----
export const events = {
  [WS_EVANS]: [
    {
      id: 7001, title: "Year-end review with Sam", description: "Dial in on 020 7946 0000 if the video fails.", location: "Evans Bakery, 1 Plymouth Road, Penarth CF64 3DH",
      conferenceCode: "123-456-789", invitationMessage: "See you there", startDate: at("10-06", 10), endDate: at("10-06", 11), displayStartDate: at("10-06", 11), displayEndDate: at("10-06", 12),
      repeats: false, allDay: false, emailMeInvitationCopy: false, emailMeAttendeeRsvp: true, derivedSubEvent: false, modifiedSubEvent: false,
      repeatInfo: { type: "NO_REPEAT", frequency: 0, repeatNofTimes: 0, dailyWeekdaysOnly: false, weeklyDays: [] },
      reminderInfo: { type: "15_MINUTES", viaEmail: true, viaSms: false, remindAttendees: true },
      attendees: [{ id: 1, user: users.sam, email: "sam.evans@example.com", response: "YES" }, { id: 2, user: users.jo, email: "jo.bloggs@example.com", response: "MAYBE" }],
      createdBy: users.jo, workspace: wsInfo(WS_EVANS), calendar: { id: 1, colour: "#0000ff" }, labels: [], attachments: [], comments: [],
      msTeamsJoinUrl: "", zoomCall: true,
      zoomInfo: { id: 1, startURL: "https://zoom.example.com/s/host-link-not-real", joinURL: "https://zoom.example.com/j/join-link-not-real", password: FAKE_ZOOM_PASSWORD, meetingId: 123456789, zoomOccurrenceInfoList: [] },
    },
    {
      id: 7002, title: "Payroll cut-off", description: "", location: "", startDate: at("10-24", 0), endDate: at("10-24", 23, 59), repeats: true, allDay: true,
      attendees: [], createdBy: users.alex, workspace: wsInfo(WS_EVANS), labels: [{ id: 3, name: "Payroll", color: "#cccccc" }], attachments: [file(9001, "Engagement letter 2026.pdf")], zoomCall: false,
    },
    { id: 7003, title: "Outside the range", startDate: at("12-01", 9), endDate: at("12-01", 10), allDay: false, attendees: [] },
  ],
};
