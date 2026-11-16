-- ============================================================================
-- Aquant Insight: one-time setup for the live database. Run this whole file ONCE as the database admin.
--   1) Replace CHANGE_ME_PASSWORD (search for it, one place) with a strong password.
--   2) Paste it into the SQL editor (Supabase: SQL Editor) and run, or:  psql -1 -h <host> -U <admin> -d <database> -f LIVE_SETUP.sql
-- It adds read-only views in a new schema "reporting", one empty optional table (public.wati_status_events),
-- and a login "dashboard_ro" that can only READ. No existing table is changed and no data is copied out.
-- Safe to run again: it re-creates the views and skips the login if it already exists.
-- ============================================================================

-- ===== part 1: reporting_views.sql =====
-- =====================================================================
-- Aquant reporting views for Looker Studio
-- Read-only: creates a new schema "reporting" with views and one helper function.
-- No existing table is changed. Safe to re-run (CREATE OR REPLACE).
-- Column names come from the schema you shared on 2026-10-30.
-- Tested on a local PostgreSQL copy loaded with the CSV exports in the data_insight folder
-- (262k pivot rows, 82k leads, 15k opportunities), NOT on your live database.
--
-- PART 1 works on data you already have.
-- PART 2 needs one small n8n change first (see the spec) and adds per-event timing and failure reasons.
--
-- What the real data taught us (all reflected below):
--   * lead_source is overwritten with a status word (Not Connected, New, ...) for every lead whose
--     1st task follow-up ran (49k of 82k leads). Shown as "(unknown: overwritten by status)".
--   * customer_number holds a name instead of a phone for ~31% of leads, so message-to-lead linking
--     by phone misses those leads.
--   * Status events for the 2nd and later sends of the same template to the same number are dropped
--     by workflow #15. Those sends cannot be measured, so rates use "measured attempts".
--   * The raw "delivered" counter is far too low (read > delivered on 35% of rows).
--   * The message tables recorded nothing from 2026-09-02 to 2026-10-22 (see v_feed_health).
--   * wati_message_log holds customer messages only (no owner messages), so reply-time views return
--     "unknown" until agent messages are logged.
-- =====================================================================

create schema if not exists reporting;

-- Last 10 digits of a phone number, so +91 98765 43210, 919876543210 and 9876543210 all match.
-- Returns '' when there are no digits (for example when a name was stored instead of a number).
create or replace function reporting.phone10(p text) returns text
language sql immutable as $$
  select right(regexp_replace(coalesce(p, ''), '\D', '', 'g'), 10)
$$;

-- Views are dropped and recreated so this file can be re-run after any change
-- (Postgres cannot "replace" a view whose columns changed). Nothing else depends on them.
drop view if exists reporting.v_data_health, reporting.v_feed_health, reporting.v_template_performance,
                    reporting.v_message_rows, reporting.v_response_times, reporting.v_missed_windows,
                    reporting.v_lead_intake, reporting.v_opportunity_summary, reporting.v_message_funnel cascade;

