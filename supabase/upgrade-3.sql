-- Folio upgrade 3: home improvement contracts and e-signatures (MA and RI).
-- Run once in Supabase: SQL Editor > New query > paste > Run.
-- Run upgrade-1.sql and upgrade-2.sql first if you haven't. Safe to run more than once; your data is kept.

-- Company profile: licenses and contract settings
alter table public.companies add column if not exists contract_enabled boolean not null default false;
alter table public.companies add column if not exists primary_state text default 'MA';      -- license listed first: MA or RI
alter table public.companies add column if not exists hic_no text;                          -- MA Home Improvement Contractor registration
alter table public.companies add column if not exists csl_no text;                          -- MA Construction Supervisor License
alter table public.companies add column if not exists ri_reg_no text;                       -- RI Contractors' Registration and Licensing Board
alter table public.companies add column if not exists signer_name text;
alter table public.companies add column if not exists salesperson text;
alter table public.companies add column if not exists insurance_amount text;
alter table public.companies add column if not exists warranty_term text default '1 year';
alter table public.companies add column if not exists work_hours text default 'Monday to Friday, 7 AM to 5 PM';
alter table public.companies add column if not exists contractor_signature text;            -- small PNG image
alter table public.companies add column if not exists arbitration_enabled boolean not null default true;
alter table public.companies add column if not exists contract_extra text;

-- Estimates: dates the contract needs, an optional state override, and the signing record
alter table public.documents add column if not exists start_date date;
alter table public.documents add column if not exists completion_date date;
alter table public.documents add column if not exists contract_state text;
alter table public.documents add column if not exists signature jsonb;

-- Accept an estimate or approve a change order, optionally with option choices and a signature.
-- The signing record is built here on the server: the time, the address the request came from,
-- and a copy of the company and estimate exactly as they were when the customer signed.
drop function if exists public.accept_estimate(text, text);
drop function if exists public.accept_estimate(text, text, int[]);
drop function if exists public.accept_estimate(text, text, int[], jsonb);
create function public.accept_estimate(p_token text, p_name text, p_selected int[] default null, p_signature jsonb default null)
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
begin
  select * into d from public.documents
    where public_token = p_token and type in ('estimate', 'change_order') and status = 'sent' and archived = false;
  if not found then
    return false;
  end if;

  -- Only the "selected" flag of optional lines can change; prices and wording stay as written.
  if p_selected is not null then
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
    if coalesce(length(p_signature->>'image'), 0) < 100 or length(p_signature::text) > 600000 then
      return false;
    end if;
    select * into c from public.companies where id = d.company_id;
    begin
      v_ip := split_part(coalesce(current_setting('request.headers', true)::json->>'x-forwarded-for', ''), ',', 1);
    exception when others then v_ip := null;
    end;
    v_sig := jsonb_build_object(
      'name', v_name,
      'image', p_signature->>'image',
      'agreed', true,
      'no_photos', coalesce((p_signature->>'no_photos')::boolean, false),
      'arbitration_image', p_signature->>'arbitration_image',
      'arbitration_name', p_signature->>'arbitration_name',
      'state', p_signature->>'state',
      'ua', left(coalesce(p_signature->>'ua', ''), 300),
      'ip', nullif(v_ip, ''),
      'signed_at', now(),
      'company', to_jsonb(c) - 'owner' - 'next_invoice_no' - 'next_estimate_no' - 'next_change_order_no' - 'logo',
      'document', to_jsonb(d) - 'owner' - 'signature' - 'public_token'
    );
  end if;

  update public.documents
    set status = 'accepted', accepted_at = now(), accepted_by = v_name, signature = coalesce(v_sig, signature)
    where id = d.id
    returning * into d;
  insert into public.events (owner, document_id, kind, detail) values (d.owner, d.id, 'accepted', d.accepted_by);
  return true;
end;
$$;

revoke all on function public.accept_estimate(text, text, int[], jsonb) from public;
grant execute on function public.accept_estimate(text, text, int[], jsonb) to anon, authenticated;

-- Schedule without fixed dates: start window (company) and projected duration (estimate)
alter table public.companies add column if not exists start_window text default '2 to 4 weeks after this contract is signed';
alter table public.documents add column if not exists duration_text text;
