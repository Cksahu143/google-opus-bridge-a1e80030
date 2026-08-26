import appsScriptAdapter from "@/integrations/google/appsscript/index";
import calendarAdapter from "@/integrations/google/calendar/index";
import chatAdapter from "@/integrations/google/chat/index";
import classroomAdapter from "@/integrations/google/classroom/index";
import contactsAdapter from "@/integrations/google/contacts/index";
import docsAdapter from "@/integrations/google/docs/index";
import driveAdapter from "@/integrations/google/drive/index";
import driveActivityAdapter from "@/integrations/google/driveactivity/index";
import flowAdapter from "@/integrations/google/flow/index";
import formsAdapter from "@/integrations/google/forms/index";
import geminiAdapter from "@/integrations/google/gemini/index";
import gmailAdapter from "@/integrations/google/gmail/index";
import githubAdapter from "@/integrations/github/index";
import browserAdapter from "@/integrations/browser/index";
import steelBrowserAdapter from "@/integrations/steel-browser/index";
import replicateAdapter from "@/integrations/replicate/index";
import huggingfaceAdapter from "@/integrations/huggingface/index";
import daytonaAdapter from "@/integrations/daytona/index";
import imagenAdapter from "@/integrations/google/imagen/index";
import keepAdapter from "@/integrations/google/keep/index";
import meetAdapter from "@/integrations/google/meet/index";
import musicAdapter from "@/integrations/google/music/index";
import notebooklmAdapter from "@/integrations/google/notebooklm/index";
import notebooklmNativeAdapter from "@/integrations/google/notebooklm-native/index";
import notebooklmSteelAdapter from "@/integrations/google/notebooklm-steel/index";
import notebookEnterpriseAdapter from "@/integrations/google/notebook-enterprise/index";
import sheetsAdapter from "@/integrations/google/sheets/index";
import slidesAdapter from "@/integrations/google/slides/index";
import tasksAdapter from "@/integrations/google/tasks/index";
import veoAdapter from "@/integrations/google/veo/index";
import youtubeAdapter from "@/integrations/google/youtube/index";
import cloudAiAdapter from "@/integrations/google/cloud-ai/index";
import cloudDataAdapter from "@/integrations/google/cloud-data/index";
import type { Capability, GoogleAdapter } from "./types";

export const ADAPTERS: GoogleAdapter[] = [
  gmailAdapter,
  driveAdapter,
  driveActivityAdapter,
  docsAdapter,
  sheetsAdapter,
  slidesAdapter,
  calendarAdapter,
  tasksAdapter,
  contactsAdapter,
  meetAdapter,
  chatAdapter,
  formsAdapter,
  appsScriptAdapter,
  classroomAdapter,
  youtubeAdapter,
  keepAdapter,
  geminiAdapter,
  imagenAdapter,
  veoAdapter,
  musicAdapter,
  flowAdapter,
  notebooklmAdapter,
  notebooklmNativeAdapter,
  notebooklmSteelAdapter,
  notebookEnterpriseAdapter,
  cloudAiAdapter,
  cloudDataAdapter,
  githubAdapter,
  browserAdapter,
  steelBrowserAdapter,
  replicateAdapter,
  huggingfaceAdapter,
  daytonaAdapter,
];

export function findAdapter(service: string): GoogleAdapter | undefined {
  return ADAPTERS.find((adapter) => adapter.service === service);
}
export function allCapabilities(): {
  adapter: GoogleAdapter;
  capability: Capability<never, unknown>;
}[] {
  return ADAPTERS.flatMap((adapter) =>
    adapter.capabilities.map((capability) => ({ adapter, capability })),
  );
}
export function findCapability(id: string) {
  return allCapabilities().find((entry) => entry.capability.id === id);
}
export function allRequiredScopes(): string[] {
  const set = new Set<string>();
  for (const { capability } of allCapabilities())
    for (const scope of capability.scopes) set.add(scope);
  return Array.from(set).sort();
}
export interface CapabilitySummary {
  id: string;
  service: string;
  serviceLabel: string;
  title: string;
  description: string;
  implementation: string;
  mutating: boolean;
  scopes: string[];
  serviceStatus: string;
  inputSchema: { type: string; fields?: string[] };
}
export function capabilityCatalog(): CapabilitySummary[] {
  return allCapabilities().map(({ adapter, capability }) => ({
    id: capability.id,
    service: adapter.service,
    serviceLabel: adapter.label,
    title: capability.title,
    description: capability.description,
    implementation: capability.implementation,
    mutating: Boolean(capability.mutating),
    scopes: capability.scopes,
    serviceStatus: adapter.status,
    inputSchema: describeSchema(capability),
  }));
}
function describeSchema(capability: Capability<never, unknown>): {
  type: string;
  fields?: string[];
} {
  const shape = (
    capability.input as unknown as { _def?: { shape?: () => Record<string, unknown> } }
  )._def?.shape;
  if (typeof shape !== "function") return { type: "object" };
  try {
    return { type: "object", fields: Object.keys(shape()) };
  } catch {
    return { type: "object" };
  }
}
