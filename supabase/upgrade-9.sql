-- BoltedBid upgrade 9: security hardening.
-- Run once in Supabase: SQL Editor > New query > paste > Run.
-- Run upgrade-8.sql first if you haven't. Safe to run more than once; your data is kept.
--
-- What this fixes:
--  1. Signatures sent from the customer page must be real PNG images (blocks hidden code in a "signature").
--  2. Customer links no longer reveal your team join code or other private company settings.
--  3. Every row you save must point at your own company, estimate or employee (no mixing with other accounts).
--  4. Your private admin notes about a subscriber are no longer readable by that subscriber.
--  5. Someone waiting for approval can't see your job list and addresses.
--  6. Internal helper functions can no longer be called from outside.

-- ---------- 1. Signature images: PNG only ----------
create or replace function public.is_png_data_url(p text)
returns boolean language sql immutable as $$
  select p is not null and length(p) between 100 and 600000 and p ~ '^data:image/png;base64,[A-Za-z0-9+/]+={0,2}$';
$$;

-- The company details kept with a signed contract, without private settings.
create or replace function public.public_company(c public.companies)
returns jsonb language sql stable as $$
  select to_jsonb(c) - 'owner' - 'next_invoice_no' - 'next_estimate_no' - 'next_change_order_no' - 'join_code';
$$;

create or replace function public.accept_estimate(p_token text, p_name text, p_selected int[] default null, p_signature jsonb default null)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  d public.documents;
  c public.companies;
  v_name text;
  v_ip text;
  v_sig jsonb;
  v_state text;
begin
  if p_token is null or length(p_token) < 20 then return false; end if;
  select * into d from public.documents
    where public_token = p_token and type in ('estimate', 'change_order') and status = 'sent' and archived = false;
  if not found then
    return false;
  end if;

  -- Only the "selected" flag of optional lines can change; prices and wording stay as written.
  if p_selected is not null then
    if array_length(p_selected, 1) > 500 then return false; end if;
    update public.documents set items = coalesce((
      select jsonb_agg(
        case when coalesce(e.value->>'option', '') in ('addon', 'choice')
          then e.value || jsonb_build_object('selected', (e.ordinality - 1)::int = any(p_selected))
          else e.value end
        order by e.ordinality)
      from jsonb_array_elements(d.items) with ordinality as e
    ), '[]'::jsonb)
    where id = d.id
    returning * into d;
  end if;

  v_name := left(coalesce(nullif(trim(p_name), ''), d.customer_name), 120);

  if p_signature is not null then
    if length(p_signature::text) > 1300000
       or not public.is_png_data_url(p_signature->>'image')
       or (p_signature->>'arbitration_image' is not null and not public.is_png_data_url(p_signature->>'arbitration_image')) then
      return false;
    end if;
    v_state := case when p_signature->>'state' in ('MA', 'RI') then p_signature->>'state' else null end;
    select * into c from public.companies where id = d.company_id;
    begin
      v_ip := left(split_part(coalesce(current_setting('request.headers', true)::json->>'x-forwarded-for', ''), ',', 1), 64);
    exception when others then v_ip := null;
    end;
    v_sig := jsonb_build_object(
      'name', v_name,
      'image', p_signature->>'image',
      'agreed', true,
      'no_photos', coalesce(p_signature->>'no_photos', '') = 'true',
      'arbitration_image', p_signature->>'arbitration_image',
      'arbitration_name', left(nullif(trim(p_signature->>'arbitration_name'), ''), 120),
      'state', v_state,
      'ua', left(coalesce(p_signature->>'ua', ''), 300),
      'ip', nullif(trim(v_ip), ''),
      'signed_at', now(),
      'company', public.public_company(c) - 'logo',
      'document', to_jsonb(d) - 'owner' - 'signature' - 'public_token'
    );
  end if;

  if v_sig is null and d.type = 'estimate' then
    select * into c from public.companies where id = d.company_id;
  end if;

  update public.documents
    set status = 'accepted', accepted_at = now(), accepted_by = v_name, signature = coalesce(v_sig, signature),
        contract_requested_at = case
          when v_sig is null and d.type = 'estimate' and coalesce(c.contract_enabled, false) and coalesce(c.contract_after_accept, true)
          then now() else contract_requested_at end
    where id = d.id
    returning * into d;
  insert into public.events (owner, document_id, kind, detail) values (d.owner, d.id, 'accepted', d.accepted_by);
  return true;
