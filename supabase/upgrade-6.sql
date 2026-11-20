-- BoltedBid upgrade 6: contractors upload their own contract (PDF) for customers to sign.
-- Run once in Supabase: SQL Editor > New query > paste > Run.
-- Run upgrade-3.sql, upgrade-4.sql and upgrade-5.sql first if you haven't. Safe to run more than once; your data is kept.

-- Which contract a company uses: 'upload' (its own PDF) or 'builtin' (the Massachusetts and Rhode Island template).
-- Companies that already had contracts turned on keep the built-in template until you switch.
do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'companies' and column_name = 'contract_mode') then
    alter table public.companies add column contract_mode text;
    update public.companies set contract_mode = case when contract_enabled then 'builtin' else 'upload' end;
    alter table public.companies alter column contract_mode set default 'upload';
  end if;
end $$;

alter table public.companies add column if not exists contract_file_url text;
alter table public.companies add column if not exists contract_file_name text;
alter table public.companies add column if not exists contract_file_pages int;
alter table public.companies add column if not exists contract_file_size int;
alter table public.companies add column if not exists contract_file_sha256 text;
alter table public.companies add column if not exists contract_file_uploaded_at timestamptz;

-- Contract storage: PDFs only, up to 10 MB, in a folder per user.
-- Anyone with the exact link can read a contract, which is how your customer sees it.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('contracts', 'contracts', true, 10485760, array['application/pdf'])
on conflict (id) do update set public = true, file_size_limit = 10485760, allowed_mime_types = array['application/pdf'];

drop policy if exists "boltedbid contracts upload" on storage.objects;
drop policy if exists "boltedbid contracts delete" on storage.objects;
create policy "boltedbid contracts upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'contracts' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "boltedbid contracts delete" on storage.objects for delete to authenticated
  using (bucket_id = 'contracts' and (storage.foldername(name))[1] = auth.uid()::text);