-- ---------------------------------------------------------------------
-- PART 1A. One row per (phone, template): the base for the Messages pages.
-- Notes on the numbers:
--   attempts_est      = sent + failed. The n8n workflow sets "sent" back to 0 when a message fails,
--                       so "sent" alone leaves failed messages out.
--   unmeasured_sends  = sent - 1 when a person got the same template more than once. Only the first
--                       message id is stored, so status events for later sends find no row and are lost.
--   measured_attempts = attempts_est - unmeasured_sends. All rates use this base.
--   delivered_adj     = highest of delivered / read / replied. A read or replied message was delivered;
--                       the raw counter misses many events. This is a lower bound.
--   read_adj          = highest of read / replied.
--   Dates: first_sent_* is the FIRST send to that person for that template (this is what the current
--   dashboard filters on). last_event_* is the last status event. Repeat sends are not dated.
-- ---------------------------------------------------------------------
create or replace view reporting.v_message_rows as
with p as (
  select id, phone_no, template_name, whatsappmessageid,
         coalesce(templatemessagesent_v2, 0) as sent,
         coalesce(templatemessagefailed, 0)  as failed,
         coalesce(delivered, 0)              as delivered_raw,
         coalesce(sentmessageread_v2, 0)     as read_raw,
         coalesce(sentmessagereplied_v2, 0)  as replied_raw,
         created_at_ist, updated_at_ist
  from public.wati_message_pivot
),
-- One lead per phone number (the most recent). Built once and hash-joined, so it stays fast
-- on hundreds of thousands of rows. Leads whose customer_number was overwritten by text are not matched.
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
  p.whatsappmessageid                                            as last_message_id,
  p.sent,
  p.failed,
  p.sent + p.failed                                              as attempts_est,
  greatest(p.sent - 1, 0)                                        as unmeasured_sends,
  (p.sent + p.failed) - greatest(p.sent - 1, 0)                  as measured_attempts,
  p.delivered_raw,
  p.read_raw,
  p.replied_raw                                                  as replied,
  greatest(p.delivered_raw, p.read_raw, p.replied_raw)           as delivered_adj,
  greatest(p.read_raw, p.replied_raw)                            as read_adj,
  (p.read_raw > p.delivered_raw)                                 as read_gt_delivered,
  (p.sent > 1)                                                   as has_repeat_sends,
  p.created_at_ist                                               as first_sent_at_ist,
  p.updated_at_ist                                               as last_event_at_ist,
  p.created_at_ist::date                                         as first_sent_date,
  p.updated_at_ist::date                                         as last_event_date,
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

-- ---------------------------------------------------------------------
-- PART 1B. Per-template totals, for cross-checking the Looker numbers (no date filter here).
-- Rates use measured_attempts (see above).
-- ---------------------------------------------------------------------
create or replace view reporting.v_template_performance as
select
  template_name,
  sum(attempts_est)                                                          as attempts_est,
  sum(unmeasured_sends)                                                      as unmeasured_sends,
  sum(measured_attempts)                                                     as measured_attempts,
  sum(sent)                                                                  as sent,
  sum(failed)                                                                as failed,
  sum(delivered_raw)                                                         as delivered_raw,
  sum(delivered_adj)                                                         as delivered_adj,
  sum(read_adj)                                                              as read_adj,
  sum(replied)                                                               as replied,
  round(100.0 * sum(unmeasured_sends) / nullif(sum(attempts_est), 0), 1)     as unmeasured_pct,
  round(100.0 * sum(failed)        / nullif(sum(measured_attempts), 0), 2)   as failed_pct,
  round(100.0 * sum(delivered_adj) / nullif(sum(measured_attempts), 0), 2)   as delivered_pct_adj,
  round(100.0 * sum(read_adj)      / nullif(sum(measured_attempts), 0), 2)   as read_pct_adj,
  round(100.0 * sum(replied)       / nullif(sum(measured_attempts), 0), 2)   as replied_pct
from reporting.v_message_rows
group by template_name;

-- ---------------------------------------------------------------------
-- PART 1B2. Funnel in "long" form (one row per stage), because Looker Studio has no funnel chart.
-- Use a horizontal bar chart: dimension = stage, metric = SUM(messages), sort by stage_order.
-- Stage 1 is measured attempts (see PART 1A), so the later stages are shares of the same base.
-- ---------------------------------------------------------------------
create or replace view reporting.v_message_funnel as
select
  r.first_sent_date,
  r.template_name,
  r.lead_source,
  r.lead_manager_name,
  s.stage,
  s.stage_order,
  case s.stage_order
    when 1 then r.measured_attempts
    when 2 then r.delivered_adj
    when 3 then r.read_adj
    when 4 then r.replied
  end as messages
from reporting.v_message_rows r
cross join (values (1, '1 Measured attempts'), (2, '2 Delivered (adjusted)'), (3, '3 Read (adjusted)'), (4, '4 Replied')) as s(stage_order, stage);

