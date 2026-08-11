create or replace function private.generate_overdue_notifications()
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.notifications(recipient_id,request_id,notification_type,title,message,event_key)
  select recipients.recipient_id,r.id,'reminder',rules.event,
    r.request_code||' - '||r.buyer||' requires action at '||r.status||'.',
    'reminder:'||r.id::text||':'||current_date::text||':'||rules.rule_number::text||':'||recipients.recipient_id::text
  from public.credit_requests r
  cross join lateral (
    select ordinality::int as rule_number,
      coalesce(nullif(item->>'event',''),'Request action overdue') as event,
      greatest(1,least(365,coalesce((item->>'after')::int,3))) as after_days,
      item->>'recipient' as recipient_role
    from jsonb_array_elements(coalesce((select value_json from public.app_settings where section='reminders'),'[]'::jsonb))
      with ordinality as configured(item,ordinality)
  ) rules
  cross join lateral (
    select r.requester_id as recipient_id where rules.recipient_role='Business Requester'
    union
    select coalesce(r.owner_id,p.id) from public.profiles p
      where rules.recipient_role='Finance Reviewer' and p.approved and p.app_role='Finance Reviewer'
        and (r.owner_id is null or p.id=r.owner_id)
    union
    select p.id from public.profiles p
      where rules.recipient_role='Administrator' and p.approved and p.app_role='Administrator'
  ) recipients
  where r.status not in ('Approved','Rejected','Closed')
    and r.due_date+(rules.after_days-1)<=current_date
  on conflict(event_key) do nothing;
end $$;
revoke all on function private.generate_overdue_notifications() from public, anon, authenticated;
