drop function if exists public.admin_update_profile(uuid,text,boolean);
drop function if exists public.cleanup_failed_request(uuid);

create index if not exists idx_request_comments_author on public.request_comments(author_id);

create or replace function private.enforce_profile_access_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  caller_email text := 'database administrator';
  active_admins integer;
begin
  if old.app_role is not distinct from new.app_role and old.approved is not distinct from new.approved then
    return new;
  end if;
  if caller_id is not null and (select private.current_app_role()) <> 'Administrator' then
    raise exception 'Administrator access is required' using errcode='42501';
  end if;
  if old.app_role='Administrator' and old.approved and (new.app_role<>'Administrator' or not new.approved) then
    select count(*) into active_admins from public.profiles
      where app_role='Administrator' and approved and id<>old.id;
    if active_admins=0 then
      raise exception 'The final active administrator cannot be removed or suspended' using errcode='23514';
    end if;
  end if;
  if caller_id is not null then select email into caller_email from public.profiles where id=caller_id; end if;
  insert into public.audit_events(actor_id,actor_email,action,entity_type,entity_id,details)
  values(caller_id,coalesce(caller_email,''),'user.access_changed','profile',old.id::text,
    jsonb_build_object('target_email',old.email,'previous_role',old.app_role,'new_role',new.app_role,
      'previous_approved',old.approved,'new_approved',new.approved));
  if new.approved then
    insert into public.notifications(recipient_id,notification_type,title,message,event_key)
    values(new.id,'access_change','Access updated','Your application access is now '||new.app_role||'.',
      'access:'||new.id::text||':'||extract(epoch from clock_timestamp())::text);
  end if;
  return new;
end
$$;
revoke all on function private.enforce_profile_access_change() from public, anon, authenticated;
drop trigger if exists before_profile_access_change on public.profiles;
create trigger before_profile_access_change before update of app_role,approved on public.profiles
for each row execute function private.enforce_profile_access_change();

drop policy if exists profiles_admin_update on public.profiles;
create policy profiles_admin_update on public.profiles for update to authenticated
using ((select private.current_app_role())='Administrator')
with check ((select private.current_app_role())='Administrator');
grant update on public.profiles to authenticated;

drop policy if exists requests_cleanup_failed_insert on public.credit_requests;
create policy requests_cleanup_failed_insert on public.credit_requests for delete to authenticated
using (
  requester_id=(select auth.uid())
  and created_at>now()-interval '15 minutes'
  and not exists(select 1 from public.request_history h where h.request_id=credit_requests.id)
);
grant delete on public.credit_requests to authenticated;
