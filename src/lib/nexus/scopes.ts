/** Least-privilege OAuth scope catalog used by Nexus adapters. */
export const SCOPES = {
  openid: "openid",
  email: "https://www.googleapis.com/auth/userinfo.email",
  profile: "https://www.googleapis.com/auth/userinfo.profile",
  gmailReadonly: "https://www.googleapis.com/auth/gmail.readonly",
  gmailSend: "https://www.googleapis.com/auth/gmail.send",
  gmailModify: "https://www.googleapis.com/auth/gmail.modify",
  gmailCompose: "https://www.googleapis.com/auth/gmail.compose",
  drive: "https://www.googleapis.com/auth/drive",
  documents: "https://www.googleapis.com/auth/documents",
  spreadsheets: "https://www.googleapis.com/auth/spreadsheets",
  presentations: "https://www.googleapis.com/auth/presentations",
  calendar: "https://www.googleapis.com/auth/calendar",
  tasks: "https://www.googleapis.com/auth/tasks",
  contacts: "https://www.googleapis.com/auth/contacts",
  contactsReadonly: "https://www.googleapis.com/auth/contacts.readonly",
  meetings: "https://www.googleapis.com/auth/meetings.space.created",
  meetingsReadonly: "https://www.googleapis.com/auth/meetings.space.readonly",
  chatSpaces: "https://www.googleapis.com/auth/chat.spaces.readonly",
  chatMessages: "https://www.googleapis.com/auth/chat.messages",
  forms: "https://www.googleapis.com/auth/forms.body",
  formsResponses: "https://www.googleapis.com/auth/forms.responses.readonly",
  script: "https://www.googleapis.com/auth/script.projects",
  youtubeReadonly: "https://www.googleapis.com/auth/youtube.readonly",
  classroomCourses: "https://www.googleapis.com/auth/classroom.courses.readonly",
  classroomRosters: "https://www.googleapis.com/auth/classroom.rosters.readonly",
  classroomCourseworkMe: "https://www.googleapis.com/auth/classroom.coursework.me.readonly",
  classroomCourseworkStudents: "https://www.googleapis.com/auth/classroom.coursework.students.readonly",
  classroomAnnouncements: "https://www.googleapis.com/auth/classroom.announcements.readonly",
  driveActivity: "https://www.googleapis.com/auth/drive.activity.readonly",
  cloudPlatform: "https://www.googleapis.com/auth/cloud-platform",
  discoveryEngineReadWrite: "https://www.googleapis.com/auth/discoveryengine.readwrite",
} as const;

export type ScopeKey = keyof typeof SCOPES;
export const BASE_SCOPES = [SCOPES.openid, SCOPES.email, SCOPES.profile];
export function uniqueScopes(scopes: string[]): string[] { return Array.from(new Set([...BASE_SCOPES, ...scopes])).sort(); }
