create or replace function public.cleanup_failed_request(target_request uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then raise exception 'Authentication required' using errcode='42501'; end if;
  delete from public.credit_requests
  where id=target_request and requester_id=(select auth.uid()) and created_at>now()-interval '15 minutes';
end
$$;
revoke all on function public.cleanup_failed_request(uuid) from public, anon;
grant execute on function public.cleanup_failed_request(uuid) to authenticated;