-- ---------------------------------------------------------------------
-- PART 1C. Conversations: how fast a customer message gets an owner reply.
-- IMPORTANT: wati_message_log currently holds customer messages only (is_owner is always false), so
-- there is nothing to measure a reply against. In that case "answered" and "minutes_to_reply" are
-- NULL (unknown), not false. They fill in once agent messages are logged (see the spec).
-- Joined on wa_id (hash join) and aggregated, so it needs no index.
-- ---------------------------------------------------------------------
create or replace view reporting.v_response_times as
select
  c.id                                                                    as customer_msg_id,
  c.wa_id,
  reporting.phone10(c.wa_id)                                              as phone10,
  c.message_created_at                                                    as customer_msg_at,
  (c.message_created_at at time zone 'Asia/Kolkata')                      as customer_msg_at_ist,
  (c.message_created_at at time zone 'Asia/Kolkata')::date                as customer_msg_date_ist,
  extract(hour from (c.message_created_at at time zone 'Asia/Kolkata'))::int as customer_msg_hour_ist,
  min(o.message_created_at)                                               as first_reply_at,
  (array_agg(o.operator_email order by o.message_created_at))[1]          as operator_email,
  round((extract(epoch from (min(o.message_created_at) - c.message_created_at)) / 60.0)::numeric, 1) as minutes_to_reply,
  case when not (select exists (select 1 from public.wati_message_log where is_owner is true))
       then null
       else (min(o.message_created_at) is not null)
  end                                                                     as answered
from public.wati_message_log c
left join public.wati_message_log o
  on  o.wa_id = c.wa_id
  and o.is_owner is true
  and o.message_created_at > c.message_created_at
where coalesce(c.event_type, 'message') = 'message'
  and c.is_owner is not true
group by c.id, c.wa_id, c.message_created_at;

-- ---------------------------------------------------------------------
-- PART 1D. 24-hour windows that closed without an owner reply.
-- Same rule: NULL (unknown) while no owner messages are logged.
-- ---------------------------------------------------------------------
create or replace view reporting.v_missed_windows as
with owner_msgs as (
  select reporting.phone10(wa_id) as phone10, message_created_at
  from public.wati_message_log
  where is_owner is true
)
select
  s.id                                                   as session_id,
  s.phone_number,
  s.last_user_message_time,
  s.session_expiry_time,
  (s.session_expiry_time < now())                        as expired,
  case when not (select exists (select 1 from owner_msgs)) then null
       else (count(o.message_created_at) > 0) end        as owner_replied_in_window,
  case when not (select exists (select 1 from owner_msgs)) then null
       else ((s.session_expiry_time < now()) and count(o.message_created_at) = 0) end as missed_window
from public.wati_sessions s
left join owner_msgs o
  on  o.phone10 = reporting.phone10(s.phone_number)
  and o.message_created_at >  s.last_user_message_time
  and o.message_created_at <= s.session_expiry_time
group by s.id, s.phone_number, s.last_user_message_time, s.session_expiry_time;

-- ---------------------------------------------------------------------
-- PART 1E. Lead intake and message coverage (current status only: there is no status history yet).
-- lead_source: for leads where the 1st task follow-up ran, n8n overwrote the real source with the lead
-- status. Those show as "(unknown: overwritten by status)" instead of misleading you.
-- distinct_phones counts people: among leads with a usable number, about 12% share a phone with another lead.
-- phone_overwritten counts leads whose customer_number holds text instead of a number.
-- lead_insight.created_at is when n8n wrote the row, close to (not exactly) the Salesforce date.
-- ---------------------------------------------------------------------
create or replace view reporting.v_lead_intake as
select
  created_at::date                                         as created_date,
  case
    when lead_source in ('Not Connected','New','Contacted','Nurturing','Qualified','Unqualified') then '(unknown: overwritten by status)'
    when coalesce(lead_source, '') = '' then '(none)'
    else lead_source
  end                                                      as lead_source,
  coalesce(lead_manager_name, '(unassigned)')              as lead_owner,
  coalesce(lead_status, '(none)')                          as lead_status,
  count(*)                                                 as leads,
  count(distinct nullif(reporting.phone10(customer_number), '')) as distinct_phones,
  count(*) filter (where customer_number ~ '[A-Za-z]')     as phone_overwritten,
  coalesce(sum(welcome_message), 0)                        as welcome_sent,
  coalesce(sum(first_follow_up_message_after24hr), 0)      as followup_24h_sent,
  coalesce(sum("1st_follow_up_message"), 0)                as task_followup_1,
  coalesce(sum("2nd_follow_up_message"), 0)                as task_followup_2,
  coalesce(sum("3rd_follow_up_message"), 0)                as task_followup_3,
  coalesce(sum(when_lead_converted_into_nurturing), 0)     as to_nurturing,
  coalesce(sum(when_lead_converted_into_not_connected), 0) as to_not_connected,
  coalesce(sum(when_lead_converted_into_unqualified), 0)   as to_unqualified
