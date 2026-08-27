import { z } from "zod";

import { defineAdapter, defineCapability } from "@/lib/nexus/types";

/**
 * Generates structured design artifacts -- wireframe layouts, CSS motion
 * specs, and design token sets -- as data for Claude to render.
 *
 * IMPORTANT ARCHITECTURE NOTE: an MCP tool (everything in this app,
 * including this adapter) can only return data to Claude -- text, JSON,
 * an SVG string. It cannot render its own UI inside a chat conversation.
 * The "custom interface rendered inline" this was built for is Claude's
 * own separate Visualizer tool: this adapter generates the real content
 * (wireframe SVG, motion CSS, token JSON), and Claude renders that
 * content inline using the Visualizer in the same turn. Two systems
 * working together, not one tool doing both.
 *
 * Grounded in DESIGN_SYSTEM.md's researched 2026 conventions (type scale,
 * spacing scale, CSS-first motion decision framework) already in this
 * repo, rather than inventing a separate, disconnected token system.
 */

const typeScale = {
  xs: "0.75rem",
  sm: "0.875rem",
  base: "1rem",
  lg: "1.25rem",
  xl: "1.563rem",
  "2xl": "1.953rem",
  "3xl": "2.441rem",
  "4xl": "3.052rem",
};

const spacingScale = {
  1: "0.25rem",
  2: "0.5rem",
  3: "0.75rem",
  4: "1rem",
  6: "1.5rem",
  8: "2rem",
  12: "3rem",
  16: "4rem",
  24: "6rem",
};

interface WireframeRegion {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  children?: WireframeRegion[];
}

/** Simple top-down layout templates -- deliberately not AI-guessed per call, so output is consistent and testable. */
const LAYOUT_TEMPLATES: Record<string, (w: number, h: number) => WireframeRegion[]> = {
  landing: (w, h) => [
    { name: "nav", x: 0, y: 0, width: w, height: h * 0.08 },
    { name: "hero", x: 0, y: h * 0.08, width: w, height: h * 0.42 },
    {
      name: "features",
      x: 0,
      y: h * 0.5,
      width: w,
      height: h * 0.3,
      children: [0, 1, 2].map((i) => ({
        name: `feature-${i + 1}`,
        x: (w / 3) * i + w * 0.02,
        y: h * 0.52,
        width: w / 3 - w * 0.04,
        height: h * 0.26,
      })),
    },
    { name: "footer", x: 0, y: h * 0.82, width: w, height: h * 0.18 },
  ],
  dashboard: (w, h) => [
    { name: "sidebar", x: 0, y: 0, width: w * 0.2, height: h },
    { name: "topbar", x: w * 0.2, y: 0, width: w * 0.8, height: h * 0.1 },
    {
      name: "cards",
      x: w * 0.2,
      y: h * 0.12,
      width: w * 0.78,
      height: h * 0.3,
      children: [0, 1, 2, 3].map((i) => ({
        name: `card-${i + 1}`,
        x: w * 0.2 + ((w * 0.78) / 4) * i + w * 0.01,
        y: h * 0.12,
        width: (w * 0.78) / 4 - w * 0.02,
        height: h * 0.28,
      })),
    },
    { name: "main-panel", x: w * 0.2, y: h * 0.45, width: w * 0.78, height: h * 0.53 },
  ],
  form: (w, h) => [
    { name: "header", x: w * 0.15, y: h * 0.05, width: w * 0.7, height: h * 0.12 },
    {
      name: "fields",
      x: w * 0.15,
      y: h * 0.2,
      width: w * 0.7,
      height: h * 0.6,
      children: [0, 1, 2, 3].map((i) => ({
        name: `field-${i + 1}`,
        x: w * 0.15,
        y: h * 0.2 + ((h * 0.6) / 4) * i,
        width: w * 0.7,
        height: (h * 0.6) / 4 - h * 0.02,
      })),
    },
    { name: "submit-button", x: w * 0.15, y: h * 0.85, width: w * 0.25, height: h * 0.08 },
  ],
};

