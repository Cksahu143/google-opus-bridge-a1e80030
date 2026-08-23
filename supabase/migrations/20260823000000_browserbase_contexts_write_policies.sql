-- browserbase_contexts already had an owner-only SELECT policy but was
-- missing insert/update/delete, leaving RLS closed-by-default for writes.
-- The edge function itself uses the service-role key (bypasses RLS
-- either way), but any direct client-side access needs these to work at
-- all, and their absence is the kind of gap that's easy to miss until
-- something breaks in production.

create policy "Users can insert their own browserbase contexts"
  on public.browserbase_contexts for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own browserbase contexts"
  on public.browserbase_contexts for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete their own browserbase contexts"
  on public.browserbase_contexts for delete
  using (auth.uid() = user_id);
