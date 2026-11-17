// Agents page: who handles the WhatsApp chats, how fast they reply, and how many chats go unanswered.
// Read-only. No message text is ever read. Agent names are staff; customer phone numbers and names stay masked unless reveal=1 (and ALLOW_REVEAL is not false).
//
// THE UNIT is a WATI conversation (reporting.v_wati_conversations, filled every 15 minutes by the n8n "WATI Status Sync"), dated by the day the customer last wrote (India time).
// Broadcast-only rows (we messaged, the customer never wrote) are not conversations and are left out, like on the Chats page.
// THE OWNER is the person WATI says the conversation is assigned to now. Bots (Bot, KnowBot ...) are kept apart so they never flatter or hurt a person's numbers.
//
// REPLY TIME is how long the customer waited for a reply, from two sources, and every measurement says which one it came from:
//   "messages"  exact: the customer's first message we saved, to the first reply a PERSON typed after it (public.wati_messages, direction session, named operator that is not a bot).
//   "wati"      WATI's own record (last_effective_reply_at): the customer's LAST message, to WATI's reply time. Used when we saved no reply ourselves. Checked against the saved
//               messages on 16 Nov 2026: for the 18 chats that have both, WATI's reply time and ours agree within 2 minutes in all 18.
// Why both: the n8n workflow saves only a small share of team replies (47 against 439 customer messages up to 15 Nov), so the messages alone would miss most answered chats.
// A WATI reply that matches a saved BOT message (within 2 minutes) is not credited to a person.
// Wait time is real clock time, nights and weekends included: the page shows the hour customers wrote so slow hours are visible, but nothing is adjusted for office hours.
//
// Each chat gets ONE outcome from WATI's reply_state, so the outcomes always add up to the chats:
//   answered  the customer's latest message has been answered (by a person)
//   bot       the latest message was answered by a bot, not by the assigned person
//   waiting   the customer's latest message is unanswered and the 24 hours have not run out
//   missed    the customer's latest message was never answered and the 24 hours ran out
// (A chat that was answered earlier but where the customer wrote again and got no reply counts as waiting or missed; its earlier reply time still counts in the reply-time figures.)
// WHOSE TURN IT IS (`state`, shown in the chat list and the agent table): waiting_us = the customer wrote and nobody has replied (outcome waiting); waiting_customer = a person or a bot has
// replied (outcome answered or bot) and the chat is not closed, so we are waiting for the customer to write back; solved = closed in WATI; missed = never answered and the 24 hours ran out.

const BASE = `with bots as (select distinct assignee_name as n from reporting.v_wati_conversations where assignee_is_bot and assignee_name is not null),
  s as (select conversation_id, at_utc, coalesce(nullif(operator_name, ''), nullif(operator_email, '')) as who from reporting.v_chat_messages where direction = 'session' and conversation_id is not null),
  sh as (select * from s where who is not null and who not in (select n from bots)),
  conv as (
    select c.conversation_id, c.status, c.assignee_id, nullif(btrim(c.assignee_name), '') as assignee_name, coalesce(c.assignee_is_bot, false) as is_bot,
           c.reply_state, (coalesce(c.inbox_expired, false) or c.status = 'expired') as expired,
           c.last_customer_message_at as cust_last, c.last_effective_reply_at as w_reply,
           (c.last_customer_message_at at time zone 'Asia/Kolkata')::date as d,
           exists (select 1 from s where s.conversation_id = c.conversation_id and s.who in (select n from bots) and abs(extract(epoch from (s.at_utc - c.last_effective_reply_at))) <= 120) as wr_bot
    from reporting.v_wati_conversations c where c.status is distinct from 'broadcast' and c.last_customer_message_at is not null),
  i as (select conversation_id, min(at_utc) as c_first, max(phone10) as phone10, (array_agg(sender_name order by at_utc desc) filter (where sender_name is not null))[1] as customer
        from reporting.v_chat_messages where direction = 'inbound' and conversation_id is not null group by 1),
  fr as (select i.conversation_id, min(sh.at_utc) as m_reply from i join sh on sh.conversation_id = i.conversation_id and sh.at_utc > i.c_first group by 1),
  ch as (
    select conv.*, i.c_first, i.phone10, i.customer, fr.m_reply,
      coalesce(conv.assignee_name, case when conv.assignee_id is not null then 'Unknown agent' end) as owner,
      case when fr.m_reply is not null then fr.m_reply when conv.w_reply >= conv.cust_last and not conv.wr_bot then conv.w_reply end as reply_at,
      case when fr.m_reply is not null then i.c_first when conv.w_reply >= conv.cust_last and not conv.wr_bot then conv.cust_last end as wait_from,
      case when fr.m_reply is not null then 'messages' when conv.w_reply >= conv.cust_last and not conv.wr_bot then 'wati' end as src,
      case when conv.reply_state = 'replied' and conv.wr_bot and fr.m_reply is null then 'bot'
           when conv.reply_state = 'replied' then 'answered'
           when conv.expired then 'missed' else 'waiting' end as outcome
    from conv left join i on i.conversation_id = conv.conversation_id left join fr on fr.conversation_id = conv.conversation_id),
  cm as (select ch.*, case when reply_at is not null then round(greatest(0, extract(epoch from (reply_at - wait_from)) / 60.0)::numeric, 1)::float end as rt,
      -- whose turn it is, in plain words: the customer is waiting for us / a person or a bot has replied and we are waiting for the customer / closed in WATI / gone unanswered
      case when outcome = 'waiting' then 'waiting_us' when outcome = 'missed' then 'missed' when status = 'solved' then 'solved' else 'waiting_customer' end as state
    from ch)`

