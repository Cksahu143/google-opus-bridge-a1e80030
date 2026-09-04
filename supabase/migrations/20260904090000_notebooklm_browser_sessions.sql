create table if not exists public.notebooklm_browser_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('browserless', 'steel')),
  provider_session_id text not null,
  browserql_url text,
  stop_url text,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists notebooklm_browser_sessions_user_provider_idx
  on public.notebooklm_browser_sessions(user_id, provider);

alter table public.notebooklm_browser_sessions enable row level security;

revoke all on public.notebooklm_browser_sessions from anon, authenticated;
grant all on public.notebooklm_browser_sessions to service_role;

create index if not exists notebooklm_browser_sessions_expires_idx
  on public.notebooklm_browser_sessions(expires_at);