end;
$$;

create or replace function public.sign_contract(p_token text, p_name text, p_signature jsonb)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  d public.documents;
  c public.companies;
  v_name text;
  v_ip text;
begin
  if p_token is null or length(p_token) < 20 then return false; end if;
  select * into d from public.documents
    where public_token = p_token and type = 'estimate' and status in ('accepted', 'converted')
      and signature is null and contract_requested_at is not null and archived = false;
  if not found then
    return false;
  end if;
  if p_signature is null or length(p_signature::text) > 1300000
     or not public.is_png_data_url(p_signature->>'image')
     or (p_signature->>'arbitration_image' is not null and not public.is_png_data_url(p_signature->>'arbitration_image')) then
    return false;
  end if;

  v_name := left(coalesce(nullif(trim(p_name), ''), d.customer_name), 120);
  select * into c from public.companies where id = d.company_id;
  begin
    v_ip := left(split_part(coalesce(current_setting('request.headers', true)::json->>'x-forwarded-for', ''), ',', 1), 64);
  exception when others then v_ip := null;
  end;

  update public.documents set signature = jsonb_build_object(
      'name', v_name,
      'image', p_signature->>'image',
      'agreed', true,
      'no_photos', coalesce(p_signature->>'no_photos', '') = 'true',
      'arbitration_image', p_signature->>'arbitration_image',
      'arbitration_name', left(nullif(trim(p_signature->>'arbitration_name'), ''), 120),
      'state', case when p_signature->>'state' in ('MA', 'RI') then p_signature->>'state' else null end,
      'ua', left(coalesce(p_signature->>'ua', ''), 300),
      'ip', nullif(trim(v_ip), ''),
      'signed_at', now(),
      'company', public.public_company(c) - 'logo',
      'document', to_jsonb(d) - 'owner' - 'signature' - 'public_token'
    )
    where id = d.id;
  insert into public.events (owner, document_id, kind, detail) values (d.owner, d.id, 'signed', v_name);
  return true;
end;
$$;

-- Clean up anything already stored: drop non-PNG signature images and the join code from saved company copies.
update public.documents set signature = signature - 'image'
  where signature ? 'image' and not public.is_png_data_url(signature->>'image');
update public.documents set signature = signature - 'arbitration_image'
  where signature ? 'arbitration_image' and signature->>'arbitration_image' is not null and not public.is_png_data_url(signature->>'arbitration_image');
update public.documents set signature = signature #- '{company,join_code}' #- '{company,owner}'
  where signature ? 'company' and (signature->'company' ? 'join_code' or signature->'company' ? 'owner');

-- ---------- 2. What a customer link returns ----------
create or replace function public.get_public_document(p_token text, p_record boolean default true)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  d public.documents;
  c public.companies;
begin
  if p_token is null or length(p_token) < 20 then return null; end if;
  select * into d from public.documents where public_token = p_token and archived = false;
  if not found then
    return null;
  end if;

  if p_record and d.status <> 'draft' then
    update public.documents
      set viewed_at = coalesce(viewed_at, now()), view_count = view_count + 1
      where id = d.id
      returning * into d;
    if not exists (
      select 1 from public.events
      where document_id = d.id and kind = 'viewed' and created_at > now() - interval '30 minutes'
    ) then
      insert into public.events (owner, document_id, kind) values (d.owner, d.id, 'viewed');
    end if;
  end if;

  select * into c from public.companies where id = d.company_id and owner = d.owner;
  return json_build_object(
    'document', (to_jsonb(d) - 'owner') #- '{signature,company,join_code}' #- '{signature,company,owner}',
    'company', public.public_company(c),
    'photos', case when d.show_photos then (
      select coalesce(json_agg(json_build_object('url', p.url, 'caption', p.caption) order by p.position, p.created_at), '[]'::json)
      from public.photos p where p.document_id = d.id and p.owner = d.owner
    ) else '[]'::json end
  );
