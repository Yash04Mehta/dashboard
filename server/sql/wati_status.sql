-- ============================================================================
-- WATI status sync: WATI's own ticket status, owner and tags for every recent conversation.
-- WHY: WATI sends no webhook when a ticket is assigned or its status changes, so the dashboard could only guess "Open / Pending / Solved" and the owner.
-- WATI's API can say (POST /api/ext/v3/conversations/query). The n8n workflow "WATI Status Sync" calls it every 15 minutes and passes each page of
-- the answer to sync_wati_conversations() below; it also saves the operator list (names, and whether an operator is a bot) with sync_wati_operators().
-- Run ONCE as the database admin (Supabase SQL editor). Safe to run again. Only adds new tables, functions and read-only views; changes nothing existing.
-- ============================================================================
create schema if not exists reporting;

create table if not exists public.wati_operators (
  operator_id text primary key,
  name        text,
  first_name  text,
  email       text,
  is_bot      boolean not null default false,
  bot_type    text,
  roles       text,
  updated_at  timestamptz not null default now()
);

-- The latest status of each conversation (one row each, updated on every sync).
create table if not exists public.wati_conversation_status (
  conversation_id             text primary key,
  contact_id                  text,
  channel_type                text,
  status                      text,          -- new, open, pending, solved, expired, broadcast, awaiting_response
  assignee_id                 text,
  assignment                  text,          -- assigned / unassigned
  tags                        jsonb not null default '[]'::jsonb,   -- [{id, name}]
  last_customer_message_at    timestamptz,
  reply_state                 text,          -- awaiting_business, replied, unknown
  last_effective_reply_at     timestamptz,
  waiting_seconds             bigint,
  inbox_expired               boolean,
  session_state               text,
  reply_window_expires_at     timestamptz,
  evaluated_at                timestamptz,
  first_seen_at               timestamptz not null default now(),
  last_changed_at             timestamptz not null default now(),   -- when the status or the owner last changed
  updated_at                  timestamptz not null default now()
);
create index if not exists wati_conversation_status_msg_idx on public.wati_conversation_status (last_customer_message_at);

-- A line every time a conversation is first seen or its status or owner changes: this is the history WATI itself does not give out.
create table if not exists public.wati_conversation_status_log (
  id              bigserial primary key,
  conversation_id text not null,
  status          text,
  assignee_id     text,
  seen_at         timestamptz not null default now()
);
create index if not exists wati_conversation_status_log_idx on public.wati_conversation_status_log (conversation_id, seen_at);
create index if not exists wati_conversation_status_log_time_idx on public.wati_conversation_status_log (seen_at);

alter table public.wati_operators                 enable row level security;   -- no policies: not readable through a public web API
alter table public.wati_conversation_status       enable row level security;
alter table public.wati_conversation_status_log   enable row level security;

-- Saves one page of WATI's answer ({"items": [...]}; a plain array also works). Returns how many conversations arrived, how many were new, how many changed.
create or replace function public.sync_wati_conversations(p jsonb)
returns table (received int, new_conversations int, changed int)
language plpgsql
as $$
declare
  items jsonb := case when jsonb_typeof(p) = 'array' then p else p -> 'items' end;
  n_recv int; n_new int; n_log int;
