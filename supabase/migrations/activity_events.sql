-- Live "Claude is doing X right now" activity feed, distinct from
-- operation_logs (a permanent audit trail). Reconstructed from
-- router.server.ts's actual usage (startActivityEvent/finishActivityEvent)
-- after finding this table did not actually exist on the live project --
-- the change that introduced it was never tracked as a migration file.
create table if not exists public.activity_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  capability_id text not null,
  service text not null,
  title text not null,
  actor text not null default 'web',
  status text not null default 'running' check (status in ('running', 'done', 'error')),
  detail text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

alter table public.activity_events enable row level security;

create policy "Users can read their own activity events"
  on public.activity_events
  for select
  to authenticated
  using (auth.uid() = user_id);

create index if not exists activity_events_user_created_idx
  on public.activity_events (user_id, created_at desc);
