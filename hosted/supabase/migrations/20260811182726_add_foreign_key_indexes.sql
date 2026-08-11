create index if not exists idx_audit_events_actor on public.audit_events(actor_id);
create index if not exists idx_notifications_request on public.notifications(request_id);
create index if not exists idx_request_documents_uploaded_by on public.request_documents(uploaded_by);
create index if not exists idx_request_history_actor on public.request_history(actor_id);