from public.lead_insight
group by 1, 2, 3, 4;

-- ---------------------------------------------------------------------
-- PART 1F. Opportunities by owner and status.
-- won / lost come from opportunity_status, NOT from the won/loss flags: on real data about 250
-- opportunities have a status that disagrees with the flag (shown in flag_mismatch).
-- The follow-up columns are left out on purpose: they are not reliable until the column-mapping fix.
-- ---------------------------------------------------------------------
create or replace view reporting.v_opportunity_summary as
select
  created_at::date                                         as created_date,
  coalesce(opportunity_manager_name, '(unassigned)')       as opportunity_owner,
  coalesce(opportunity_status, '(none)')                   as opportunity_status,
  count(*)                                                 as opportunities,
  count(*) filter (where opportunity_status ilike 'closed won')   as won,
  count(*) filter (where opportunity_status ilike 'closed lost')  as lost,
  count(*) filter (where (opportunity_status ilike 'closed won'  and coalesce(opportunity_won, 0)  <> 1)
                      or (opportunity_status ilike 'closed lost' and coalesce(opportunity_loss, 0) <> 1)
                      or (opportunity_status not ilike 'closed won'  and coalesce(opportunity_won, 0)  = 1)
                      or (opportunity_status not ilike 'closed lost' and coalesce(opportunity_loss, 0) = 1)) as flag_mismatch,
  coalesce(sum(send_customer_details_to_salesperson), 0)   as details_sent_to_salesperson,
  coalesce(sum(send_salesman_details_to_customer), 0)      as details_sent_to_customer
from public.opportunity_insight
group by 1, 2, 3;

-- ---------------------------------------------------------------------
-- PART 1G. Feed health, one row per day: did the WATI feed keep arriving while leads kept coming in?
-- feed_gap_suspected = more than 10 welcome flags that day but no pivot activity at all.
-- On the real data this flags 47 days: 2026-03-06 to 03-12, 2026-09-11 to 10-03 and 10-06 to 10-22.
-- (From 2026-09-02 to 09-10 nothing at all was recorded, not even leads, so those days are not flagged.)
-- Chart it and alert on it.
-- ---------------------------------------------------------------------
create or replace view reporting.v_feed_health as
with days as (
  select d::date as day
  from generate_series((select min(created_at_ist)::date from public.wati_message_pivot), current_date, interval '1 day') d
),
leads   as (select created_at::date d, count(*) leads_created, coalesce(sum(welcome_message), 0) welcome_flags from public.lead_insight group by 1),
opps    as (select created_at::date d, count(*) opps_created from public.opportunity_insight group by 1),
sends   as (select created_at_ist::date d, count(*) pairs_first_sent from public.wati_message_pivot group by 1),
touched as (select updated_at_ist::date d, count(*) pivot_rows_touched from public.wati_message_pivot group by 1),
sess    as (select (last_user_message_time at time zone 'Asia/Kolkata')::date d, count(*) sessions from public.wati_sessions group by 1)
select
  days.day,
  coalesce(l.leads_created, 0)      as leads_created,
  coalesce(l.welcome_flags, 0)      as welcome_flags,
  coalesce(o.opps_created, 0)       as opps_created,
  coalesce(s.pairs_first_sent, 0)   as pairs_first_sent,
  coalesce(t.pivot_rows_touched, 0) as pivot_rows_touched,
  coalesce(x.sessions, 0)           as sessions,
  (coalesce(l.welcome_flags, 0) > 10 and coalesce(t.pivot_rows_touched, 0) = 0) as feed_gap_suspected
