-- BoltedBid upgrade 8: Team time clock. Employees punch in and out; you approve them, see hours and export timesheets.
-- Run once in Supabase: SQL Editor > New query > paste > Run.
-- Run upgrade-7.sql first if you haven't. Safe to run more than once; your data is kept.

-- ---------- Join code: employees use it to join a company ----------
alter table public.companies add column if not exists join_code text;
create unique index if not exists companies_join_code_key on public.companies (upper(join_code));

create or replace function public.new_join_code()
returns text language plpgsql as $$
declare c text; alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
begin
  loop
    c := '';
    for i in 1..8 loop c := c || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1); end loop;
    c := substr(c, 1, 4) || '-' || substr(c, 5, 4);
    exit when not exists (select 1 from public.companies where upper(join_code) = c);
  end loop;
  return c;
end;
$$;
update public.companies set join_code = public.new_join_code() where join_code is null;

-- New companies get a code automatically.
create or replace function public.company_join_code()
returns trigger language plpgsql as $$
begin
  if new.join_code is null or new.join_code = '' then new.join_code := public.new_join_code(); end if;
  return new;
end;
$$;
drop trigger if exists company_join_code on public.companies;
create trigger company_join_code before insert on public.companies for each row execute function public.company_join_code();

-- You make a new code (the old one stops working).
create or replace function public.regenerate_join_code(p_company uuid)
returns text language plpgsql security definer set search_path = public as $$
declare c text;
begin
  c := public.new_join_code();
  update public.companies set join_code = c where id = p_company and owner = auth.uid();
  if not found then raise exception 'Company not found'; end if;
  return c;
end;
$$;

-- ---------- Employees ----------
create table if not exists public.employees (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users on delete cascade,          -- the contractor
  company_id uuid not null references public.companies on delete cascade,
  user_id uuid not null references auth.users on delete cascade,        -- the employee's login
  full_name text,
  phone text,
  email text,
  status text not null default 'pending',                               -- pending | active | removed
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (company_id, user_id)
);
alter table public.employees enable row level security;
drop policy if exists "owner all" on public.employees;
drop policy if exists "employee self" on public.employees;
create policy "owner all" on public.employees for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
create policy "employee self" on public.employees for select to authenticated using (user_id = auth.uid());

-- Hourly pay: only the contractor can see it.
create table if not exists public.employee_pay (
  employee_id uuid primary key references public.employees on delete cascade,
  owner uuid not null default auth.uid() references auth.users on delete cascade,
  hourly_rate numeric(10,2),
  created_at timestamptz not null default now()
);
alter table public.employee_pay enable row level security;
drop policy if exists "owner all" on public.employee_pay;
create policy "owner all" on public.employee_pay for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());

-- ---------- Punches ----------
create table if not exists public.time_entries (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users on delete cascade,
  company_id uuid not null references public.companies on delete cascade,
  employee_id uuid not null references public.employees on delete cascade,
  user_id uuid references auth.users on delete set null,
  job_id uuid references public.jobs on delete set null,
  clock_in timestamptz not null,
  clock_out timestamptz,
  in_lat double precision, in_lng double precision, in_acc double precision,
  out_lat double precision, out_lng double precision, out_acc double precision,
  note text,
  source text not null default 'employee',      -- employee (punched on their phone) or owner (added by you)
  edited_at timestamptz,
  edit_note text,
  created_at timestamptz not null default now(),
  check (clock_out is null or clock_out > clock_in)
);
create index if not exists time_entries_company_in on public.time_entries (company_id, clock_in);
create index if not exists time_entries_employee_in on public.time_entries (employee_id, clock_in);
alter table public.time_entries enable row level security;
drop policy if exists "owner all" on public.time_entries;
drop policy if exists "employee read" on public.time_entries;
create policy "owner all" on public.time_entries for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
create policy "employee read" on public.time_entries for select to authenticated using (user_id = auth.uid());

-- ---------- Employee logins don't become BoltedBid subscriber accounts ----------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(new.raw_user_meta_data->>'role', '') = 'employee' then return new; end if;
  insert into public.accounts (user_id, email, full_name, company_name, plan)
  values (new.id, new.email,
          nullif(new.raw_user_meta_data->>'full_name', ''),
          nullif(new.raw_user_meta_data->>'company_name', ''),
          case when new.raw_user_meta_data->>'plan' = 'yearly' then 'yearly' else 'monthly' end)
  on conflict (user_id) do nothing;
  return new;
end;
$$;
delete from public.accounts a using auth.users u where u.id = a.user_id and u.raw_user_meta_data->>'role' = 'employee';

-- Does a given contractor's account have access? (Their employees can punch in only while it does.)
create or replace function public.owner_has_access(p_owner uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = p_owner) or exists (
    select 1 from public.accounts a where a.user_id = p_owner and (
      a.status = 'comped'
      or (a.status = 'trial' and a.trial_ends >= current_date)
      or (a.status in ('active', 'past_due') and (a.paid_through is null or a.paid_through + 3 >= current_date))
    )
  );