end;
$$;

-- ---------- 3. Saved rows must point at your own records ----------
do $$
declare r record;
begin
  for r in select * from (values
      ('documents',      'exists (select 1 from public.companies c where c.id = company_id and c.owner = auth.uid())'),
      ('jobs',           'company_id is null or exists (select 1 from public.companies c where c.id = company_id and c.owner = auth.uid())'),
      ('items',          'company_id is null or exists (select 1 from public.companies c where c.id = company_id and c.owner = auth.uid())'),
      ('photos',         'exists (select 1 from public.documents d where d.id = document_id and d.owner = auth.uid())'),
      ('payments',       'exists (select 1 from public.documents d where d.id = document_id and d.owner = auth.uid())'),
      ('events',         'exists (select 1 from public.documents d where d.id = document_id and d.owner = auth.uid())'),
      ('employees',      'exists (select 1 from public.companies c where c.id = company_id and c.owner = auth.uid())'),
      ('time_entries',   'exists (select 1 from public.companies c where c.id = company_id and c.owner = auth.uid()) and exists (select 1 from public.employees e where e.id = employee_id and e.owner = auth.uid() and e.company_id = time_entries.company_id)'),
      ('employee_pay',   'exists (select 1 from public.employees e where e.id = employee_id and e.owner = auth.uid())')
    ) as t(tbl, chk)
  loop
    if to_regclass('public.' || r.tbl) is not null then
      execute format('drop policy if exists "own refs insert" on public.%I', r.tbl);
      execute format('drop policy if exists "own refs update" on public.%I', r.tbl);
      execute format('create policy "own refs insert" on public.%I as restrictive for insert to authenticated with check (%s)', r.tbl, r.chk);
      execute format('create policy "own refs update" on public.%I as restrictive for update to authenticated using (true) with check (%s)', r.tbl, r.chk);
    end if;
  end loop;
end $$;

-- ---------- 4. Private admin notes in their own table ----------
create table if not exists public.account_notes (
  user_id uuid primary key references auth.users(id) on delete cascade,
  notes text,
  updated_at timestamptz not null default now()
);
alter table public.account_notes enable row level security;
drop policy if exists "admin all" on public.account_notes;
create policy "admin all" on public.account_notes for all to authenticated using (public.is_admin()) with check (public.is_admin());

do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'accounts' and column_name = 'notes') then
    insert into public.account_notes (user_id, notes)
      select user_id, notes from public.accounts where nullif(trim(notes), '') is not null
      on conflict (user_id) do update set notes = excluded.notes;
  end if;
end $$;

drop function if exists public.admin_accounts();
alter table public.accounts drop column if exists notes;

create function public.admin_accounts()
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
         a.trial_ends, a.paid_through, a.discount_percent, a.discount_note, n.notes,
         a.created_at, u.last_sign_in_at, (u.email_confirmed_at is not null),
         (select count(*) from public.companies c where c.owner = a.user_id),
         (select count(*) from public.documents d where d.owner = a.user_id and d.type = 'estimate'),
         (select count(*) from public.documents d where d.owner = a.user_id and d.type = 'invoice'),
         (select max(d.created_at) from public.documents d where d.owner = a.user_id),
         (select coalesce(sum(p.amount), 0) from public.account_payments p where p.user_id = a.user_id)
  from public.accounts a
  left join auth.users u on u.id = a.user_id
  left join public.account_notes n on n.user_id = a.user_id
  order by a.created_at desc;
end;
$$;