from days
left join leads   l on l.d = days.day
left join opps    o on o.d = days.day
left join sends   s on s.d = days.day
left join touched t on t.d = days.day
left join sess    x on x.d = days.day;

-- ---------------------------------------------------------------------
-- PART 1H. One row of health checks (needs v_feed_health above). Put these on a "Data health" page.
-- ---------------------------------------------------------------------
create or replace view reporting.v_data_health as
select
  (select count(*) from public.wati_message_pivot)                                                       as pivot_rows,
  (select count(*) from public.wati_message_pivot where coalesce(sentmessageread_v2,0) > coalesce(delivered,0)) as rows_read_more_than_delivered,
  (select coalesce(sum(greatest(coalesce(delivered,0), coalesce(sentmessageread_v2,0), coalesce(sentmessagereplied_v2,0)) - coalesce(delivered,0)), 0)
     from public.wati_message_pivot)                                                                     as delivered_events_missing_est,
  (select count(*) from public.wati_message_pivot where coalesce(templatemessagesent_v2,0) > 1)           as pairs_with_repeat_sends,
  (select coalesce(sum(templatemessagesent_v2 - 1), 0) from public.wati_message_pivot where coalesce(templatemessagesent_v2,0) > 1) as sends_with_dropped_status_events,
  (select count(*) from reporting.v_message_rows where lead_id is null)                                   as pivot_rows_without_matching_lead,
  (select count(*) from public.wati_message_log)                                                          as inbound_log_rows,
  (select count(*) from public.wati_message_log where is_owner is true)                                   as owner_messages_logged,
  (select count(*) from public.lead_insight)                                                              as lead_rows,
  (select count(*) from public.lead_insight where coalesce(welcome_message,0) = 0)                        as leads_without_welcome_flag,
  (select count(*) from public.lead_insight where customer_number ~ '[A-Za-z]')                           as leads_phone_overwritten_by_text,
  (select count(*) from public.lead_insight where lead_source in ('Not Connected','New','Contacted','Nurturing','Qualified','Unqualified')) as leads_source_overwritten_by_status,
  (select count(*) from public.lead_insight where customer_name ~ '^[0-9+ -]{8,}$')                       as leads_name_looks_like_phone,
  (select count(*) from reporting.v_opportunity_summary where flag_mismatch > 0)                          as opportunity_groups_with_flag_mismatch,
  (select min(updated_at_ist) from public.wati_message_pivot)                                             as pivot_oldest_activity,
  (select max(updated_at_ist) from public.wati_message_pivot)                                             as pivot_latest_activity,
  (select count(*) from reporting.v_feed_health where feed_gap_suspected)                                 as days_with_suspected_feed_gap;

-- =====================================================================
-- PART 2 (optional, needs one small n8n change): an append-only log of every WATI status event.
-- Adds: sends per day, minutes to deliver / read / reply, repeat sends, failure reasons, and
-- double-delivery protection. Nothing existing is touched.
-- =====================================================================
create table if not exists public.wati_status_events (
  id                   bigserial primary key,
  event_key            text unique,                -- whatsappMessageId || '|' || eventType : stops double counting
  whatsapp_message_id  text,
  event_type           text,
  wa_id                text,
  template_id          text,
  template_name        text,                       -- only filled on the 'sent' event
  received_at          timestamptz not null default now(),
  raw_payload          jsonb                       -- keep it: the failure reason is likely in here
);
create index if not exists wati_status_events_msg_idx on public.wati_status_events (whatsapp_message_id);
create index if not exists wati_status_events_time_idx on public.wati_status_events (received_at);

drop view if exists reporting.v_message_timeline, reporting.v_status_events_daily cascade;

