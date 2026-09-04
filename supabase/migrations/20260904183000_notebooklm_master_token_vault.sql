-- Server-only storage for the durable NotebookLM master token.
-- The token is never exposed to browser code. Supabase Vault encrypts the
-- secret at rest with the project's managed Vault key.

create extension if not exists supabase_vault with schema vault;

create table if not exists public.notebooklm_connections (
  user_id uuid primary key references auth.users(id) on delete cascade,
  vault_secret_name text not null,
  status text not null default 'connected' check (status in ('connected', 'disconnected', 'expired')),
  connected_at timestamptz not null default now(),
  disconnected_at timestamptz,
  last_used_at timestamptz
);

alter table public.notebooklm_connections enable row level security;

drop policy if exists "Users can view their own notebooklm connection" on public.notebooklm_connections;
create policy "Users can view their own notebooklm connection"
  on public.notebooklm_connections
  for select
  using (auth.uid() = user_id);

revoke all on public.notebooklm_connections from anon;
grant select on public.notebooklm_connections to authenticated;
grant all on public.notebooklm_connections to service_role;

create or replace function public.vault_upsert_notebooklm_master_token(
  p_user_id uuid,
  p_secret text
)
returns text
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  secret_name text := 'notebooklm-master-token:' || p_user_id::text;
  secret_id uuid;
begin
  select id into secret_id
    from vault.secrets
    where name = secret_name
    limit 1;

  if secret_id is null then
    perform vault.create_secret(
      p_secret,
      secret_name,
      'NotebookLM master token for Bridge user ' || p_user_id::text
    );
  else
    perform vault.update_secret(
      secret_id,
      p_secret,
      secret_name,
      'NotebookLM master token for Bridge user ' || p_user_id::text
    );
  end if;

  insert into public.notebooklm_connections (
    user_id,
    vault_secret_name,
    status,
    connected_at,
    disconnected_at,
    last_used_at
  ) values (
    p_user_id,
    secret_name,
    'connected',
    now(),
    null,
    now()
  )
  on conflict (user_id) do update set
    vault_secret_name = excluded.vault_secret_name,
    status = 'connected',
    connected_at = excluded.connected_at,
    disconnected_at = null,
    last_used_at = now();

  return secret_name;
end;
$$;

create or replace function public.vault_read_notebooklm_master_token(
  p_user_id uuid
)
returns text
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  secret_value text;
  secret_name text := 'notebooklm-master-token:' || p_user_id::text;
begin
  select decrypted_secret into secret_value
    from vault.decrypted_secrets
    where name = secret_name
    limit 1;
  return secret_value;
end;
$$;

create or replace function public.vault_notebooklm_connection_status(
  p_user_id uuid
)
returns public.notebooklm_connections
language sql
security definer
set search_path = public
as $$
  select * from public.notebooklm_connections where user_id = p_user_id limit 1;
$$;

create or replace function public.vault_disconnect_notebooklm(
  p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  secret_name text := 'notebooklm-master-token:' || p_user_id::text;
begin
  delete from vault.secrets where name = secret_name;
  update public.notebooklm_connections
    set status = 'disconnected', disconnected_at = now()
    where user_id = p_user_id;
end;
$$;

revoke all on function public.vault_upsert_notebooklm_master_token(uuid, text) from public, anon, authenticated;
revoke all on function public.vault_read_notebooklm_master_token(uuid) from public, anon, authenticated;
revoke all on function public.vault_notebooklm_connection_status(uuid) from public, anon, authenticated;
revoke all on function public.vault_disconnect_notebooklm(uuid) from public, anon, authenticated;
grant execute on function public.vault_upsert_notebooklm_master_token(uuid, text) to service_role;
grant execute on function public.vault_read_notebooklm_master_token(uuid) to service_role;
grant execute on function public.vault_notebooklm_connection_status(uuid) to service_role;
grant execute on function public.vault_disconnect_notebooklm(uuid) to service_role;
