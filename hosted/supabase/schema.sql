create extension if not exists pgcrypto;
create schema if not exists private;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text not null default '',
  app_role text not null default 'Business Requester' check (app_role in ('Business Requester','Finance Reviewer','Administrator')),
  approved boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.app_settings (
  section text primary key,
  value_json jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.credit_requests (
  id uuid primary key default gen_random_uuid(),
  request_number bigint generated always as identity unique,
  request_code text unique,
  requester_id uuid not null references public.profiles(id),
  requester_name text not null,
  buyer text not null check (char_length(buyer) between 1 and 200),
  country text not null check (char_length(country) between 1 and 100),
  business_unit text not null check (char_length(business_unit) between 1 and 120),
  amount numeric(18,2) not null check (amount > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  payment_terms text not null default 'Not specified',
  status text not null,
  owner_name text not null default 'Finance Review Queue',
  due_date date not null,
  submitted_date date not null default current_date,
  coface_reference text not null default '-',
  approved_amount numeric(18,2),
  note text not null default '' check (char_length(note) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.request_documents (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.credit_requests(id) on delete cascade,
  checklist_index integer not null check (checklist_index >= 0),
  label text not null,
  storage_path text not null unique,
  filename text not null,
  content_type text not null check (content_type = 'application/pdf'),
  size_bytes bigint not null check (size_bytes between 1 and 10485760),
  uploaded_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  unique (request_id, checklist_index)
);

create table if not exists public.request_history (
  id bigint generated always as identity primary key,
  request_id uuid not null references public.credit_requests(id) on delete cascade,
  event text not null,
  actor_id uuid not null references public.profiles(id),
  actor_name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.notifications (
  id bigint generated always as identity primary key,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  request_id uuid references public.credit_requests(id) on delete cascade,
  notification_type text not null,
  title text not null,
  message text not null,
  event_key text unique,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.audit_events (
  id bigint generated always as identity primary key,
  actor_id uuid references public.profiles(id),
  actor_email text not null,
  action text not null,
  entity_type text not null,
  entity_id text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_credit_requests_requester on public.credit_requests(requester_id, created_at desc);
create index if not exists idx_credit_requests_status on public.credit_requests(status, updated_at desc);
create index if not exists idx_credit_requests_due_open on public.credit_requests(due_date) where status not in ('Approved','Rejected','Closed');
create index if not exists idx_request_documents_request on public.request_documents(request_id);
create index if not exists idx_request_history_request on public.request_history(request_id, created_at desc);
create index if not exists idx_notifications_recipient on public.notifications(recipient_id, read_at, created_at desc);
create index if not exists idx_audit_events_entity on public.audit_events(entity_type, entity_id, created_at desc);

insert into public.app_settings(section,value_json) values
('statuses','[{"name":"Submitted to Finance","color":"blue","sla":1},{"name":"Documents Under Review","color":"orange","sla":2},{"name":"Returned - Documents Required","color":"red","sla":3},{"name":"Ready for COFACE Submission","color":"teal","sla":1},{"name":"Submitted to COFACE","color":"blue","sla":5},{"name":"Additional Information Required","color":"orange","sla":3},{"name":"Approved","color":"teal","sla":0},{"name":"Rejected","color":"red","sla":0},{"name":"Closed","color":"gray","sla":0}]'::jsonb),
('documents','[{"name":"Trade / commercial licence","required":true},{"name":"VAT certificate","required":true},{"name":"Buyer financial information","required":false}]'::jsonb),
('roles','[{"name":"Business Requester","access":"Create and view own"},{"name":"Finance Reviewer","access":"Review and manage"},{"name":"Administrator","access":"Full access"}]'::jsonb),
('reminders','[{"event":"Request pending without action","after":3,"recipient":"Finance Reviewer"}]'::jsonb)
on conflict (section) do nothing;

create or replace function private.current_app_role() returns text language sql stable security definer set search_path = '' as $$
  select app_role from public.profiles where id = (select auth.uid()) and approved = true
$$;
create or replace function private.can_view_request(target uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.credit_requests r join public.profiles p on p.id=(select auth.uid()) where r.id=target and p.approved=true and (r.requester_id=p.id or p.app_role in ('Finance Reviewer','Administrator')))
$$;
create or replace function private.owns_request(target uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.credit_requests where id=target and requester_id=(select auth.uid()))
$$;
revoke all on function private.current_app_role() from public;
revoke all on function private.can_view_request(uuid) from public;
revoke all on function private.owns_request(uuid) from public;
grant usage on schema private to authenticated;
grant execute on function private.current_app_role() to authenticated;
grant execute on function private.can_view_request(uuid) to authenticated;
grant execute on function private.owns_request(uuid) to authenticated;

create or replace function private.handle_new_user() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles(id,email,full_name,app_role,approved)
  values(new.id,coalesce(new.email,''),coalesce(new.raw_user_meta_data->>'full_name',''),case when not exists(select 1 from public.profiles) then 'Administrator' else 'Business Requester' end,true);
  return new;
end $$;
revoke all on function private.handle_new_user() from public;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function private.handle_new_user();

alter table public.profiles enable row level security;
alter table public.app_settings enable row level security;
alter table public.credit_requests enable row level security;
alter table public.request_documents enable row level security;
alter table public.request_history enable row level security;
alter table public.notifications enable row level security;
alter table public.audit_events enable row level security;

create policy profiles_select on public.profiles for select to authenticated using (id=(select auth.uid()) or private.current_app_role()='Administrator');
create policy profiles_admin_update on public.profiles for update to authenticated using (private.current_app_role()='Administrator') with check (private.current_app_role()='Administrator');
create policy settings_select on public.app_settings for select to authenticated using ((select private.current_app_role()) is not null);
create policy settings_admin_update on public.app_settings for update to authenticated using (private.current_app_role()='Administrator') with check (private.current_app_role()='Administrator');
create policy requests_select on public.credit_requests for select to authenticated using (private.can_view_request(id));
create policy requests_insert on public.credit_requests for insert to authenticated with check (requester_id=(select auth.uid()) and (select private.current_app_role()) is not null);
create policy requests_update on public.credit_requests for update to authenticated using (private.current_app_role() in ('Finance Reviewer','Administrator')) with check (private.current_app_role() in ('Finance Reviewer','Administrator'));
create policy documents_select on public.request_documents for select to authenticated using (private.can_view_request(request_id));
create policy documents_insert on public.request_documents for insert to authenticated with check (uploaded_by=(select auth.uid()) and private.owns_request(request_id));
create policy history_select on public.request_history for select to authenticated using (private.can_view_request(request_id));
create policy history_insert on public.request_history for insert to authenticated with check (actor_id=(select auth.uid()) and private.can_view_request(request_id));
create policy notifications_select on public.notifications for select to authenticated using (recipient_id=(select auth.uid()));
create policy notifications_update on public.notifications for update to authenticated using (recipient_id=(select auth.uid())) with check (recipient_id=(select auth.uid()));
create policy notifications_insert on public.notifications for insert to authenticated with check (recipient_id=(select auth.uid()));
create policy audit_insert on public.audit_events for insert to authenticated with check (actor_id=(select auth.uid()));
create policy audit_admin_select on public.audit_events for select to authenticated using (private.current_app_role()='Administrator');

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('credit-insurance-documents','credit-insurance-documents',false,10485760,array['application/pdf'])
on conflict(id) do update set public=false,file_size_limit=10485760,allowed_mime_types=array['application/pdf'];

create policy document_object_select on storage.objects for select to authenticated using (bucket_id='credit-insurance-documents' and private.can_view_request(((storage.foldername(name))[1])::uuid));
create policy document_object_insert on storage.objects for insert to authenticated with check (bucket_id='credit-insurance-documents' and private.owns_request(((storage.foldername(name))[1])::uuid));

revoke all on public.profiles, public.app_settings, public.credit_requests, public.request_documents, public.request_history, public.notifications, public.audit_events from anon;
grant select,insert,update on public.profiles, public.app_settings, public.credit_requests, public.request_documents, public.request_history, public.notifications, public.audit_events to authenticated;
grant usage,select on all sequences in schema public to authenticated;