function regionToSvg(region: WireframeRegion, depth: number): string {
  const fill = depth === 0 ? "#e2e8f0" : "#cbd5e1";
  const stroke = "#94a3b8";
  const rect = `<rect x="${region.x.toFixed(1)}" y="${region.y.toFixed(1)}" width="${region.width.toFixed(1)}" height="${region.height.toFixed(1)}" fill="${fill}" stroke="${stroke}" stroke-width="1.5" rx="4"/>`;
  const label = `<text x="${(region.x + 8).toFixed(1)}" y="${(region.y + 18).toFixed(1)}" font-family="monospace" font-size="11" fill="#475569">${region.name}</text>`;
  const children = (region.children ?? []).map((child) => regionToSvg(child, depth + 1)).join("\n");
  return `${rect}\n${label}\n${children}`;
}

function buildWireframeSvg(regions: WireframeRegion[], width: number, height: number): string {
  const body = regions.map((r) => regionToSvg(r, 0)).join("\n");
  return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg"><rect width="${width}" height="${height}" fill="#f8fafc"/>${body}</svg>`;
}

const MOTION_PRESETS: Record<string, (durationMs: number) => string> = {
  "fade-in": (d) =>
    `@keyframes fade-in {\n  from { opacity: 0; }\n  to { opacity: 1; }\n}\n.fade-in {\n  animation: fade-in ${d}ms ease-out both;\n}`,
  "slide-up": (d) =>
    `@keyframes slide-up {\n  from { opacity: 0; transform: translateY(24px); }\n  to { opacity: 1; transform: translateY(0); }\n}\n.slide-up {\n  animation: slide-up ${d}ms cubic-bezier(0.22, 1, 0.36, 1) both;\n}`,
  "scale-in": (d) =>
    `@keyframes scale-in {\n  from { opacity: 0; transform: scale(0.92); }\n  to { opacity: 1; transform: scale(1); }\n}\n.scale-in {\n  animation: scale-in ${d}ms cubic-bezier(0.22, 1, 0.36, 1) both;\n}`,
  "stagger-reveal": (d) =>
    `@keyframes stagger-reveal {\n  from { opacity: 0; transform: translateY(16px); }\n  to { opacity: 1; transform: translateY(0); }\n}\n.stagger-reveal > * {\n  animation: stagger-reveal ${d}ms ease-out both;\n}\n.stagger-reveal > *:nth-child(1) { animation-delay: 0ms; }\n.stagger-reveal > *:nth-child(2) { animation-delay: 80ms; }\n.stagger-reveal > *:nth-child(3) { animation-delay: 160ms; }\n.stagger-reveal > *:nth-child(4) { animation-delay: 240ms; }`,
  "scroll-reveal": () =>
    `.scroll-reveal {\n  animation: fade-in linear both;\n  animation-timeline: view();\n  animation-range: entry 0% cover 30%;\n}\n@keyframes fade-in {\n  from { opacity: 0; transform: translateY(24px); }\n  to { opacity: 1; transform: translateY(0); }\n}\n/* Native CSS Scroll-Driven Animations -- no JS, per 2026 platform-first guidance. */`,
};

/**
 * Builds a real, working exploded-view scroll animation (e.g. "phone
 * disassembles as you scroll") using native CSS Scroll-Driven Animations
 * (animation-timeline: scroll()) -- per DESIGN_SYSTEM.md's own 2026
 * guidance to default to the platform before reaching for a JS library.
 * No GSAP/JS dependency: pure CSS, works in a single self-contained HTML
 * document Claude can render directly via its Visualizer.
 */
function buildScrollSequenceHtml(params: {
  pieces: {
    name: string;
    color: string;
    startX: number;
    startY: number;
    endX: number;
    endY: number;
    endRotate: number;
  }[];
  title: string;
}): string {
  const pieceDivs = params.pieces
    .map(
      (p, i) =>
        `<div class="piece piece-${i}" style="--start-x:${p.startX}px;--start-y:${p.startY}px;--end-x:${p.endX}px;--end-y:${p.endY}px;--end-rot:${p.endRotate}deg;background:${p.color};">${p.name}</div>`,
    )
    .join("\n");
  const pieceCss = params.pieces
    .map(
      (_p, i) => `.piece-${i} {
  animation: explode-${i} linear both;
  animation-timeline: scroll(root block);
  animation-range: 0% 100%;
}
@keyframes explode-${i} {
  from { transform: translate(var(--start-x), var(--start-y)) rotate(0deg); }
  to { transform: translate(var(--end-x), var(--end-y)) rotate(var(--end-rot)); }
}`,
    )
    .join("\n");
  return `<div style="height:300vh; position:relative;">
  <div style="position:sticky; top:0; height:100vh; display:flex; align-items:center; justify-content:center; overflow:hidden; background:#0f172a;">
    <h2 style="position:absolute; top:24px; color:#e2e8f0; font-family:sans-serif; font-size:14px; opacity:0.7;">${params.title} -- scroll to disassemble</h2>
    <div style="position:relative; width:200px; height:400px;">
      ${pieceDivs}
    </div>
  </div>
  <style>
    .piece { position:absolute; inset:0; border-radius:12px; display:flex; align-items:center; justify-content:center; color:white; font-family:sans-serif; font-size:12px; opacity:0.95; }
    ${pieceCss}
  </style>
</div>`;
}

