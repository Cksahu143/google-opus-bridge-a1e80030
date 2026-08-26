-- Adds the missing read path for Vault secrets. vault_create_secret and
-- vault_delete_secret_by_name already existed (notebooklm_vault_setup.sql)
-- but nothing could ever read a stored secret back out — neither prior
-- NotebookLM login implementation needed to (Browserbase's Context lives
-- on their own infrastructure; the earlier notebooklm-connect draft that
-- would have stored raw cookies was abandoned before this was needed).
-- steel-login needs this to resume a previously-saved session's cookie/
-- localStorage state.
create or replace function public.vault_read_secret_by_name(secret_name text)
returns text
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  secret_value text;
begin
  select decrypted_secret into secret_value
    from vault.decrypted_secrets
    where name = secret_name
    limit 1;
  return secret_value;
end;
$$;

revoke all on function public.vault_read_secret_by_name(text) from public, authenticated, anon;
grant execute on function public.vault_read_secret_by_name(text) to service_role;