$$;

-- ---------- What the employee app can do ----------
-- Join a company with its code. You approve them before they can punch in.
create or replace function public.join_company(p_code text, p_name text, p_phone text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c public.companies; e public.employees; u auth.users;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  select * into c from public.companies where upper(join_code) = upper(trim(p_code));
  if not found then raise exception 'That code doesn''t match any company. Check it with your employer.'; end if;
  select * into u from auth.users where id = auth.uid();
  insert into public.employees (owner, company_id, user_id, full_name, phone, email)
  values (c.owner, c.id, auth.uid(), left(nullif(trim(p_name), ''), 120), left(nullif(trim(p_phone), ''), 40), u.email)
  on conflict (company_id, user_id) do update set
    full_name = coalesce(excluded.full_name, public.employees.full_name),
    phone = coalesce(excluded.phone, public.employees.phone),
    status = case when public.employees.status = 'removed' then 'pending' else public.employees.status end
  returning * into e;
  return jsonb_build_object('company', c.name, 'status', e.status);
end;
$$;

-- Everything the employee screen needs in one call.
create or replace function public.my_team()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare e public.employees; c public.companies; open_e public.time_entries;
begin
  select * into e from public.employees where user_id = auth.uid() order by (status = 'active') desc, created_at desc limit 1;
  if not found then return jsonb_build_object('joined', false); end if;
  select * into c from public.companies where id = e.company_id;
  select * into open_e from public.time_entries where employee_id = e.id and clock_out is null order by clock_in desc limit 1;
  return jsonb_build_object(
    'joined', true,
    'employee', jsonb_build_object('id', e.id, 'name', e.full_name, 'status', e.status),
    'company', jsonb_build_object('name', c.name, 'logo', c.logo, 'color', c.color),
    'company_active', public.owner_has_access(e.owner),
    'open', case when open_e.id is null then null else to_jsonb(open_e) end,
    'jobs', coalesce((select jsonb_agg(jsonb_build_object('id', j.id, 'name', j.name, 'address', j.address) order by j.name)
                      from public.jobs j where j.company_id = e.company_id and j.status in ('active', 'estimating', 'on_hold')), '[]'::jsonb)
  );
end;
$$;

create or replace function public.punch_in(p_job uuid default null, p_lat double precision default null, p_lng double precision default null, p_acc double precision default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare e public.employees; t public.time_entries;
begin
  select * into e from public.employees where user_id = auth.uid() and status = 'active' order by created_at desc limit 1;
  if not found then raise exception 'Your employer hasn''t approved you yet.'; end if;
  if not public.owner_has_access(e.owner) then raise exception 'Punching in is paused for this company. Please tell your employer.'; end if;
  if exists (select 1 from public.time_entries where employee_id = e.id and clock_out is null) then raise exception 'You''re already punched in.'; end if;
  if p_job is not null and not exists (select 1 from public.jobs where id = p_job and company_id = e.company_id) then p_job := null; end if;
  insert into public.time_entries (owner, company_id, employee_id, user_id, job_id, clock_in, in_lat, in_lng, in_acc)
  values (e.owner, e.company_id, e.id, auth.uid(), p_job, now(), p_lat, p_lng, p_acc)
  returning * into t;
  return to_jsonb(t);
end;
$$;

create or replace function public.punch_out(p_lat double precision default null, p_lng double precision default null, p_acc double precision default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare e public.employees; t public.time_entries;
begin
  select * into e from public.employees where user_id = auth.uid() and status = 'active' order by created_at desc limit 1;
  if not found then raise exception 'Your employer hasn''t approved you yet.'; end if;
  update public.time_entries set clock_out = greatest(now(), clock_in + interval '1 second'), out_lat = p_lat, out_lng = p_lng, out_acc = p_acc,
    note = coalesce(left(nullif(trim(p_note), ''), 500), note)
    where id = (select id from public.time_entries where employee_id = e.id and clock_out is null order by clock_in desc limit 1)
    returning * into t;
  if t.id is null then raise exception 'You''re not punched in.'; end if;
  return to_jsonb(t);
end;
$$;

revoke all on function public.join_company(text, text, text) from public;
revoke all on function public.my_team() from public;
revoke all on function public.punch_in(uuid, double precision, double precision, double precision) from public;
revoke all on function public.punch_out(double precision, double precision, double precision, text) from public;
revoke all on function public.regenerate_join_code(uuid) from public;
grant execute on function public.join_company(text, text, text) to authenticated;
grant execute on function public.my_team() to authenticated;
grant execute on function public.punch_in(uuid, double precision, double precision, double precision) to authenticated;
grant execute on function public.punch_out(double precision, double precision, double precision, text) to authenticated;
grant execute on function public.regenerate_join_code(uuid) to authenticated;
