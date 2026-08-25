import { auth, defineMcp, type McpDefinitionInput } from "@lovable.dev/mcp-js";

import batchCallCapabilities from "./tools/batch-call-capabilities";
import callCapability from "./tools/call-capability";
import connectionStatus from "./tools/connection-status";
import describeCapability from "./tools/describe-capability";
import listCapabilities from "./tools/list-capabilities";
import searchCapabilities from "./tools/search-capabilities";

const projectRef = import.meta.env["VITE_SUPABASE_PROJECT_ID"] ?? "project-ref-unset";

const tools = [
  listCapabilities,
  searchCapabilities,
  describeCapability,
  callCapability,
  batchCallCapabilities,
  connectionStatus,
] as unknown as McpDefinitionInput["tools"];

export default defineMcp({
  name: "google-nexus-gateway",
  title: "Google Nexus Gateway",
  version: "1.2.0",
  instructions:
    "Google Nexus is one connection to the whole Google ecosystem and configured Google Cloud services for the signed-in user. Start with search_capabilities when you know the task but not the exact capability id, or list_capabilities for the complete catalog. Use call_capability for one operation and batch_call_capabilities for a short ordered workflow. Use connection_status when a call reports a missing connection or permission. Mutating calls are executed only through the authenticated user's Nexus connection.",
  auth: auth.oauth.issuer({
    issuer: `https://${projectRef}.supabase.co/auth/v1`,
    acceptedAudiences: "authenticated",
  }),
  tools,
});
