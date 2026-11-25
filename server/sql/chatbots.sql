-- ============================================================================
-- Chatbots page: four read-only views. Run ONCE as the database admin (Navicat / Supabase SQL Editor). Safe to run again.
-- Changes no table and copies no data. The views carry NO phone numbers and NO message text (only counts, days and the answers the chatbot recorded).
-- Needs: reporting.phone10() (reporting_views.sql), reporting.v_chat_messages (chats.sql), public.wati_messages, public.delhi_bot_log (the Delhi chatbot workflow
-- creates it), public.wati_status_events. Undo: drop view reporting.v_delhi_bot_events, reporting.v_delhi_bot_journeys, reporting.v_chatbot_messages, reporting.v_chatbot_triggers;
-- ============================================================================
create schema if not exists reporting;

-- 1. One row per Delhi chatbot event (n8n "ChatBot - Delhi ChatBot" logs every step in public.delhi_bot_log).
--    The answers are read out of the saved summary text ("Solution: ...", "Products: ...", "Timeline: ..."). The customer's own question text is NOT exposed, only whether they asked one.
--    first_for_customer_today = the first event of that customer on that India-time day (so a day's customers can be counted without a phone number).
create or replace view reporting.v_delhi_bot_events as
select d.id,
       (d.logged_at at time zone 'Asia/Kolkata')                                            as at_ist,
       (d.logged_at at time zone 'Asia/Kolkata')::date                                      as day,
       d.lead_stage,
       nullif(btrim(d.lead_tier), '')                                                       as lead_tier,
       d.outcome,
       nullif(btrim(substring(d.bot_summary from '(?:^|\n)Solution: *([^\n]*)')), '')       as solution,
       nullif(btrim(substring(d.bot_summary from '(?:^|\n)Products: *([^\n]*)')), '')       as products,
       nullif(btrim(substring(d.bot_summary from '(?:^|\n)Timeline: *([^\n]*)')), '')       as timeline,
       (nullif(btrim(substring(d.bot_summary from '(?:^|\n)Customer Question: *([^\n]*)')), '') is not null) as asked_question,
       nullif(btrim(substring(d.bot_summary from '(?:^|\n)Last Step: *([^\n]*)')), '')      as last_step,
       (row_number() over (partition by reporting.phone10(d.phone), (d.logged_at at time zone 'Asia/Kolkata')::date order by d.id) = 1) as first_for_customer_today
from public.delhi_bot_log d
where d.logged_at is not null and reporting.phone10(d.phone) <> '';

-- 2. One row per customer: how far the Delhi chatbot got with them. The answers come from the customer's LATEST event (each event carries everything answered so far).
--    first_day = the India-time day the customer first appears in the chatbot log (the opening message, or their first answer).
create or replace view reporting.v_delhi_bot_journeys as
with e as (select d.*, reporting.phone10(d.phone) as p10 from public.delhi_bot_log d where d.logged_at is not null and reporting.phone10(d.phone) <> ''),
     agg as (select p10, min((logged_at at time zone 'Asia/Kolkata')::date) as first_day, max((logged_at at time zone 'Asia/Kolkata')::date) as last_day, count(*)::int as events,
                    bool_or(lead_stage = 'opening_template') as opening_sent,
                    bool_or(lead_stage in ('solution_selected', 'timeline_selected', 'question_submitted', 'not_interested', 'closed_no_question')) as answered
             from e group by p10),
     last as (select distinct on (p10) p10, lead_stage, nullif(btrim(lead_tier), '') as lead_tier, bot_summary from e order by p10, id desc)
select a.first_day, a.last_day, a.events, a.opening_sent, a.answered,
       l.lead_stage                                                                         as final_stage,
       l.lead_tier                                                                          as final_tier,
       nullif(btrim(substring(l.bot_summary from '(?:^|\n)Solution: *([^\n]*)')), '')       as solution,
       nullif(btrim(substring(l.bot_summary from '(?:^|\n)Products: *([^\n]*)')), '')       as products,
       nullif(btrim(substring(l.bot_summary from '(?:^|\n)Timeline: *([^\n]*)')), '')       as timeline,
       (nullif(btrim(substring(l.bot_summary from '(?:^|\n)Customer Question: *([^\n]*)')), '') is not null) as asked_question
from agg a join last l on l.p10 = a.p10;

-- 3. Every message a WATI bot sent ("Bot" = the flow chatbots, "KnowBot" = the AI assistant), with the STEP it was, recognised from the bot's own wording (company-written scripts).
--    The text itself is not exposed. flow says which chatbot it belongs to: the Delhi chatbot's questions, the welcome bot, KnowBot, or other.
--    A new bot wording shows up as "Other bot message" until a line is added below.
create or replace view reporting.v_chatbot_messages as
select x.wati_id, x.chat_key, x.at_ist, x.at_ist::date as day, x.bot, x.step,
       case when x.bot = 'KnowBot' then 'KnowBot (AI assistant)'
            when x.step in ('Asked: solution', 'Asked: products', 'Asked: timeline', 'Asked: their question', 'Question received', 'Requirement noted', 'Closed: not interested', 'Goodbye') then 'Delhi chatbot'
            when x.step = 'Welcome' then 'Welcome bot'
            else 'Other bot messages' end as flow
from (
  select m.wati_id, m.chat_key, m.at_ist,
         case when lower(m.operator_name) = 'knowbot' then 'KnowBot' else 'Bot' end as bot,
         case when lower(m.operator_name) = 'knowbot'                                      then 'AI answer'
              when t.txt ilike 'What kind of bathroom solution%'                 then 'Asked: solution'
              when t.txt ilike 'Which products are you looking for%'             then 'Asked: products'
              when t.txt ilike 'By when are you planning%'                       then 'Asked: timeline'
              when t.txt ilike 'Please type your question%'                      then 'Asked: their question'
              when t.txt ilike 'Thanks for reaching out with your question%'     then 'Question received'
              when t.txt ilike '%noted down your requirement%'                   then 'Requirement noted'
              when t.txt ilike 'Thank you for letting us know%'                  then 'Closed: not interested'
              when t.txt ilike 'Thank you! Have a great day%'                    then 'Goodbye'
              when t.txt ilike 'Hello.%Welcome to Aquant%'                       then 'Welcome'
              else 'Other bot message' end as step
  from reporting.v_chat_messages m
  join public.wati_messages w on w.wati_id = m.wati_id
  cross join lateral (select btrim(w.message_text, E' \n\r\t') as txt) t
  where m.direction = 'session' and lower(m.operator_name) in ('bot', 'knowbot')
) x;

-- 4. WATI's "chatbot triggered" events (a customer's reply or button started one of WATI's chatbot flows). WATI only names the flow by an id.
--    Saved since 25 Nov 2026 only. The page shows the id; add "id,name" to config/chatbots.csv to show a name instead.
create or replace view reporting.v_chatbot_triggers as
select t.day, t.at_ist, t.chatbot_id,
       (row_number() over (partition by t.wa_id, t.chatbot_id, t.day order by t.at_ist) = 1) as first_for_customer_today
from (
  select distinct on (coalesce(e.raw_payload ->> 'id', e.event_key))
         (e.received_at at time zone 'Asia/Kolkata')::date as day, (e.received_at at time zone 'Asia/Kolkata') as at_ist,
         nullif(e.raw_payload ->> 'chatbotId', '') as chatbot_id, e.wa_id
  from public.wati_status_events e
  where e.event_type in ('chatbotTriggered', 'chatbotTriggered_bsuid') and e.raw_payload ->> 'chatbotId' is not null
  order by coalesce(e.raw_payload ->> 'id', e.event_key), e.received_at
) t;

-- Let the dashboard's read-only login see them (skipped if that login does not exist here).
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'dashboard_ro') then
    grant usage on schema reporting to dashboard_ro;
    grant select on reporting.v_delhi_bot_events, reporting.v_delhi_bot_journeys, reporting.v_chatbot_messages, reporting.v_chatbot_triggers to dashboard_ro;
  end if;
end $$;