// the numbers every group of chats gets (a person, the team, a day, an hour)
const STATS = `count(*)::int as chats,
  count(*) filter (where outcome = 'answered')::int as answered, count(*) filter (where outcome = 'bot')::int as bot_answered,
  count(*) filter (where outcome = 'waiting')::int as waiting, count(*) filter (where outcome = 'missed')::int as missed,
  count(*) filter (where state = 'waiting_customer')::int as waiting_customer,
  count(rt)::int as measured, count(*) filter (where src = 'messages')::int as from_messages, count(*) filter (where src = 'wati')::int as from_wati,
  round((percentile_cont(0.5) within group (order by rt))::numeric, 1)::float as median, round((percentile_cont(0.9) within group (order by rt))::numeric, 1)::float as p90,
  round(avg(rt)::numeric, 1)::float as avg, min(rt) as fastest, max(rt) as slowest,
  count(*) filter (where rt <= 5)::int as within_5, count(*) filter (where rt <= 60)::int as within_60, count(*) filter (where rt <= 1440)::int as within_day`

export function makeAgents({ Q, where, MASK, NAME, TS, pct, grain, prevWindow, reveal }) {
  // owners=Name|Name narrows to those people; "cm.owner is not null" drops chats nobody owns (they are counted in the coverage box instead)
  const w = (q, extra = [], { owners = true } = {}) => where(owners ? q : { ...q, owners: undefined }, { date: 'cm.d', extra: ['cm.owner is not null', ...extra], lists: { 'cm.owner': 'owners' } })
  const missing = (e) => /(v_wati_conversations|v_chat_messages)/.test(e.message) && /(does not exist|permission denied)/.test(e.message)
  const guard = (fn) => async (q) => { try { return await fn(q) } catch (e) { if (missing(e)) return { setup: true }; throw e } }
  const withShares = (r) => r && ({
    ...r,
    answered_pct: pct(r.answered, r.chats), missed_pct: pct(r.missed, r.chats), waiting_pct: pct(r.waiting, r.chats),
    within_5_pct: pct(r.within_5, r.measured), within_60_pct: pct(r.within_60, r.measured), within_day_pct: pct(r.within_day, r.measured),
  })

  async function totals(q) {
    const x = w(q, ['not cm.is_bot'])
    const [r] = await Q(`${BASE} select count(distinct cm.owner)::int as agents, ${STATS} from cm ${x.sql}`, x.args)
    return withShares(r)
  }

  async function overview(q) {
    const g = grain(q)
    const hum = ['not cm.is_bot']
    const xAll = w(q, [], { owners: false }), xMeasured = w(q, [...hum, 'cm.rt is not null']), xTrend = w(q, hum), xHour = w(q, hum)
    const xChats = where(q, { date: 'cm.d' })   // the coverage box ignores the agent filter
    const MSG_DAY = "(s.at_utc at time zone 'Asia/Kolkata')::date"
    const xSent = where(q, { date: MSG_DAY, extra: ['s.who is not null', 's.who not in (select n from bots)'] })
    const xMsgs = where(q, { date: 'at_ist::date' })
    const pw = prevWindow(q)
    // everything below runs at the same time (one database round trip each, in parallel)
    const [agents, live, sent, team, prev, dist, trend, hours, cov, msgs, freshness] = await Promise.all([
      Q(`${BASE} select cm.owner as agent, bool_or(cm.is_bot) as is_bot, ${STATS}, count(*) filter (where cm.status = 'solved')::int as solved
        from cm ${xAll.sql} group by 1 order by 2, 3 desc, 1`, xAll.args),
      // open and pending are right now, so the dates do not apply
      Q(`${BASE} select cm.owner as agent, count(*) filter (where cm.status = 'open')::int as open, count(*) filter (where cm.status = 'pending')::int as pending
        from cm where cm.owner is not null and cm.status in ('open', 'pending') group by 1`),
      // replies a person typed (saved by n8n), by the day of the message
      Q(`with bots as (select distinct assignee_name as n from reporting.v_wati_conversations where assignee_is_bot and assignee_name is not null),
          s as (select at_utc, coalesce(nullif(operator_name, ''), nullif(operator_email, '')) as who from reporting.v_chat_messages where direction = 'session')
        select s.who as agent, count(*)::int as replies, ${TS("max(s.at_utc at time zone 'Asia/Kolkata')")} as last_reply from s ${xSent.sql} group by 1`, xSent.args),
      totals(q),
      pw ? totals({ ...q, ...pw }) : null,
      Q(`${BASE} select case when cm.rt < 1 then 1 when cm.rt < 5 then 2 when cm.rt < 15 then 3 when cm.rt < 60 then 4 when cm.rt < 360 then 5 when cm.rt < 1440 then 6 else 7 end as b, count(*)::int as n
        from cm ${xMeasured.sql} group by 1 order by 1`, xMeasured.args),
      Q(`${BASE} select to_char(date_trunc('${g}', cm.d), 'YYYY-MM-DD') as period, ${STATS} from cm ${xTrend.sql} group by 1 order by 1`, xTrend.args),
      // the hour the customer wrote (India time): slow hours are visible, nothing is adjusted for office hours
      Q(`${BASE} select extract(hour from (coalesce(cm.wait_from, cm.cust_last) at time zone 'Asia/Kolkata'))::int as hour, ${STATS} from cm ${xHour.sql} group by 1 order by 1`, xHour.args),
      // how much of the picture we can see (ignores the agent filter)
      Q(`${BASE} select count(*)::int as all_chats, count(*) filter (where cm.owner is null)::int as no_owner, count(*) filter (where cm.is_bot)::int as bot_chats,
          count(*) filter (where cm.owner is not null and not cm.is_bot)::int as human_chats,
          count(*) filter (where not cm.is_bot and cm.owner is not null and cm.rt is not null)::int as human_measured,
          count(*) filter (where not cm.is_bot and cm.owner is not null and cm.src = 'messages')::int as human_from_messages,
          count(*) filter (where not cm.is_bot and cm.owner is not null and cm.src = 'wati')::int as human_from_wati,
          count(*) filter (where cm.outcome = 'bot' and not cm.is_bot)::int as human_chats_bot_answered,
          ${TS("min(cm.cust_last at time zone 'Asia/Kolkata')")} as first_chat, ${TS("max(cm.cust_last at time zone 'Asia/Kolkata')")} as last_chat
        from cm ${xChats.sql}`, xChats.args),
      Q(`select count(*) filter (where direction = 'session')::int as team_msgs, count(*) filter (where direction = 'inbound')::int as cust_msgs,
          to_char(min(at_ist), 'YYYY-MM-DD') as first_day, to_char(max(at_ist), 'YYYY-MM-DD') as last_day from reporting.v_chat_messages ${xMsgs.sql}`, xMsgs.args),
      Q(`select to_char(max(evaluated_at) at time zone 'Asia/Kolkata', 'YYYY-MM-DD"T"HH24:MI:SS') as evaluated_at, to_char(min(last_customer_message_at) at time zone 'Asia/Kolkata', 'YYYY-MM-DD') as wati_from
        from reporting.v_wati_conversations where status is distinct from 'broadcast'`),
    ])
    const evaluated_at = freshness[0]?.evaluated_at ?? null, wati = freshness[0]

    const liveOf = new Map(live.map((r) => [r.agent, r])), sentOf = new Map(sent.map((r) => [r.agent, r]))
    const rows = agents.map((a) => withShares({
      ...a, open: liveOf.get(a.agent)?.open ?? 0, pending: liveOf.get(a.agent)?.pending ?? 0,
      replies: sentOf.get(a.agent)?.replies ?? 0, last_reply: sentOf.get(a.agent)?.last_reply ?? null,
    }))
    const BUCKETS = ['Under 1 min', '1 to 5 min', '5 to 15 min', '15 to 60 min', '1 to 6 hours', '6 to 24 hours', 'Over 24 hours']
    const byB = new Map(dist.map((d) => [d.b, d.n]))
    return {
      evaluated_at, grain: g,
      agents: rows.filter((r) => !r.is_bot), bots: rows.filter((r) => r.is_bot),
      team, previous: prev && prev.chats > 0 ? prev : null,
      distribution: BUCKETS.map((label, i) => ({ label, n: byB.get(i + 1) ?? 0 })),
      trend: trend.map((r) => withShares(r)),
      hours: Array.from({ length: 24 }, (_, h) => withShares(hours.find((x) => x.hour === h) ?? { hour: h, chats: 0, measured: 0, missed: 0 })),
      coverage: { ...cov[0], team_msgs: msgs[0].team_msgs, cust_msgs: msgs[0].cust_msgs, messages_from: msgs[0].first_day, messages_to: msgs[0].last_day, wati_from: wati?.wati_from ?? null },
    }
  }

  // The chats behind the numbers, newest first, each with its reply time and where that came from, so any figure can be checked.
  async function chats(q) {
    const show = reveal(q)
    const limit = Math.min(1000, Math.max(1, parseInt(q.limit, 10) || 100))
    const x = where(q, { date: 'cm.d', extra: ['cm.owner is not null'], lists: { 'cm.owner': 'owners', 'cm.state': 'status' } })
    const rows = await Q(`${BASE} select cm.conversation_id as id, cm.phone10, cm.customer, cm.owner, cm.is_bot, cm.outcome, cm.state, cm.src, cm.rt, cm.status,
        ${TS("cm.cust_last at time zone 'Asia/Kolkata'")} as cust_last, ${TS("cm.wait_from at time zone 'Asia/Kolkata'")} as wait_from, ${TS("cm.reply_at at time zone 'Asia/Kolkata'")} as reply_at
      from cm ${x.sql} order by cm.cust_last desc, cm.conversation_id limit ${limit}`, x.args)
    const nameOf = new Map()
    const need = [...new Set(rows.filter((r) => !String(r.customer ?? '').trim()).map((r) => r.phone10).filter(Boolean))]
    if (need.length) {
      try {
        const found = await Q(`select phone10, name from (
            select phone10, customer_name as name, created_at as at from reporting.v_leads where phone10 = any($1::text[])
            union all select phone10, customer_name, created_at from reporting.v_opps where phone10 = any($1::text[])) x
          where coalesce(trim(name), '') <> '' and name !~ '^[0-9+ ()-]{7,}$' order by at desc nulls last`, [need])
        for (const f of found) if (!nameOf.has(f.phone10)) nameOf.set(f.phone10, String(f.name).trim())
      } catch { /* the lead views are not there: names stay unknown */ }
    }
    return {
      revealed: show, canReveal: process.env.ALLOW_REVEAL !== 'false', limit,
      rows: rows.map((r) => ({
        id: r.id, owner: r.owner, is_bot: r.is_bot, outcome: r.outcome, state: r.state, src: r.src, rt: r.rt, wati_status: r.status,
        customer: (() => { const nm = String(r.customer ?? '').trim() || nameOf.get(r.phone10) || ''; return (show ? nm : NAME(nm)) || 'Name unknown' })(),
        phone: r.phone10 ? (show ? String(r.phone10) : MASK(r.phone10)) : null,
        cust_last: r.cust_last, wait_from: r.wait_from, reply_at: r.reply_at,
      })),
    }
  }

  return { 'agents/overview': guard(overview), 'agents/chats': guard(chats) }
}
