// The made-up database behind test_chatbots.mjs (in-memory Postgres via PGlite): 5 Delhi chatbot customers, 3 bot chats and 3 "chatbot triggered" events, worked out by hand.
// No real data. Times are relative to now, so it works on any day.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const here = path.dirname(fileURLToPath(import.meta.url))

export async function emptyDb() {
  const db = new PGlite()
  await db.exec(`create schema reporting;
    create function reporting.phone10(p text) returns text language sql immutable as $$ select right(regexp_replace(coalesce(p, ''), '\\D', '', 'g'), 10) $$;`)
  return db
}

export async function chatbotFixture() {
  const db = await emptyDb()
  await db.exec(`create table public.wati_messages (wati_id text primary key, direction text, phone_no text, template_name text, sender_name text, conversation_id text, ticket_id text,
    operator_email text, operator_name text, assignee_id text, sent_at timestamptz, received_at timestamptz, failed_at timestamptz, message_type text, delivered_at timestamptz, read_at timestamptz, replied_at timestamptz, message_text text);
    create table public.delhi_bot_log (id bigserial primary key, logged_at timestamptz default now(), received_at text, phone text, lead_stage text, lead_tier text, previous_tier text, sf_lead_id text, outcome text, reason text, bot_summary text, raw_body text, dedupe_key text);
    create table public.wati_status_events (id bigserial primary key, event_key text unique, whatsapp_message_id text, event_type text, wa_id text, template_id text, template_name text, received_at timestamptz not null default now(), raw_payload jsonb);`)
  await db.exec(fs.readFileSync(path.join(here, 'sql', 'chats.sql'), 'utf8'))
  await db.exec(fs.readFileSync(path.join(here, 'sql', 'chatbots.sql'), 'utf8'))
  const ago = (x) => `now() - interval '${x}'`
  const sum = (tier, sol, prod, time, q, step) => `Lead Tier: ${tier}\nSolution: ${sol}\nProducts: ${prod}\nOther Products: \nTimeline: ${time}\nCustomer Question: ${q}\nLast Step: ${step}`
  const log = (phone, stage, tier, outcome, summary, when) => `('${phone}', '${stage}', ${tier ? `'${tier}'` : 'null'}, '${outcome}', ${summary ? `$s$${summary}$s$` : 'null'}, ${when})`
  await db.exec(`insert into public.delhi_bot_log (phone, lead_stage, lead_tier, outcome, bot_summary, logged_at) values
  -- A: answered the solution and the timeline                              -> Warm, Complete solution, Within a month
  ${log('919800000001', 'opening_template', '', 'sent', '', ago('3 hours'))},
  ${log('919800000001', 'solution_selected', 'Warm', 'synced', sum('Warm', 'Complete solution', '', '', '', 'Answered solution type'), ago('2 hours 50 minutes'))},
  ${log('919800000001', 'timeline_selected', 'Warm', 'synced', sum('Warm', 'Complete solution', '', 'Within a month', '', 'Answered timeline'), ago('2 hours 40 minutes'))},
  -- B: specific products, timeline and a question                          -> Hot + Query
  ${log('919800000002', 'opening_template', '', 'sent', '', ago('3 hours'))},
  ${log('919800000002', 'solution_selected', 'Warm', 'synced', sum('Warm', 'Specific products', 'Showers', '', '', 'Answered solution type'), ago('2 hours 55 minutes'))},
  ${log('919800000002', 'timeline_selected', 'Warm', 'synced', sum('Warm', 'Specific products', 'Showers', 'Within a month', '', 'Answered timeline'), ago('2 hours 45 minutes'))},
  ${log('919800000002', 'question_submitted', 'Hot + Query', 'synced', sum('Hot + Query', 'Specific products', 'Showers', 'Within a month', 'will it fit a small bathroom', 'Asked a question'), ago('2 hours 30 minutes'))},
  -- C: not interested                                                      -> Unqualified
  ${log('919800000003', 'opening_template', '', 'sent', '', ago('3 hours'))},
  ${log('919800000003', 'not_interested', 'Unqualified', 'synced', sum('Unqualified', '', '', '', '', 'Not interested'), ago('2 hours 50 minutes'))},
  -- D: never answered, cold sweep                                          -> Cold
  ${log('919800000004', 'opening_template', '', 'sent', '', ago('3 hours'))},
  ${log('919800000004', 'no_reply', 'Cold', 'synced', '', ago('1 hour'))},
  -- E: only the opening message
  ${log('919800000005', 'opening_template', '', 'sent', '', ago('3 hours'))},
  -- F: a number that cannot be a phone: left out
  ${log('abc', 'opening_template', '', 'sent', '', ago('3 hours'))};`)
  await db.exec(`insert into public.wati_messages (wati_id, direction, phone_no, sender_name, ticket_id, operator_name, received_at, message_text) values
  -- chat T1: the Delhi chatbot asks three things
  ('m1', 'session', '919800000001', null, 'T1', 'Bot', ${ago('2 hours')}, 'What kind of bathroom solution are you looking for? 1. Complete solution 2. Specific products'),
  ('m2', 'session', '919800000001', null, 'T1', 'Bot', ${ago('110 minutes')}, 'By when are you planning to get the work done? 1. Within a month'),
  ('m3', 'session', '919800000001', null, 'T1', 'Bot', ${ago('100 minutes')}, E'  Thank you! We\\'ve noted down your requirement, and our local team will call you'),
  -- a person's reply in T1: never a bot message
  ('m4', 'session', '919800000001', null, 'T1', 'Priya', ${ago('90 minutes')}, 'Hello, this is Priya'),
  -- chat T2: the Delhi chatbot's first question, and the welcome bot (the text has a line break after "Hello.")
  ('m5', 'session', '919800000002', null, 'T2', 'Bot', ${ago('2 hours')}, 'What kind of bathroom solution are you looking for?'),
  ('m6', 'session', '919800000002', null, 'T2', 'Bot', ${ago('1 hour')}, E'Hello.\\nWelcome to Aquant - Contemporary Bathrooms.'),
  -- chat T3: the AI assistant
  ('m7', 'session', '919800000003', null, 'T3', 'KnowBot', ${ago('1 hour')}, 'I am sorry, I do not have any pictures available.');`)
  await db.exec(`insert into public.wati_status_events (event_key, event_type, wa_id, received_at, raw_payload) values
  ('e1|a', 'chatbotTriggered',        '919800000001', ${ago('2 hours')},    '{"id":"e1","chatbotId":"botA","text":"Yes, let us continue"}'),
  ('e1|b', 'chatbotTriggered_bsuid',  '919800000001', ${ago('2 hours')},    '{"id":"e1","chatbotId":"botA","text":"Yes, let us continue"}'),
  ('e2|b', 'chatbotTriggered_bsuid',  '919800000001', ${ago('119 minutes')},'{"id":"e2","chatbotId":"botA","text":"again"}'),
  ('e3|b', 'chatbotTriggered_bsuid',  '919800000002', ${ago('2 hours')},    '{"id":"e3","chatbotId":"botB","text":"Not right now"}'),
  ('x1|b', 'templateMessageSent_v2',  '919800000009', ${ago('2 hours')},    '{"id":"x1"}');`)
  return db
}
