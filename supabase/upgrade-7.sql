-- BoltedBid upgrade 7: accounts, free trials, plans, discounts and the admin panel.
-- Run once in Supabase: SQL Editor > New query > paste > Run.
-- Run upgrade-6.sql first if you haven't. Safe to run more than once; your data is kept.
--
-- AFTER running this file, make yourself the admin (see the instructions you were given):
--   insert into public.admins (user_id) select id from auth.users where email = 'YOUR EMAIL HERE'
--   on conflict do nothing;

-- ---------- Who is an admin ----------
create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.admins enable row level security;
drop policy if exists "see self" on public.admins;
create policy "see self" on public.admins for select to authenticated using (user_id = auth.uid());

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

-- ---------- One account per sign-up ----------
-- status: trial, active (paying), comped (free, set by you), past_due, canceled, revoked
create table if not exists public.accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  company_name text,
  plan text not null default 'monthly',            -- monthly or yearly
  status text not null default 'trial',
  trial_ends date not null default (current_date + 30),
  paid_through date,                               -- access is paid up to and including this date
  discount_percent int not null default 0 check (discount_percent between 0 and 100),
  discount_note text,
  notes text,                                      -- private notes, only admins see them
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.accounts enable row level security;
drop policy if exists "own account read" on public.accounts;
drop policy if exists "admin all" on public.accounts;
create policy "own account read" on public.accounts for select to authenticated using (user_id = auth.uid() or public.is_admin());
create policy "admin all" on public.accounts for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Payments you record for subscribers (until online billing is connected).
create table if not exists public.account_payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  amount numeric(10,2) not null,
  plan text,
  period_start date,
  period_end date,
  method text,
  note text,
  paid_on date not null default current_date,
  created_at timestamptz not null default now()
);
alter table public.account_payments enable row level security;
drop policy if exists "admin all" on public.account_payments;
drop policy if exists "own read" on public.account_payments;
create policy "admin all" on public.account_payments for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "own read" on public.account_payments for select to authenticated using (user_id = auth.uid());

-- New sign-ups get an account with a 30-day trial. The plan they picked on the front page is kept.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.accounts (user_id, email, full_name, company_name, plan)
  values (new.id, new.email,
          nullif(new.raw_user_meta_data->>'full_name', ''),
          nullif(new.raw_user_meta_data->>'company_name', ''),
          case when new.raw_user_meta_data->>'plan' = 'yearly' then 'yearly' else 'monthly' end)
  on conflict (user_id) do nothing;
  return new;
end;
$$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- People who signed up before this upgrade get an account too, with a fresh 30-day trial.
insert into public.accounts (user_id, email, full_name, company_name, plan, created_at)
select u.id, u.email, nullif(u.raw_user_meta_data->>'full_name', ''), nullif(u.raw_user_meta_data->>'company_name', ''),
       case when u.raw_user_meta_data->>'plan' = 'yearly' then 'yearly' else 'monthly' end, u.created_at
from auth.users u
on conflict (user_id) do nothing;

-- ---------- Can this account create and change things? ----------
-- Admins always can. Others: during the trial, while paid up (3 days' grace), or when comped.
create or replace function public.has_access()
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_admin() or exists (
    select 1 from public.accounts a where a.user_id = auth.uid() and (
      a.status = 'comped'
      or (a.status = 'trial' and a.trial_ends >= current_date)
      or (a.status in ('active', 'past_due') and (a.paid_through is null or a.paid_through + 3 >= current_date))
    )
  );
$$;

-- Everyone can always see and download their own data. Creating and changing it needs access.
do $$
declare t text;
begin
  foreach t in array array['companies', 'customers', 'documents', 'payments', 'items', 'photos', 'jobs'] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop policy if exists "own rows" on public.%I', t);
      execute format('drop policy if exists "own read" on public.%I', t);
      execute format('drop policy if exists "own insert" on public.%I', t);
      execute format('drop policy if exists "own update" on public.%I', t);
      execute format('drop policy if exists "own delete" on public.%I', t);
      execute format('create policy "own read" on public.%I for select to authenticated using (owner = auth.uid())', t);
      execute format('create policy "own insert" on public.%I for insert to authenticated with check (owner = auth.uid() and public.has_access())', t);
      execute format('create policy "own update" on public.%I for update to authenticated using (owner = auth.uid()) with check (owner = auth.uid() and public.has_access())', t);
      execute format('create policy "own delete" on public.%I for delete to authenticated using (owner = auth.uid() and public.has_access())', t);
    end if;
  end loop;
end $$;

-- Uploading photos and contracts needs access too.
drop policy if exists "folio photos upload" on storage.objects;
create policy "folio photos upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text and public.has_access());
drop policy if exists "boltedbid contracts upload" on storage.objects;
create policy "boltedbid contracts upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'contracts' and (storage.foldername(name))[1] = auth.uid()::text and public.has_access());

-- ---------- Admin panel data ----------
-- Every account with its last sign-in and how much it's used BoltedBid. Admins only.
create or replace function public.admin_accounts()
returns table (
  user_id uuid, email text, full_name text, company_name text, plan text, status text,
  trial_ends date, paid_through date, discount_percent int, discount_note text, notes text,
  created_at timestamptz, last_sign_in_at timestamptz, email_confirmed boolean,
  companies bigint, estimates bigint, invoices bigint, last_activity timestamptz, total_paid numeric
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  return query
  select a.user_id, coalesce(a.email, u.email)::text, a.full_name, a.company_name, a.plan, a.status,
         a.trial_ends, a.paid_through, a.discount_percent, a.discount_note, a.notes,
         a.created_at, u.last_sign_in_at, (u.email_confirmed_at is not null),
         (select count(*) from public.companies c where c.owner = a.user_id),
         (select count(*) from public.documents d where d.owner = a.user_id and d.type = 'estimate'),
         (select count(*) from public.documents d where d.owner = a.user_id and d.type = 'invoice'),
         (select max(d.created_at) from public.documents d where d.owner = a.user_id),
         (select coalesce(sum(p.amount), 0) from public.account_payments p where p.user_id = a.user_id)
  from public.accounts a left join auth.users u on u.id = a.user_id
  order by a.created_at desc;
end;
$$;
revoke all on function public.admin_accounts() from public;
grant execute on function public.admin_accounts() to authenticated;
grant execute on function public.has_access() to authenticated;
grant execute on function public.is_admin() to authenticated;