begin
  if jsonb_typeof(items) is distinct from 'array' then
    raise exception 'sync_wati_conversations: no items array in the input (is this the answer of POST /api/ext/v3/conversations/query?)';
  end if;

  drop table if exists _wati_src;
  create temp table _wati_src on commit drop as
  select distinct on (x ->> 'conversation_id')
         x ->> 'conversation_id'                                              as cid,
         x ->> 'contact_id'                                                   as contact_id,
         x #>> '{channel,type}'                                               as channel_type,
         x ->> 'status'                                                       as status,
         nullif(x ->> 'assignee_id', '')                                      as assignee_id,
         x ->> 'assignment'                                                   as assignment,
         case when jsonb_typeof(x -> 'tags') = 'array' then x -> 'tags' else '[]'::jsonb end as tags,
         nullif(x ->> 'last_customer_message_at', '')::timestamptz            as last_customer_message_at,
         x ->> 'reply_state'                                                  as reply_state,
         nullif(x ->> 'last_effective_reply_at', '')::timestamptz             as last_effective_reply_at,
         nullif(x ->> 'waiting_seconds', '')::bigint                          as waiting_seconds,
         (x ->> 'inbox_expired')::boolean                                     as inbox_expired,
         x ->> 'session_state'                                                as session_state,
         nullif(x ->> 'reply_window_expires_at', '')::timestamptz             as reply_window_expires_at,
         nullif(x ->> 'evaluated_at', '')::timestamptz                        as evaluated_at
  from jsonb_array_elements(items) x
  where nullif(x ->> 'conversation_id', '') is not null
  order by x ->> 'conversation_id', nullif(x ->> 'evaluated_at', '')::timestamptz desc nulls last;

  select count(*) into n_recv from _wati_src;
  select count(*) into n_new from _wati_src s where not exists (select 1 from public.wati_conversation_status t where t.conversation_id = s.cid);

  -- history first (before the upsert hides what changed)
  insert into public.wati_conversation_status_log (conversation_id, status, assignee_id)
  select s.cid, s.status, s.assignee_id
  from _wati_src s left join public.wati_conversation_status t on t.conversation_id = s.cid
  where t.conversation_id is null or t.status is distinct from s.status or t.assignee_id is distinct from s.assignee_id;
  get diagnostics n_log = row_count;

  insert into public.wati_conversation_status as t
    (conversation_id, contact_id, channel_type, status, assignee_id, assignment, tags, last_customer_message_at, reply_state, last_effective_reply_at,
     waiting_seconds, inbox_expired, session_state, reply_window_expires_at, evaluated_at)
  select cid, contact_id, channel_type, status, assignee_id, assignment, tags, last_customer_message_at, reply_state, last_effective_reply_at,
         waiting_seconds, inbox_expired, session_state, reply_window_expires_at, evaluated_at
  from _wati_src
  on conflict (conversation_id) do update set
    contact_id = excluded.contact_id, channel_type = excluded.channel_type, status = excluded.status, assignee_id = excluded.assignee_id,
    assignment = excluded.assignment, tags = excluded.tags, last_customer_message_at = excluded.last_customer_message_at, reply_state = excluded.reply_state,
    last_effective_reply_at = excluded.last_effective_reply_at, waiting_seconds = excluded.waiting_seconds, inbox_expired = excluded.inbox_expired,
    session_state = excluded.session_state, reply_window_expires_at = excluded.reply_window_expires_at, evaluated_at = excluded.evaluated_at,
    last_changed_at = case when t.status is distinct from excluded.status or t.assignee_id is distinct from excluded.assignee_id then now() else t.last_changed_at end,
    updated_at = now();

  return query select n_recv, n_new, greatest(n_log - n_new, 0);
end $$;

-- Saves WATI's operator list (the answer of GET /api/v1/operators: {"result": [...]}) including bots, so an owner id can be shown as a name and a bot can be told from a person.
create or replace function public.sync_wati_operators(p jsonb)
returns table (operators_seen int)
language plpgsql
as $$
declare n int;
begin
  if jsonb_typeof(p -> 'result') is distinct from 'array' then
    raise exception 'sync_wati_operators: no result array in the input (is this the answer of GET /api/v1/operators?)';
  end if;
  insert into public.wati_operators as o (operator_id, name, first_name, email, is_bot, bot_type, roles)
  select distinct on (x ->> 'id') x ->> 'id', nullif(x ->> 'fullName', ''), nullif(x ->> 'firstName', ''), lower(nullif(x ->> 'email', '')),
         coalesce((x ->> 'isBot')::boolean, false), nullif(x ->> 'botType', ''),
         case when jsonb_typeof(x -> 'roles') = 'array' then (select string_agg(r, ', ') from jsonb_array_elements_text(x -> 'roles') r) end
  from jsonb_array_elements(p -> 'result') x
  where nullif(x ->> 'id', '') is not null
  on conflict (operator_id) do update set name = excluded.name, first_name = excluded.first_name, email = excluded.email, is_bot = excluded.is_bot,
    bot_type = excluded.bot_type, roles = excluded.roles, updated_at = now();
  get diagnostics n = row_count;
  return query select n;
end $$;

-- Only the database login that n8n uses should be able to run them (not Supabase's public API roles).
revoke execute on function public.sync_wati_conversations(jsonb), public.sync_wati_operators(jsonb) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke execute on function public.sync_wati_conversations(jsonb), public.sync_wati_operators(jsonb) from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke execute on function public.sync_wati_conversations(jsonb), public.sync_wati_operators(jsonb) from authenticated; end if;
end $$;

-- What the dashboard reads: each conversation with the owner's name and whether the owner is a bot.
create or replace view reporting.v_wati_conversations as
select c.conversation_id, c.contact_id, c.channel_type, c.status, c.assignee_id,
       coalesce(o.name, o.email)        as assignee_name,
       coalesce(o.is_bot, false)        as assignee_is_bot,
       c.assignment, c.tags, c.last_customer_message_at, c.reply_state, c.last_effective_reply_at, c.waiting_seconds,
       c.inbox_expired, c.session_state, c.evaluated_at, c.first_seen_at, c.last_changed_at, c.updated_at
from public.wati_conversation_status c
left join public.wati_operators o on o.operator_id = c.assignee_id;

create or replace view reporting.v_wati_status_log as
select conversation_id, status, assignee_id, seen_at from public.wati_conversation_status_log;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'dashboard_ro') then
    grant usage on schema reporting to dashboard_ro;
    grant select on reporting.v_wati_conversations, reporting.v_wati_status_log to dashboard_ro;
  end if;
end $$;
