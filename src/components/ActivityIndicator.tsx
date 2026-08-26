import { useEffect, useState } from "react";

import { supabase } from "@/integrations/supabase/client";

// Shows, in real time, when Claude (or this app's own dashboard buttons)
// is running a Nexus capability -- backed by the activity_events table,
// written by runCapability in router.server.ts. Subscribes via Supabase
// Realtime's postgres_changes rather than polling, so it reflects the
// actual start/finish moments, not a sampled approximation.
//
// Deliberately CSS-only for the pulse animation (transform/opacity via a
// keyframe, respecting prefers-reduced-motion) rather than a JS animation
// library -- see DESIGN_SYSTEM.md's decision framework: this is exactly
// the "simple, decorative" case native CSS covers, no GSAP needed.

interface ActivityEventRow {
  id: string;
  capability_id: string;
  service: string;
  title: string;
  actor: string;
  status: "running" | "done" | "error";
  detail: string | null;
  started_at: string;
  finished_at: string | null;
}

const FADE_OUT_AFTER_MS = 3_000;

export function ActivityIndicator() {
  const [event, setEvent] = useState<ActivityEventRow | null>(null);

  useEffect(() => {
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let fadeTimeout: ReturnType<typeof setTimeout> | null = null;

    supabase.auth.getUser().then(({ data }) => {
      const userId = data.user?.id;
      if (!userId) return;

      channel = supabase
        .channel(`activity-events-${userId}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "activity_events", filter: `user_id=eq.${userId}` },
          (payload) => {
            const row = (payload.new ?? payload.old) as ActivityEventRow | undefined;
            if (!row) return;
            setEvent(row);
            if (fadeTimeout) clearTimeout(fadeTimeout);
            if (row.status !== "running") {
              fadeTimeout = setTimeout(() => setEvent(null), FADE_OUT_AFTER_MS);
            }
          },
        )
        .subscribe();
    });

    return () => {
      if (fadeTimeout) clearTimeout(fadeTimeout);
      if (channel) supabase.removeChannel(channel);
    };
  }, []);

  if (!event) return null;

  const label =
    event.status === "running"
      ? `Claude is running: ${event.title}`
      : event.status === "done"
        ? `Done: ${event.title}`
        : `Failed: ${event.title}`;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-full border border-border bg-background/95 px-4 py-2 text-sm shadow-lg backdrop-blur"
      style={{
        opacity: 0,
        animation: "activity-indicator-in 200ms ease-out forwards",
      }}
    >
      <span
        className={
          event.status === "running"
            ? "h-2 w-2 shrink-0 rounded-full bg-primary"
            : event.status === "done"
              ? "h-2 w-2 shrink-0 rounded-full bg-green-500"
              : "h-2 w-2 shrink-0 rounded-full bg-destructive"
        }
        style={event.status === "running" ? { animation: "activity-indicator-pulse 1.4s ease-in-out infinite" } : undefined}
      />
      <span className="max-w-[240px] truncate text-foreground">{label}</span>
      <style>{`
        @keyframes activity-indicator-in {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes activity-indicator-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.4; transform: scale(1.3); }
        }
        @media (prefers-reduced-motion: reduce) {
          [role="status"] { animation: none !important; }
          [role="status"] * { animation: none !important; }
        }
      `}</style>
    </div>
  );
}

export default ActivityIndicator;