-- One row per message with the time of each stage. Unlike the pivot, every message gets its own row,
-- so repeat sends to the same number are measured too.
create or replace view reporting.v_message_timeline as
select
  whatsapp_message_id,
  max(wa_id)                                                                   as wa_id,
  max(template_name)                                                           as template_name,
  min(received_at) filter (where event_type = 'templateMessageSent_v2')        as sent_at,
  min(received_at) filter (where event_type = 'sentMessageDELIVERED_v2')       as delivered_at,
  min(received_at) filter (where event_type = 'sentMessageREAD_v2')            as read_at,
  min(received_at) filter (where event_type = 'sentMessageREPLIED_v2')         as replied_at,
  min(received_at) filter (where event_type = 'templateMessageFailed')         as failed_at,
  round((extract(epoch from (min(received_at) filter (where event_type = 'sentMessageREAD_v2')
        - min(received_at) filter (where event_type = 'templateMessageSent_v2'))) / 60.0)::numeric, 1)    as minutes_to_read,
  round((extract(epoch from (min(received_at) filter (where event_type = 'sentMessageREPLIED_v2')
        - min(received_at) filter (where event_type = 'templateMessageSent_v2'))) / 60.0)::numeric, 1)    as minutes_to_reply,
  (max((raw_payload ->> 'failedDetail')) filter (where event_type = 'templateMessageFailed'))               as failure_detail_guess
from public.wati_status_events
group by whatsapp_message_id;
-- Failed-message events, one row per failed message, with the template from the pivot when the event itself does not carry it.
-- The dashboard reads this view (not the table), so its read-only login needs no extra grant. The reason is read from raw_payload by the app.
create or replace view reporting.v_failure_events as
select e.whatsapp_message_id, coalesce(e.template_name, p.template_name) as template_name, e.received_at, e.raw_payload
from public.wati_status_events e
left join public.wati_message_pivot p on p.whatsappmessageid = e.whatsapp_message_id
where e.event_type = 'templateMessageFailed';

-- Every message we sent, one row each, with what happened to it and, when it failed, why. Built from the events n8n saves.
-- message_text is the sent text with the customer's details filled in, so the dashboard only shows it behind "Show numbers and messages".
-- The template and the number come from the 'sent' event, or from the pivot when that event was not saved.
create or replace view reporting.v_message_log as
with ev as (
  select whatsapp_message_id,
    max(wa_id)                                                                               as wa_id,
    max(raw_payload ->> 'templateName') filter (where event_type = 'templateMessageSent_v2') as template_name,
    max(raw_payload ->> 'text')         filter (where event_type = 'templateMessageSent_v2') as message_text,
    min(received_at) filter (where event_type = 'templateMessageSent_v2')   as sent_at,
    min(received_at) filter (where event_type = 'sentMessageDELIVERED_v2')  as delivered_at,
    min(received_at) filter (where event_type = 'sentMessageREAD_v2')       as read_at,
    min(received_at) filter (where event_type = 'sentMessageREPLIED_v2')    as replied_at,
    min(received_at) filter (where event_type = 'templateMessageFailed')    as failed_at,
    max(raw_payload ->> 'failedCode')   filter (where event_type = 'templateMessageFailed') as failed_code,
    max(raw_payload ->> 'failedDetail') filter (where event_type = 'templateMessageFailed') as failed_detail
  from public.wati_status_events
  where whatsapp_message_id is not null
  group by whatsapp_message_id
)
select ev.whatsapp_message_id,
  coalesce(ev.wa_id, p.phone_no)               as wa_id,
  coalesce(ev.template_name, p.template_name)  as template_name,
  ev.message_text, ev.sent_at, ev.delivered_at, ev.read_at, ev.replied_at, ev.failed_at, ev.failed_code, ev.failed_detail
from ev
left join (select distinct on (whatsappmessageid) whatsappmessageid, phone_no, template_name from public.wati_message_pivot order by whatsappmessageid) p on p.whatsappmessageid = ev.whatsapp_message_id;

-- failure_detail_guess reads a field called failedDetail. That name is a GUESS: open a few
-- templateMessageFailed rows, look at raw_payload, and change this to the real field name.

