-- Cloud sync: one copy of each user's lists, categories, schedules, limits and
-- settings (the same JSON as "Settings → Backup → Export"). Running blocks and
-- statistics are never uploaded.

create table public.backups (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  -- A backup is a few hundred KB at most (community lists aren't included,
  -- only their address), so anything far bigger isn't from OpenBlocker.
  constraint backups_data_size check (octet_length(data::text) < 2000000)
);

alter table public.backups enable row level security;

-- Signed-in users can read and write their own row, and nothing else.
create policy "Read own backup" on public.backups
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Create own backup" on public.backups
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Update own backup" on public.backups
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Delete own backup" on public.backups
  for delete to authenticated using ((select auth.uid()) = user_id);

revoke all on public.backups from anon;

-- updated_at is set by the database, not the client.
create function public.backups_touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger backups_touch before insert or update on public.backups
  for each row execute function public.backups_touch();
