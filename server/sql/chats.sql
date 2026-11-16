-- ============================================================================
-- Chats v1: one read-only view over the messages the n8n workflow
-- "Fetch Wati Data and send to Report" saves in public.wati_messages (template, team and customer messages).
-- Run ONCE as the database admin (Supabase: SQL Editor). Safe to run again. Changes no table, copies no data.
-- Needs: reporting.phone10() from reporting_views.sql (already there on the live database) and public.wati_messages.
-- The page reads ONLY this view. It carries no message text, only who/when/which template, the kind of message and how far it got.
-- ============================================================================
create schema if not exists reporting;

-- One row per message. chat_key says which chat it belongs to:
--   the WATI ticket, else the conversation id, else (only when WATI sent neither) that phone number on that India-time day.
-- direction: 'inbound' = the customer wrote, 'session' = the team wrote (free, inside the 24 h window), 'template' = a template we sent (paid).
create or replace view reporting.v_chat_messages as
select
  w.wati_id,
  w.direction,
  coalesce(nullif(w.ticket_id, ''), nullif(w.conversation_id, ''),
           'p:' || reporting.phone10(w.phone_no) || ':' || ((coalesce(w.received_at, w.sent_at, w.failed_at) at time zone 'Asia/Kolkata')::date)::text) as chat_key,
  reporting.phone10(w.phone_no)                                              as phone10,
  w.template_name,
  w.sender_name,
  w.operator_email,
  w.operator_name,
  w.assignee_id,
  coalesce(w.received_at, w.sent_at, w.failed_at)                            as at_utc,
  (coalesce(w.received_at, w.sent_at, w.failed_at) at time zone 'Asia/Kolkata') as at_ist,
  w.failed_at,
  -- added 5 Nov 2026 (new columns go at the END so this file can simply be run again): what kind of message it was, how far it got, and WATI's conversation id
  nullif(w.message_type, '')                                                 as message_type,
  w.delivered_at, w.read_at, w.replied_at,
  nullif(w.conversation_id, '')                                              as conversation_id
from public.wati_messages w
where w.direction in ('template', 'session', 'inbound')
  and coalesce(w.received_at, w.sent_at, w.failed_at) is not null
  and (nullif(w.ticket_id, '') is not null or nullif(w.conversation_id, '') is not null or reporting.phone10(w.phone_no) <> '');

-- Let the dashboard's read-only login see it (skipped if that login does not exist here).
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'dashboard_ro') then
    grant usage on schema reporting to dashboard_ro;
    grant select on reporting.v_chat_messages to dashboard_ro;
  end if;
end $$;