-- ---------- 5. Pending employees don't see your jobs ----------
create or replace function public.my_team()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare e public.employees; c public.companies; open_e public.time_entries;
begin
  select * into e from public.employees where user_id = auth.uid() order by (status = 'active') desc, created_at desc limit 1;
  if not found then return jsonb_build_object('joined', false); end if;
  select * into c from public.companies where id = e.company_id;
  if e.status <> 'active' then
    return jsonb_build_object('joined', true,
      'employee', jsonb_build_object('id', e.id, 'name', e.full_name, 'status', e.status),
      'company', jsonb_build_object('name', c.name), 'company_active', false, 'open', null, 'jobs', '[]'::jsonb);
  end if;
  select * into open_e from public.time_entries where employee_id = e.id and clock_out is null order by clock_in desc limit 1;
  return jsonb_build_object(
    'joined', true,
    'employee', jsonb_build_object('id', e.id, 'name', e.full_name, 'status', e.status),
    'company', jsonb_build_object('name', c.name, 'logo', c.logo, 'color', c.color),
    'company_active', public.owner_has_access(e.owner),
    'open', case when open_e.id is null then null else to_jsonb(open_e) - 'owner' end,
    'jobs', coalesce((select jsonb_agg(jsonb_build_object('id', j.id, 'name', j.name, 'address', j.address) order by j.name)
                      from public.jobs j where j.company_id = e.company_id and j.status in ('active', 'estimating', 'on_hold')), '[]'::jsonb)
  );
end;
$$;

-- Employees can't keep re-joining with an old code after you remove them.
create or replace function public.join_company(p_code text, p_name text, p_phone text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c public.companies; e public.employees; u auth.users;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if p_code is null or length(trim(p_code)) > 20 then raise exception 'That code doesn''t match any company. Check it with your employer.'; end if;
  select * into c from public.companies where upper(join_code) = upper(trim(p_code));
  if not found then raise exception 'That code doesn''t match any company. Check it with your employer.'; end if;
  select * into u from auth.users where id = auth.uid();
  insert into public.employees (owner, company_id, user_id, full_name, phone, email)
  values (c.owner, c.id, auth.uid(), left(nullif(trim(p_name), ''), 120), left(nullif(trim(p_phone), ''), 40), u.email)
  on conflict (company_id, user_id) do update set
    full_name = coalesce(excluded.full_name, public.employees.full_name),
    phone = coalesce(excluded.phone, public.employees.phone)
  returning * into e;
  return jsonb_build_object('company', c.name, 'status', e.status);
end;
$$;

-- ---------- 6. Who can call which function ----------
-- Supabase lets the public "anon" role call functions unless told otherwise. Close the internal ones.
do $$
declare f text;
begin
  foreach f in array array[
    'public.owner_has_access(uuid)', 'public.new_join_code()', 'public.handle_new_user()', 'public.company_join_code()',
    'public.is_png_data_url(text)', 'public.public_company(public.companies)'
  ] loop
    begin execute format('revoke all on function %s from public, anon, authenticated', f); exception when undefined_function then null; end;
  end loop;
  foreach f in array array[
    'public.is_admin()', 'public.has_access()', 'public.admin_accounts()', 'public.regenerate_join_code(uuid)',
    'public.join_company(text, text, text)', 'public.my_team()',
    'public.punch_in(uuid, double precision, double precision, double precision)',
    'public.punch_out(double precision, double precision, double precision, text)'
  ] loop
    begin
      execute format('revoke all on function %s from public, anon', f);
      execute format('grant execute on function %s to authenticated', f);
    exception when undefined_function then null; end;
  end loop;
  -- The customer page works without signing in, by design.
  foreach f in array array['public.get_public_document(text, boolean)', 'public.accept_estimate(text, text, integer[], jsonb)', 'public.sign_contract(text, text, jsonb)'] loop
    begin
      execute format('revoke all on function %s from public', f);
      execute format('grant execute on function %s to anon, authenticated', f);
    exception when undefined_function then null; end;
  end loop;
end $$;
