create table if not exists public.assignment_claims (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.credit_requests(id) on delete cascade,
  reviewer_id uuid not null references public.profiles(id),
  reviewer_name text not null,
  status text not null default 'Pending' check (status in ('Pending','Approved','Rejected')),
  decision_note text not null default '' check (char_length(decision_note)<=1000),
  decided_by uuid references public.profiles(id),
  decided_by_name text,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create unique index if not exists idx_assignment_claims_pending_reviewer
on public.assignment_claims(request_id,reviewer_id) where status='Pending';
create index if not exists idx_assignment_claims_request on public.assignment_claims(request_id,created_at desc);
create index if not exists idx_assignment_claims_reviewer on public.assignment_claims(reviewer_id,status,created_at desc);

alter table public.assignment_claims enable row level security;
drop policy if exists assignment_claims_select on public.assignment_claims;
create policy assignment_claims_select on public.assignment_claims for select to authenticated
using (reviewer_id=(select auth.uid()) or (select private.current_app_role())='Administrator');
drop policy if exists assignment_claims_insert on public.assignment_claims;
create policy assignment_claims_insert on public.assignment_claims for insert to authenticated
with check (
  reviewer_id=(select auth.uid())
  and (select private.current_app_role())='Finance Reviewer'
  and exists(select 1 from public.credit_requests r where r.id=request_id and r.owner_id is null)
);
drop policy if exists assignment_claims_admin_update on public.assignment_claims;
create policy assignment_claims_admin_update on public.assignment_claims for update to authenticated
using ((select private.current_app_role())='Administrator')
with check ((select private.current_app_role())='Administrator');
revoke all on public.assignment_claims from anon;
grant select,insert,update on public.assignment_claims to authenticated;

create or replace function private.enforce_request_ownership()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  caller_role text := (select private.current_app_role());
begin
  if caller_id is null then return new; end if;
  if caller_role='Administrator' then return new; end if;
  if caller_role<>'Finance Reviewer' then
    raise exception 'Finance Reviewer or Administrator access is required' using errcode='42501';
  end if;
  if old.owner_id is null then
    raise exception 'Administrator approval is required before this request can be updated' using errcode='42501';
  end if;
  if old.owner_id is distinct from caller_id then
    raise exception 'Only the assigned reviewer or an Administrator can update this request' using errcode='42501';
  end if;
  if new.owner_id is distinct from old.owner_id then
    raise exception 'Finance Reviewers cannot reassign requests' using errcode='42501';
  end if;
  if new.requester_id is distinct from old.requester_id
    or new.request_code is distinct from old.request_code
    or new.buyer is distinct from old.buyer
    or new.country is distinct from old.country
    or new.business_unit is distinct from old.business_unit
    or new.amount is distinct from old.amount
    or new.currency is distinct from old.currency
    or new.payment_terms is distinct from old.payment_terms
    or new.note is distinct from old.note then
    raise exception 'Finance Reviewers cannot change submitted business data' using errcode='42501';
  end if;
  new.owner_name := old.owner_name;
  return new;
end
$$;
revoke all on function private.enforce_request_ownership() from public, anon, authenticated;
drop trigger if exists before_credit_request_ownership on public.credit_requests;
create trigger before_credit_request_ownership before update on public.credit_requests
for each row execute function private.enforce_request_ownership();

create or replace function private.process_assignment_claim()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  request_owner uuid;
begin
  if old.status<>'Pending' or new.status not in ('Approved','Rejected') then
    raise exception 'Only pending claims can be approved or rejected' using errcode='23514';
  end if;
  if (select private.current_app_role())<>'Administrator' then
    raise exception 'Administrator access is required' using errcode='42501';
  end if;
  new.decided_by := (select auth.uid());
  select coalesce(nullif(full_name,''),email) into new.decided_by_name from public.profiles where id=(select auth.uid());
  new.decided_at := now();
  if new.status='Approved' then
    select owner_id into request_owner from public.credit_requests where id=new.request_id for update;
    if request_owner is not null and request_owner is distinct from new.reviewer_id then
      raise exception 'This request is already assigned to another reviewer' using errcode='23514';
    end if;
    update public.credit_requests set owner_id=new.reviewer_id,owner_name=new.reviewer_name,updated_at=now()
      where id=new.request_id;
    update public.assignment_claims set status='Rejected',decision_note='Another reviewer was assigned',
      decided_by=(select auth.uid()),decided_by_name=new.decided_by_name,decided_at=now()
      where request_id=new.request_id and status='Pending' and id<>new.id;
  end if;
  return new;
end
$$;
revoke all on function private.process_assignment_claim() from public, anon, authenticated;
drop trigger if exists before_assignment_claim_decision on public.assignment_claims;
create trigger before_assignment_claim_decision before update of status on public.assignment_claims
for each row execute function private.process_assignment_claim();

create or replace function private.notify_assignment_claim()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  request_code_value text;
  buyer_value text;
begin
  select request_code,buyer into request_code_value,buyer_value from public.credit_requests where id=new.request_id;
  if tg_op='INSERT' then
    insert into public.notifications(recipient_id,request_id,notification_type,title,message,event_key)
    select p.id,new.request_id,'assignment_claim','Assignment approval required',
      new.reviewer_name||' requested assignment to '||request_code_value||' - '||buyer_value||'.',
      'claim:'||new.id::text||':'||p.id::text
    from public.profiles p where p.approved and p.app_role='Administrator'
    on conflict(event_key) do nothing;
  elsif old.status is distinct from new.status then
    insert into public.notifications(recipient_id,request_id,notification_type,title,message,event_key)
    values(new.reviewer_id,new.request_id,'assignment_decision','Assignment request '||lower(new.status),
      'Your assignment request for '||request_code_value||' - '||buyer_value||' was '||lower(new.status)||'.',
      'claim-decision:'||new.id::text||':'||new.status)
    on conflict(event_key) do nothing;
  end if;
  return new;
end $$;
revoke all on function private.notify_assignment_claim() from public, anon, authenticated;
drop trigger if exists after_assignment_claim_notification on public.assignment_claims;
create trigger after_assignment_claim_notification after insert or update of status on public.assignment_claims
for each row execute function private.notify_assignment_claim();