const EXPLODED_TEMPLATES: Record<
  string,
  () => {
    name: string;
    color: string;
    startX: number;
    startY: number;
    endX: number;
    endY: number;
    endRotate: number;
  }[]
> = {
  phone: () => [
    { name: "Screen", color: "#1e293b", startX: 0, startY: 0, endX: 0, endY: -160, endRotate: -8 },
    { name: "Battery", color: "#334155", startX: 0, startY: 0, endX: -140, endY: 0, endRotate: 12 },
    {
      name: "Logic Board",
      color: "#475569",
      startX: 0,
      startY: 0,
      endX: 140,
      endY: 0,
      endRotate: -12,
    },
    {
      name: "Camera Module",
      color: "#64748b",
      startX: 0,
      startY: 0,
      endX: -90,
      endY: 160,
      endRotate: 20,
    },
    {
      name: "Back Case",
      color: "#94a3b8",
      startX: 0,
      startY: 0,
      endX: 90,
      endY: 160,
      endRotate: -20,
    },
  ],
  laptop: () => [
    {
      name: "Display",
      color: "#1e293b",
      startX: 0,
      startY: 0,
      endX: 0,
      endY: -180,
      endRotate: -15,
    },
    { name: "Keyboard", color: "#334155", startX: 0, startY: 0, endX: 0, endY: -40, endRotate: 0 },
    { name: "Trackpad", color: "#475569", startX: 0, startY: 0, endX: 0, endY: 60, endRotate: 0 },
    {
      name: "Battery",
      color: "#64748b",
      startX: 0,
      startY: 0,
      endX: -150,
      endY: 40,
      endRotate: 10,
    },
    {
      name: "Chassis",
      color: "#94a3b8",
      startX: 0,
      startY: 0,
      endX: 150,
      endY: 40,
      endRotate: -10,
    },
  ],
  watch: () => [
    { name: "Face", color: "#1e293b", startX: 0, startY: 0, endX: 0, endY: -140, endRotate: -10 },
    { name: "Battery", color: "#334155", startX: 0, startY: 0, endX: -100, endY: 0, endRotate: 8 },
    { name: "Sensors", color: "#475569", startX: 0, startY: 0, endX: 100, endY: 0, endRotate: -8 },
    { name: "Band", color: "#94a3b8", startX: 0, startY: 0, endX: 0, endY: 140, endRotate: 0 },
  ],
};