-- Events per day, template and type, in IST. This is the real "sends per day" trend.
create or replace view reporting.v_status_events_daily as
select
  (received_at at time zone 'Asia/Kolkata')::date as event_date_ist,
  coalesce(template_name, '(non-sent event)')     as template_name,
  event_type,
  count(*)                                        as events
from public.wati_status_events
group by 1, 2, 3;


-- ===== part 2: app.sql =====
-- Extra views for the Aquant Insight app (schema "reporting" comes from reporting_views.sql).
-- Read-only views only: nothing is written to your tables.
-- One row per lead / opportunity, with the known data problems already handled:
--   lead_source shows "(unknown: overwritten by status)" where workflow #7 replaced the real source with a status;
--   phone10 is empty where the phone number was replaced by text, so those leads cannot be linked to messages.

create schema if not exists reporting;
drop view if exists reporting.v_leads, reporting.v_opps cascade;

create or replace view reporting.v_leads as
select
  lead_id,
  owner_id,
  customer_name,
  customer_number,
  reporting.phone10(customer_number)                         as phone10,
  coalesce(customer_number ~ '[A-Za-z]', false)              as phone_overwritten,
  (coalesce(customer_number, '') = '')                       as phone_empty,
  case
    when lead_source in ('Not Connected','New','Contacted','Nurturing','Qualified','Unqualified') then '(unknown: overwritten by status)'
    when coalesce(lead_source, '') = '' then '(none)'
    else lead_source
  end                                                        as lead_source,
  coalesce(lead_source in ('Not Connected','New','Contacted','Nurturing','Qualified','Unqualified'), false) as source_overwritten,
  coalesce(lead_status, '(none)')                            as lead_status,
  coalesce(lead_manager_name, '(unassigned)')                as lead_owner,
  page_url,
  coalesce(welcome_message, 0)                               as welcome,
  coalesce(first_follow_up_message_after24hr, 0)             as followup_24h,
  coalesce("1st_follow_up_message", 0)                       as task1,
  coalesce("2nd_follow_up_message", 0)                       as task2,
  coalesce("3rd_follow_up_message", 0)                       as task3,
  coalesce(when_lead_converted_into_nurturing, 0)            as to_nurturing,
  coalesce(when_lead_converted_into_not_connected, 0)        as to_not_connected,
  coalesce(when_lead_converted_into_unqualified, 0)          as to_unqualified,
  created_at,
  updated_at,
  created_at::date                                           as created_date
from public.lead_insight;

create or replace view reporting.v_opps as
select
  opportunity_id,
  owner_id,
  customer_name,
  customer_number,
  reporting.phone10(customer_number)                         as phone10,
  coalesce(opportunity_status, '(none)')                     as opportunity_status,
  coalesce(opportunity_manager_name, '(unassigned)')         as opp_owner,
  coalesce(lead_manager_name, '')                            as lead_owner,
  coalesce(send_customer_details_to_salesperson, 0)          as details_to_salesperson,
  coalesce(send_salesman_details_to_customer, 0)             as details_to_customer,
  coalesce("1st_follow_up_message_after_48hr", 0)            as followup_48h,
  coalesce("2nd_follow_up_message_after_24hr", 0)            as followup_24h,
  coalesce(opportunity_won, 0)                               as won_flag,
  coalesce(opportunity_loss, 0)                              as loss_flag,
  created_at,
  updated_at,
  created_at::date                                           as created_date
from public.opportunity_insight;


-- ============================================================================
-- The read-only login the dashboard connects with
-- ============================================================================
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'dashboard_ro') then
    create role dashboard_ro login password 'CHANGE_ME_PASSWORD';
  end if;
end $$;

do $$ begin execute format('grant connect on database %I to dashboard_ro', current_database()); end $$;
grant usage on schema reporting to dashboard_ro;
grant select on all tables in schema reporting to dashboard_ro;
alter default privileges in schema reporting grant select on tables to dashboard_ro;
-- the Inbox and Customer lookup pages read these two source tables directly
grant usage on schema public to dashboard_ro;
grant select on public.wati_message_log, public.wati_sessions to dashboard_ro;
