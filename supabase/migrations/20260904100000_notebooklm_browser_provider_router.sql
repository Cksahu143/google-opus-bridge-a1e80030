alter table public.notebooklm_browser_sessions
  drop constraint if exists notebooklm_browser_sessions_provider_check;

alter table public.notebooklm_browser_sessions
  add constraint notebooklm_browser_sessions_provider_check
  check (provider in ('browserless', 'browserbase', 'steel', 'cloudflare'));
