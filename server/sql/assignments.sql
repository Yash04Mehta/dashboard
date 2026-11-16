-- ============================================================================
-- Chat owners: remember who a chat was assigned to.
-- WHY: WATI knows the owner of a chat, but the webhook we receive never says so, and the owner is only visible on messages
-- sent AFTER the assignment. The n8n workflow "Assign User in WATI + 24hr logic" is the one that assigns the chat (it looks up the
-- Salesforce lead owner and calls WATI's assignOperator). With one extra n8n step ("Save assignment") it writes a row here each time.
-- The Chats v1 page then reads reporting.v_chat_assignments to fill in the owner. Until this exists and has rows, the page still works
-- and simply says "No owner recorded".
-- Run ONCE as the database admin (Supabase SQL editor). Safe to run again. Only adds a new table and a new read-only view; changes nothing existing.
-- ============================================================================
create schema if not exists reporting;

create table if not exists public.wati_chat_assignments (
  id             bigserial primary key,
  wa_id          text        not null,                       -- the customer's number as n8n sent it to WATI (for example +919876543210)
  operator_email text        not null,                       -- who the chat was assigned to
  operator_name  text,                                       -- their name in Salesforce
  assigned_at    timestamptz not null default now(),
  source         text        not null default 'n8n: Assign User in WATI'
);
create index if not exists wati_chat_assignments_time_idx on public.wati_chat_assignments (assigned_at);
alter table public.wati_chat_assignments enable row level security;   -- no policies: not readable through a public web API

-- What the dashboard reads. One row per assignment; phone10 lets it match the chat by the last 10 digits of the number.
create or replace view reporting.v_chat_assignments as
select reporting.phone10(wa_id) as phone10, operator_email, operator_name, assigned_at
from public.wati_chat_assignments
where reporting.phone10(wa_id) <> '';

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'dashboard_ro') then
    grant usage on schema reporting to dashboard_ro;
    grant select on reporting.v_chat_assignments to dashboard_ro;
  end if;
end $$;
