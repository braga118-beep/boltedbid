-- BoltedBid upgrade 5: the customer sees the estimate first, accepts it, and then signs the contract.
-- Run once in Supabase: SQL Editor > New query > paste > Run.
-- Run upgrade-3.sql and upgrade-4.sql first if you haven't. Safe to run more than once; your data is kept.

-- On (the default): accept first, then sign the contract. Off: the older one-step "accept and sign".
alter table public.companies add column if not exists contract_after_accept boolean not null default true;
alter table public.documents add column if not exists contract_requested_at timestamptz;

-- Accept an estimate or approve a change order, optionally with option choices and a signature.
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

  if v_sig is null and d.type = 'estimate' then
    select * into c from public.companies where id = d.company_id;
  end if;

  update public.documents
    set status = 'accepted', accepted_at = now(), accepted_by = v_name, signature = coalesce(v_sig, signature),
        -- Contracts on: the contract to sign appears for the customer right after they accept.
        contract_requested_at = case
          when v_sig is null and d.type = 'estimate' and coalesce(c.contract_enabled, false) and coalesce(c.contract_after_accept, true)
          then now() else contract_requested_at end
    where id = d.id
    returning * into d;
  insert into public.events (owner, document_id, kind, detail) values (d.owner, d.id, 'accepted', d.accepted_by);
  return true;
end;
$$;

revoke all on function public.accept_estimate(text, text, int[], jsonb) from public;
grant execute on function public.accept_estimate(text, text, int[], jsonb) to anon, authenticated;
