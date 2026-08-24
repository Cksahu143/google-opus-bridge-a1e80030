import { z } from "zod";
import { defineAdapter, defineCapability } from "@/lib/nexus/types";
import { SCOPES } from "@/lib/nexus/scopes";

const project = (value?: string) => value?.trim() || import.meta.env["VITE_GOOGLE_CLOUD_PROJECT"] || "";
const needProject = (value?: string) => {
  const id = project(value);
  if (!id) throw new Error("Google Cloud project is required. Set VITE_GOOGLE_CLOUD_PROJECT or pass projectId.");
  return id;
};

export const cloudAiAdapter = defineAdapter({
  service: "cloud-ai",
  label: "Google Cloud AI",
  description: "Official Google Cloud AI connectors for speech, translation, vision, language and document processing.",
  status: "requires-configuration",
  statusNote: "Enable the individual Google Cloud APIs listed in the Nexus documentation and provide a project id. OAuth uses the existing Google account grant with cloud-platform scope.",
  docsUrl: "https://cloud.google.com/ai/apis",
  capabilities: [
    defineCapability({
      id: "cloudai.translate",
      title: "Translate text",
      description: "Translate one or more strings with Cloud Translation Advanced.",
      implementation: "google-rest-api",
      scopes: [SCOPES.cloudPlatform],
      input: z.object({ projectId: z.string().optional(), location: z.string().default("global"), sourceLanguageCode: z.string().optional(), targetLanguageCode: z.string().min(2), contents: z.array(z.string()).min(1).max(100), mimeType: z.enum(["text/plain", "text/html"]).default("text/plain") }),
      run: async (ctx, input) => {
        const p = needProject(input.projectId);
        return ctx.api(`https://translation.googleapis.com/v3/projects/${encodeURIComponent(p)}/locations/${encodeURIComponent(input.location)}:translateText`, { method: "POST", body: { sourceLanguageCode: input.sourceLanguageCode, targetLanguageCode: input.targetLanguageCode, contents: input.contents, mimeType: input.mimeType } });
      },
    }),
    defineCapability({
      id: "cloudai.synthesize_speech",
      title: "Synthesize speech",
      description: "Convert text or SSML to audio with Cloud Text-to-Speech. Returns base64 audio content.",
      implementation: "google-rest-api",
      scopes: [SCOPES.cloudPlatform],
      input: z.object({ projectId: z.string().optional(), text: z.string().optional(), ssml: z.string().optional(), languageCode: z.string().default("en-US"), voiceName: z.string().optional(), speakingRate: z.number().min(0.25).max(4).default(1), audioEncoding: z.enum(["MP3", "LINEAR16", "OGG_OPUS", "MULAW", "ALAW"]).default("MP3") }),
      run: async (ctx, input) => {
        needProject(input.projectId);
        if (!input.text && !input.ssml) throw new Error("Provide text or ssml.");
        return ctx.api("https://texttospeech.googleapis.com/v1/text:synthesize", { method: "POST", body: { input: input.ssml ? { ssml: input.ssml } : { text: input.text }, voice: { languageCode: input.languageCode, ...(input.voiceName ? { name: input.voiceName } : {}) }, audioConfig: { audioEncoding: input.audioEncoding, speakingRate: input.speakingRate } } });
      },
    }),
    defineCapability({
      id: "cloudai.detect_speech",
      title: "Transcribe audio",
      description: "Transcribe inline base64 audio with Speech-to-Text v2 using a configured recognizer.",
      implementation: "google-rest-api",
      scopes: [SCOPES.cloudPlatform],
      input: z.object({ projectId: z.string().optional(), location: z.string().default("global"), recognizer: z.string().default("_"), audioBase64: z.string().min(1), languageCodes: z.array(z.string()).min(1).max(10).default(["en-US"]), model: z.string().default("latest_long"), autoDecoding: z.boolean().default(true) }),
      run: async (ctx, input) => {
        const p = needProject(input.projectId);
        return ctx.api(`https://speech.googleapis.com/v2/projects/${encodeURIComponent(p)}/locations/${encodeURIComponent(input.location)}/recognizers/${encodeURIComponent(input.recognizer)}:recognize`, { method: "POST", body: { config: { autoDecodingConfig: input.autoDecoding ? {} : undefined, languageCodes: input.languageCodes, model: input.model }, content: input.audioBase64 } });
      },
    }),
    defineCapability({
      id: "cloudai.vision_ocr",
      title: "Analyze an image",
      description: "Run Cloud Vision OCR or general image features against base64 image data.",
      implementation: "google-rest-api",
      scopes: [SCOPES.cloudPlatform],
      input: z.object({ imageBase64: z.string().min(1), features: z.array(z.enum(["TEXT_DETECTION", "DOCUMENT_TEXT_DETECTION", "LABEL_DETECTION", "OBJECT_LOCALIZATION", "LOGO_DETECTION", "SAFE_SEARCH_DETECTION", "IMAGE_PROPERTIES"])).min(1).default(["DOCUMENT_TEXT_DETECTION"]), maxResults: z.number().int().min(1).max(100).default(20) }),
      run: async (ctx, input) => ctx.api("https://vision.googleapis.com/v1/images:annotate", { method: "POST", body: { requests: [{ image: { content: input.imageBase64 }, features: input.features.map((type) => ({ type, maxResults: input.maxResults })) }] } }),
    }),
    defineCapability({
      id: "cloudai.sentiment",
      title: "Analyze sentiment",
      description: "Analyze sentiment and language syntax using Cloud Natural Language.",
      implementation: "google-rest-api",
      scopes: [SCOPES.cloudPlatform],
      input: z.object({ text: z.string().min(1), languageCode: z.string().optional() }),
      run: async (ctx, input) => ctx.api("https://language.googleapis.com/v2/documents:analyzeSentiment", { method: "POST", body: { document: { type: "PLAIN_TEXT", content: input.text, ...(input.languageCode ? { languageCode: input.languageCode } : {}) }, encodingType: "UTF8" } }),
    }),
    defineCapability({
      id: "cloudai.document_ai",
      title: "Process a document",
      description: "Run a Document AI processor on an inline base64 PDF or image.",
      implementation: "google-rest-api",
      scopes: [SCOPES.cloudPlatform],
      input: z.object({ projectId: z.string().optional(), location: z.string().default("us"), processorId: z.string().min(1), mimeType: z.enum(["application/pdf", "image/png", "image/jpeg", "image/tiff"]).default("application/pdf"), documentBase64: z.string().min(1), fieldMask: z.string().optional() }),
      run: async (ctx, input) => {
        const p = needProject(input.projectId);
        return ctx.api(`https://documentai.googleapis.com/v1/projects/${encodeURIComponent(p)}/locations/${encodeURIComponent(input.location)}/processors/${encodeURIComponent(input.processorId)}:process`, { method: "POST", body: { rawDocument: { content: input.documentBase64, mimeType: input.mimeType }, ...(input.fieldMask ? { fieldMask: input.fieldMask } : {}) } });
      },
    }),
  ],
});

export default cloudAiAdapter;