export const designSystemAdapter = defineAdapter({
  service: "design-system",
  label: "Design System",
  description:
    "Generates wireframe layouts, CSS motion specs, and design tokens as structured data for Claude to render inline.",
  status: "supported",
  statusNote:
    "Pure code generation -- no external API, no configuration needed. Grounded in DESIGN_SYSTEM.md's researched 2026 conventions.",
  docsUrl: "https://developer.mozilla.org/en-US/docs/Web/CSS/animation-timeline",
  requiresGoogleAuth: false,
  capabilities: [
    defineCapability({
      id: "design_system.generate_wireframe",
      title: "Generate a wireframe layout",
      description:
        "Generates a labeled-region wireframe as SVG for a landing page, dashboard, or form layout, at a given canvas size.",
      implementation: "google-rest-api",
      scopes: [],
      input: z.object({
        layout: z.enum(["landing", "dashboard", "form"]),
        width: z.number().int().min(200).max(2000).default(1200),
        height: z.number().int().min(200).max(2000).default(800),
      }),
      run: async (_ctx, input) => {
        const buildLayout = LAYOUT_TEMPLATES[input.layout];
        if (!buildLayout) throw new Error(`Unknown layout: ${input.layout}`);
        const regions = buildLayout(input.width, input.height);
        return {
          regions,
          svg: buildWireframeSvg(regions, input.width, input.height),
        };
      },
    }),
    defineCapability({
      id: "design_system.generate_motion_spec",
      title: "Generate a motion spec",
      description:
        "Generates a real CSS @keyframes animation for a named preset (fade-in, slide-up, scale-in, stagger-reveal, scroll-reveal), following 2026 CSS-first motion guidance (native scroll-driven animations preferred over JS where possible).",
      implementation: "google-rest-api",
      scopes: [],
      input: z.object({
        preset: z.enum(["fade-in", "slide-up", "scale-in", "stagger-reveal", "scroll-reveal"]),
        durationMs: z.number().int().min(50).max(5000).default(400),
      }),
      run: async (_ctx, input) => {
        const buildCss = MOTION_PRESETS[input.preset];
        if (!buildCss) throw new Error(`Unknown preset: ${input.preset}`);
        return {
          preset: input.preset,
          css: buildCss(input.durationMs),
        };
      },
    }),
    defineCapability({
      id: "design_system.generate_tokens",
      title: "Generate design tokens",
      description:
        "Returns a real design token set (type scale, spacing scale, and a generated color ramp from a single brand color) as CSS custom properties and JSON.",
      implementation: "google-rest-api",
      scopes: [],
      input: z.object({
        brandColorHex: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/, "Must be a 6-digit hex color like #3b82f6"),
      }),
      run: async (_ctx, input) => {
        const hex = input.brandColorHex.replace("#", "");
        const r = parseInt(hex.slice(0, 2), 16);
        const g = parseInt(hex.slice(2, 4), 16);
        const b = parseInt(hex.slice(4, 6), 16);
        const ramp: Record<string, string> = {};
        // Simple lightness ramp (mix toward white/black) -- not perceptual
        // LCH interpolation, but real, deterministic, and good enough for
        // a starting token set the user/Claude can refine visually.
        const steps = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900];
        for (const step of steps) {
          const t = step <= 500 ? (500 - step) / 500 : -(step - 500) / 400;
          const mix = (channel: number) =>
            Math.round(t >= 0 ? channel + (255 - channel) * t : channel * (1 + t));
          const clamp = (n: number) => Math.max(0, Math.min(255, n));
          const rr = clamp(mix(r)).toString(16).padStart(2, "0");
          const gg = clamp(mix(g)).toString(16).padStart(2, "0");
          const bb = clamp(mix(b)).toString(16).padStart(2, "0");
          ramp[step] = `#${rr}${gg}${bb}`;
        }
        const cssVars = [
          ...Object.entries(typeScale).map(([k, v]) => `  --font-size-${k}: ${v};`),
          ...Object.entries(spacingScale).map(([k, v]) => `  --space-${k}: ${v};`),
          ...Object.entries(ramp).map(([k, v]) => `  --color-brand-${k}: ${v};`),
        ].join("\n");
        return {
          typeScale,
          spacingScale,
          colorRamp: ramp,
          css: `:root {\n${cssVars}\n}`,
        };
      },
    }),
    defineCapability({
      id: "design_system.generate_scroll_sequence",
      title: "Generate a scroll-driven exploded-view animation",
      description:
        "Generates a real, working HTML/CSS scroll sequence where an object's parts fly apart as the page scrolls (e.g. a phone disassembling) -- pure CSS Scroll-Driven Animations, no JS library, ready to render directly.",
      implementation: "google-rest-api",
      scopes: [],
      input: z.object({
        object: z.enum(["phone", "laptop", "watch"]),
        title: z.string().default("Product teardown"),
      }),
      run: async (_ctx, input) => {
        const buildPieces = EXPLODED_TEMPLATES[input.object];
        if (!buildPieces) throw new Error(`Unknown object: ${input.object}`);
        const pieces = buildPieces();
        return {
          pieces,
          html: buildScrollSequenceHtml({ pieces, title: input.title }),
        };
      },
    }),
  ],
});

export default designSystemAdapter;
