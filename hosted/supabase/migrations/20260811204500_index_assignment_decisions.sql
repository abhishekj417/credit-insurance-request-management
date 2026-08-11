create index if not exists idx_assignment_claims_decided_by on public.assignment_claims(decided_by)
where decided_by is not null;
