create or replace function public.vault_upsert_google_tokens(
  p_user_id uuid,
  p_access_token text,
  p_refresh_token text default null,
  p_expires_at timestamptz default null
)
returns text
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  secret_name text := 'google-oauth-tokens:' || p_user_id::text;
  secret_id uuid;
  existing_secret text;
  existing_payload jsonb := '{}'::jsonb;
  payload jsonb;
begin
  select id into secret_id
    from vault.secrets
    where name = secret_name
    limit 1;

  if secret_id is not null then
    select decrypted_secret into existing_secret
      from vault.decrypted_secrets
      where name = secret_name
      limit 1;
    if existing_secret is not null then
      begin
        existing_payload := existing_secret::jsonb;
      exception when others then
        existing_payload := '{}'::jsonb;
      end;
    end if;
  end if;

  payload := jsonb_build_object(
    'access_token', p_access_token,
    'refresh_token', coalesce(p_refresh_token, existing_payload->>'refresh_token'),
    'expires_at', p_expires_at
  );

  if secret_id is null then
    perform vault.create_secret(
      payload::text,
      secret_name,
      'Google OAuth tokens for Nexus user ' || p_user_id::text
    );
  else
    perform vault.update_secret(
      secret_id,
      payload::text,
      secret_name,
      'Google OAuth tokens for Nexus user ' || p_user_id::text
    );
  end if;

  return secret_name;
end;
$$;

create or replace function public.vault_read_google_tokens(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  secret_name text := 'google-oauth-tokens:' || p_user_id::text;
  secret_value text;
begin
  select decrypted_secret into secret_value
    from vault.decrypted_secrets
    where name = secret_name
    limit 1;
  if secret_value is null then
    return null;
  end if;
  return secret_value::jsonb;
exception when others then
  return null;
end;
$$;

create or replace function public.vault_delete_google_tokens(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  secret_name text := 'google-oauth-tokens:' || p_user_id::text;
begin
  delete from vault.secrets where name = secret_name;
end;
$$;

revoke all on function public.vault_upsert_google_tokens(uuid, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.vault_read_google_tokens(uuid) from public, anon, authenticated;
revoke all on function public.vault_delete_google_tokens(uuid) from public, anon, authenticated;
grant execute on function public.vault_upsert_google_tokens(uuid, text, text, timestamptz) to service_role;
grant execute on function public.vault_read_google_tokens(uuid) to service_role;
grant execute on function public.vault_delete_google_tokens(uuid) to service_role;