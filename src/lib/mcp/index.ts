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
    "Google Nexus is one connection to the Google ecosystem and configured Google Cloud services. Start with list_capabilities or search_capabilities, then run operations with call_capability or batch_call_capabilities. Use connection_status when a call reports a missing connection or permission.",
  auth: auth.oauth.issuer({
    issuer: `https://${projectRef}.supabase.co/auth/v1`,
    acceptedAudiences: "authenticated",
  }),
  tools,
});
