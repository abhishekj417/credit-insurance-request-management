alter table public.credit_requests
  add column if not exists owner_id uuid references public.profiles(id),
  add column if not exists next_action text not null default 'Finance review',
  add column if not exists status_changed_at timestamptz not null default now(),
  add column if not exists approval_valid_until date,
  add column if not exists coface_conditions text not null default '',
  add column if not exists decision_reason text not null default '';

create index if not exists idx_credit_requests_owner on public.credit_requests(owner_id, due_date)
where owner_id is not null and status not in ('Approved','Rejected','Closed');

create table if not exists public.request_comments (
  id bigint generated always as identity primary key,
  request_id uuid not null references public.credit_requests(id) on delete cascade,
  author_id uuid not null references public.profiles(id),
  author_name text not null,
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index if not exists idx_request_comments_request on public.request_comments(request_id, created_at desc);
alter table public.request_comments enable row level security;

drop policy if exists comments_select on public.request_comments;
create policy comments_select on public.request_comments for select to authenticated
using ((select private.can_view_request(request_id)));
drop policy if exists comments_insert on public.request_comments;
create policy comments_insert on public.request_comments for insert to authenticated
with check (author_id=(select auth.uid()) and (select private.can_view_request(request_id)));

revoke all on public.request_comments from anon;
grant select,insert on public.request_comments to authenticated;
grant usage,select on sequence public.request_comments_id_seq to authenticated;

drop policy if exists profiles_admin_update on public.profiles;
revoke update on public.profiles from authenticated;

create or replace function public.admin_update_profile(target_user uuid, new_role text, new_approved boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  caller_email text;
  previous_role text;
  previous_approved boolean;
  target_email text;
  target_name text;
  active_admins integer;
begin
  if caller_id is null or (select private.current_app_role()) <> 'Administrator' then
    raise exception 'Administrator access is required' using errcode='42501';
  end if;
  if new_role not in ('Business Requester','Finance Reviewer','Administrator') then
    raise exception 'Unknown application role' using errcode='22023';
  end if;

  select app_role, approved, email, full_name
    into previous_role, previous_approved, target_email, target_name
  from public.profiles where id=target_user for update;
  if not found then raise exception 'User profile was not found' using errcode='P0002'; end if;

  if previous_role='Administrator' and previous_approved and (new_role<>'Administrator' or not new_approved) then
    select count(*) into active_admins from public.profiles
      where app_role='Administrator' and approved and id<>target_user;
    if active_admins=0 then
      raise exception 'The final active administrator cannot be removed or suspended' using errcode='23514';
    end if;
  end if;

  update public.profiles
    set app_role=new_role, approved=new_approved, updated_at=now()
    where id=target_user;

  select email into caller_email from public.profiles where id=caller_id;
  insert into public.audit_events(actor_id,actor_email,action,entity_type,entity_id,details)
  values(caller_id,coalesce(caller_email,''),'user.access_changed','profile',target_user::text,
    jsonb_build_object('target_email',target_email,'previous_role',previous_role,'new_role',new_role,
      'previous_approved',previous_approved,'new_approved',new_approved));

  if new_approved then
    insert into public.notifications(recipient_id,notification_type,title,message,event_key)
    values(target_user,'access_change','Access updated','Your application access is now '||new_role||'.',
      'access:'||target_user::text||':'||extract(epoch from clock_timestamp())::text);
  end if;

  return jsonb_build_object('id',target_user,'email',target_email,'fullName',target_name,
    'role',new_role,'approved',new_approved);
end
$$;
revoke all on function public.admin_update_profile(uuid,text,boolean) from public, anon;
grant execute on function public.admin_update_profile(uuid,text,boolean) to authenticated;

drop policy if exists notifications_insert on public.notifications;
create policy notifications_insert on public.notifications for insert to authenticated
with check (
  recipient_id=(select auth.uid())
  or (
    request_id is not null
    and (select private.current_app_role()) in ('Finance Reviewer','Administrator')
    and (select private.can_view_request(request_id))
  )
);

create or replace function private.notify_new_credit_request()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.notifications(recipient_id,request_id,notification_type,title,message,event_key)
  values(new.requester_id,new.id,'new_request','Request submitted',
    new.request_code||' - '||new.buyer||' was submitted for finance review.',
    'created:requester:'||new.id::text)
  on conflict(event_key) do nothing;

  insert into public.notifications(recipient_id,request_id,notification_type,title,message,event_key)
  select p.id,new.id,'new_request','New request awaiting review',
    new.request_code||' - '||new.buyer||' requires finance review.',
    'created:reviewer:'||new.id::text||':'||p.id::text
  from public.profiles p
  where p.approved and p.app_role in ('Finance Reviewer','Administrator') and p.id<>new.requester_id
  on conflict(event_key) do nothing;
  return new;
end $$;
revoke all on function private.notify_new_credit_request() from public, anon, authenticated;
drop trigger if exists after_credit_request_notification on public.credit_requests;
create trigger after_credit_request_notification after insert on public.credit_requests
for each row execute function private.notify_new_credit_request();

create or replace function private.notify_credit_request_status()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.status is distinct from new.status then
    insert into public.notifications(recipient_id,request_id,notification_type,title,message,event_key)
    values(new.requester_id,new.id,'status_change','Request stage updated',
      new.request_code||' - '||new.buyer||' moved to '||new.status||'.',
      'status:'||new.id::text||':'||extract(epoch from clock_timestamp())::text||':'||new.requester_id::text)
    on conflict(event_key) do nothing;
    if new.owner_id is not null and new.owner_id<>new.requester_id then
      insert into public.notifications(recipient_id,request_id,notification_type,title,message,event_key)
      values(new.owner_id,new.id,'assignment','Request assigned',
        new.request_code||' - '||new.buyer||' is assigned to you at '||new.status||'.',
        'assignment:'||new.id::text||':'||extract(epoch from clock_timestamp())::text||':'||new.owner_id::text)
      on conflict(event_key) do nothing;
    end if;
  end if;
  return new;
end $$;
revoke all on function private.notify_credit_request_status() from public, anon, authenticated;
drop trigger if exists after_credit_request_status_notification on public.credit_requests;
create trigger after_credit_request_status_notification after update of status,owner_id on public.credit_requests
for each row execute function private.notify_credit_request_status();

create or replace function private.generate_overdue_notifications()
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.notifications(recipient_id,request_id,notification_type,title,message,event_key)
  select recipients.recipient_id,r.id,'reminder','Request action overdue',
    r.request_code||' - '||r.buyer||' is overdue at '||r.status||'.',
    'overdue:'||r.id::text||':'||current_date::text||':'||recipients.recipient_id::text
  from public.credit_requests r
  cross join lateral (
    select r.owner_id as recipient_id where r.owner_id is not null
    union
    select r.requester_id where r.owner_id is null and r.status like 'Returned%'
    union
    select p.id from public.profiles p
      where r.owner_id is null and r.status not like 'Returned%'
        and p.approved and p.app_role in ('Finance Reviewer','Administrator')
  ) recipients
  where r.due_date<current_date and r.status not in ('Approved','Rejected','Closed')
  on conflict(event_key) do nothing;
end $$;
revoke all on function private.generate_overdue_notifications() from public, anon, authenticated;

create extension if not exists pg_cron with schema pg_catalog;
do $$
begin
  if not exists(select 1 from cron.job where jobname='credit-insurance-overdue-reminders') then
    perform cron.schedule('credit-insurance-overdue-reminders','0 5 * * *','select private.generate_overdue_notifications()');
  end if;
end $$;

update public.app_settings set value_json='[{"name":"Business Requester","access":"Create and view own requests"},{"name":"Finance Reviewer","access":"Review, assign and manage requests"},{"name":"Administrator","access":"User access, configuration and full workflow control"}]'::jsonb,
updated_at=now() where section='roles';
