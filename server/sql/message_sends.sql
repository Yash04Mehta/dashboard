-- ============================================================================
-- Messages: one row per template message SENT, on the day it was sent (India time).
-- Run ONCE as the database admin (Navicat / Supabase SQL editor). Safe to run again. Changes no table, copies no data.
-- Needs: reporting_views.sql (reporting.phone10) and public.wati_messages (saved by the n8n workflow
-- "Fetch Wati Data and send to Report", one row per WATI message with its sent / delivered / read / replied / failed times).
--
-- Why: reporting.v_message_rows reads public.wati_message_pivot, which has ONE row per phone + template, dated by the
-- first send ever. Every repeat send (task follow-ups, re-sent welcomes...) is missing from the day it was sent, so the
-- dashboard showed about 12% fewer messages than WATI really sent (13-19 Nov 2026: 6,733 vs 7,636).
-- This view counts every message, so a number searched in WATI shows the same messages as the dashboard.
--
-- History is kept: days BEFORE the first full day that wati_messages holds still come from the pivot (as before);
-- from that day on, every message comes from wati_messages.
-- Same columns as reporting.v_message_rows, so every page works unchanged. Per row: measured_attempts = 1, no repeats.
-- ============================================================================
create schema if not exists reporting;

drop view if exists reporting.v_message_sends;
create view reporting.v_message_sends as
with cutoff as (
  -- first FULL India-time day in wati_messages (the first day is usually partial, so it stays on the pivot)
  select coalesce((min(coalesce(sent_at, failed_at)) at time zone 'Asia/Kolkata')::date + 1, date '9999-12-31') as d
  from public.wati_messages where direction = 'template'
),
older as (
  -- before the cut-off: the pivot, exactly like reporting.v_message_rows
  select p.id::text as id, p.phone_no, p.template_name, p.whatsappmessageid as last_message_id,
         coalesce(p.templatemessagesent_v2, 0) as sent, coalesce(p.templatemessagefailed, 0) as failed,
         coalesce(p.delivered, 0) as delivered_raw, coalesce(p.sentmessageread_v2, 0) as read_raw, coalesce(p.sentmessagereplied_v2, 0) as replied_raw,
         p.created_at_ist as first_at, p.updated_at_ist as last_at,
         greatest(coalesce(p.delivered, 0), coalesce(p.sentmessageread_v2, 0), coalesce(p.sentmessagereplied_v2, 0)) as delivered_adj,
         greatest(coalesce(p.sentmessageread_v2, 0), coalesce(p.sentmessagereplied_v2, 0)) as read_adj
  from public.wati_message_pivot p
  where p.created_at_ist::date < (select d from cutoff)
),
newer as (
  -- from the cut-off: every template message WATI reported, one row each
  select w.wati_id as id, w.phone_no, w.template_name, w.wati_id as last_message_id,
         case when w.failed_at is null then 1 else 0 end as sent, case when w.failed_at is null then 0 else 1 end as failed,
         (w.delivered_at is not null)::int as delivered_raw, (w.read_at is not null)::int as read_raw, (w.replied_at is not null)::int as replied_raw,
         (coalesce(w.sent_at, w.failed_at) at time zone 'Asia/Kolkata') as first_at,
         (greatest(w.sent_at, w.failed_at, w.delivered_at, w.read_at, w.replied_at) at time zone 'Asia/Kolkata') as last_at,
         -- a failed message reached nobody: no delivered / read credit (same rule as WATI's own delivery report)
         (w.failed_at is null and coalesce(w.delivered_at, w.read_at, w.replied_at) is not null)::int as delivered_adj,
         (w.failed_at is null and coalesce(w.read_at, w.replied_at) is not null)::int as read_adj
  from public.wati_messages w
  where w.direction = 'template' and coalesce(w.sent_at, w.failed_at) is not null
    and (coalesce(w.sent_at, w.failed_at) at time zone 'Asia/Kolkata')::date >= (select d from cutoff)
),
p as (
  select o.*, greatest(o.sent - 1, 0) as unmeasured_sends from older o
  union all
  select n.*, 0 as unmeasured_sends from newer n
),
-- One lead per phone number (the most recent), as in reporting.v_message_rows
lead_by_phone as (
  select distinct on (reporting.phone10(customer_number))
         reporting.phone10(customer_number) as phone10,
         lead_id, lead_source, lead_manager_name, lead_status
  from public.lead_insight
  where reporting.phone10(customer_number) <> ''
  order by reporting.phone10(customer_number), created_at desc nulls last
)
select
  p.id,
  p.phone_no,
  reporting.phone10(p.phone_no)                                  as phone10,
  p.template_name,
  p.last_message_id,
  p.sent,
  p.failed,
  p.sent + p.failed                                              as attempts_est,
  p.unmeasured_sends,
  (p.sent + p.failed) - p.unmeasured_sends                       as measured_attempts,
  p.delivered_raw,
  p.read_raw,
  p.replied_raw                                                  as replied,
  p.delivered_adj,
  p.read_adj,
  (p.read_raw > p.delivered_raw)                                 as read_gt_delivered,
  (p.sent > 1)                                                   as has_repeat_sends,
  p.first_at                                                     as first_sent_at_ist,
  p.last_at                                                      as last_event_at_ist,
  p.first_at::date                                               as first_sent_date,
  p.last_at::date                                                as last_event_date,
  l.lead_id,
  case
    when l.lead_id is null then null
    when l.lead_source in ('Not Connected','New','Contacted','Nurturing','Qualified','Unqualified')
      then '(unknown: overwritten by status)'
    when coalesce(l.lead_source, '') = '' then '(none)'
    else l.lead_source
  end                                                            as lead_source,
  l.lead_manager_name,
  l.lead_status,
  case when l.lead_id is null then 'no matching lead (owner number, unknown, or phone overwritten)' else 'lead' end as audience
from p
left join lead_by_phone l on l.phone10 = reporting.phone10(p.phone_no);

-- Let the dashboard's read-only login see it (skipped if that login does not exist here).
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'dashboard_ro') then
    grant usage on schema reporting to dashboard_ro;
    grant select on reporting.v_message_sends to dashboard_ro;
  end if;
end $$;

-- CHECK after running (compare with WATI's own events; the two "sent" numbers must be equal):
--   select first_sent_date, sum(measured_attempts) as sent, sum(failed) as failed from reporting.v_message_sends
--   where first_sent_date between current_date - 6 and current_date group by 1 order by 1;
--   select (coalesce(sent_at, failed_at) at time zone 'Asia/Kolkata')::date as day, count(*) as sent, count(failed_at) as failed
--   from public.wati_messages where direction = 'template' and coalesce(sent_at, failed_at) >= (current_date - 6)::timestamp at time zone 'Asia/Kolkata'
--   group by 1 order by 1;
