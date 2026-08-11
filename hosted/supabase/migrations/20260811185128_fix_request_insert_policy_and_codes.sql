drop policy if exists requests_select on public.credit_requests;
create policy requests_select on public.credit_requests
for select to authenticated
using (
  requester_id = (select auth.uid())
  or private.current_app_role() in ('Finance Reviewer','Administrator')
);

create or replace function private.assign_request_code()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.request_code is null then
    new.request_code := 'CI-' || to_char(current_date,'YYYY') || '-' || lpad(new.request_number::text,6,'0');
  end if;
  return new;
end
$$;
revoke all on function private.assign_request_code() from public;
drop trigger if exists before_credit_request_insert on public.credit_requests;
create trigger before_credit_request_insert
before insert on public.credit_requests
for each row execute function private.assign_request_code();

create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles(id,email,full_name,app_role,approved)
  values(new.id,coalesce(new.email,''),coalesce(new.raw_user_meta_data->>'full_name',''),'Business Requester',true);
  return new;
end
$$;
revoke all on function private.handle_new_user() from public;
