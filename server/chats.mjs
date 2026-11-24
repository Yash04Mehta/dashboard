// Chats v1: the WATI-style chat overview, built from the messages n8n saves in public.wati_messages (through reporting.v_chat_messages, see sql/chats.sql).
// Read-only. Phones are masked and no message text is ever read: this view has none.
//
// A chat is one WATI ticket (see the view for the fallbacks). Its status is OUR measure from the messages we hold, not WATI's ticket status:
//   outbound  the customer never wrote (only templates went out)
//   replied   the team wrote after the customer's latest message
//   waiting   the customer's latest message is under 24 h old and nobody has answered it
//   missed    the customer's latest message is over 24 h old and nobody answered it (the free reply window has closed)
// Assigned = the customer wrote and a person owns the chat (an assignee id on a message, or a named team member who replied). Unassigned counts customer chats only.
// A chat is dated by its first message (India time). Template cost uses config/rate_card.csv exactly like the Costs page.
import { makePricer } from './costs.mjs'

// WATI's chatbots send their messages as session messages too. WATI names them "Bot" (flow chatbots) and "KnowBot" (the AI assistant); WATI's operator
// list (sql/wati_status.sql) adds any other bot that owns chats. Bot messages are NOT team replies: they are left out of "Replies from our team", reply time
// and the person who replied. They still count as an answer for the chat status (the customer did get a reply).
export const BOT_NAMES = ['bot', 'knowbot']
const botTest = (withWati) => `(lower(op) = any(array['${BOT_NAMES.join("','")}'])${withWati ? ' or op in (select assignee_name from reporting.v_wati_conversations where assignee_is_bot and assignee_name is not null)' : ''})`
const mkBase = (withAsg, withWati) => `with m0 as (
    select chat_key, direction, at_utc, at_ist, phone10, sender_name, assignee_id, failed_at, template_name, conversation_id,
           nullif(coalesce(nullif(operator_name, ''), operator_email), '') as op
    from reporting.v_chat_messages),
  m as (select m0.*, (m0.direction = 'session' and m0.op is not null and ${botTest(withWati)}) as by_bot from m0),
  names as (select assignee_id as aid, max(op) as op from m where assignee_id is not null and op is not null group by 1),
  c0 as (
    select chat_key, min(at_ist) as first_at, max(at_ist) as last_at, count(*)::int as msgs,
      count(*) filter (where direction = 'inbound')::int as cust_msgs,
      count(*) filter (where direction = 'session' and not by_bot)::int as team_msgs,
      count(*) filter (where by_bot)::int as bot_msgs,
      count(*) filter (where direction = 'template' and failed_at is null)::int as templates,
      min(at_utc) as first_utc, max(at_utc) as last_utc,
      min(at_utc) filter (where direction = 'inbound') as first_cust,
      max(at_utc) filter (where direction = 'inbound') as last_cust,
      max(at_utc) filter (where direction = 'session') as last_team,
      (array_agg(phone10 order by at_utc desc))[1] as phone10,
      (array_agg(sender_name order by at_utc desc) filter (where sender_name is not null))[1] as customer,
      (array_agg(assignee_id order by at_utc desc) filter (where assignee_id is not null))[1] as aid,
      (array_agg(conversation_id order by at_utc desc) filter (where conversation_id is not null))[1] as conv,
      (array_agg(op order by at_utc desc) filter (where direction = 'session' and op is not null and not by_bot))[1] as replier
    from m group by chat_key),
  rep as (select c0.chat_key, min(s.at_utc) as first_reply from c0 join m s on s.chat_key = c0.chat_key and s.direction = 'session' and not s.by_bot and s.at_utc > c0.first_cust group by 1),
  ch as (
    select c0.*, c0.first_at::date as d, rep.first_reply,
      round((extract(epoch from (rep.first_reply - c0.first_cust)) / 60.0)::numeric, 1)::float as fr_min,
      (c0.cust_msgs > 0 and (c0.aid is not null or c0.replier is not null${withAsg ? ' or a.operator_email is not null' : ''}${withWati ? ' or wc.assignee_id is not null' : ''})) as assigned,
      coalesce(${withWati ? "case when wc.assignee_id is not null then coalesce(wc.assignee_name, 'Name unknown') end, " : ''}case when c0.cust_msgs > 0 then coalesce(n.op, ${withAsg ? 'a.operator_name, a.operator_email, ' : ''}c0.replier, case when c0.aid is not null then 'Name unknown' end) end) as owner,   -- WATI's own owner first (matched by conversation id); else, only for chats where the customer wrote, what the messages show
      case when c0.cust_msgs = 0 then 'outbound' when c0.last_team > c0.last_cust then 'replied'
           when c0.last_cust >= now() - interval '24 hours' then 'waiting' else 'missed' end as status,
      (c0.cust_msgs > 0 and c0.last_cust < now() - interval '24 hours') as window_closed
    from c0 left join rep on rep.chat_key = c0.chat_key left join names n on n.aid = c0.aid${withAsg ? ASG_JOIN : ''}${withWati ? ' left join reporting.v_wati_conversations wc on wc.conversation_id = c0.conv' : ''})`

// Who the chat was assigned to, as saved by the n8n step "Save assignment" (sql/assignments.sql). WATI's webhook never carries it and a message only shows an owner
// once it is sent AFTER the assignment, so without this a chat that was assigned seconds after the customer wrote looks ownerless.
// The latest assignment for that number within an hour before the chat's first message and an hour after its last one counts as its owner.
const ASG_JOIN = ` left join lateral (select x.operator_name, x.operator_email from reporting.v_chat_assignments x
      where x.phone10 = c0.phone10 and x.assigned_at >= c0.first_utc - interval '1 hour' and x.assigned_at <= c0.last_utc + interval '1 hour'
      order by x.assigned_at desc limit 1) a on true`

const r2 = (v) => Math.round(v * 100) / 100

export function makeChats({ Q, where, MASK, NAME, TS, pct, grain, prevWindow, reveal }) {
  const chWhere = (q, extra, lists) => where(q, { date: 'ch.d', extra, lists: { 'ch.owner': 'owners', ...lists } })   // owners=Name|Name: only chats owned by those team members

  // is the assignments view installed? asked at most once a minute; the chat queries add the owner lookup only when it is
  let asgProbe = { at: 0, ok: false }
  const hasAssignments = async () => {
    if (Date.now() - asgProbe.at < 60000) return asgProbe.ok
    let ok = false
    try { await Q('select 1 from reporting.v_chat_assignments limit 1'); ok = true } catch { /* not installed yet */ }
    asgProbe = { at: Date.now(), ok }
    return ok
  }
  // is WATI's own owner list (sql/wati_status.sql, filled by the n8n "WATI Status Sync") installed and not empty? Then it is the first source of a chat's owner.
  let watiProbe = { at: 0, ok: false }
  const hasWatiOwners = async () => {
    if (Date.now() - watiProbe.at < 60000) return watiProbe.ok
    let ok = false
    try { ok = (await Q('select 1 from reporting.v_wati_conversations limit 1')).length > 0 } catch { /* not installed yet */ }
    watiProbe = { at: Date.now(), ok }
    return ok
  }
  const base = async () => mkBase(await hasAssignments(), await hasWatiOwners())

  // If the view is not installed (or the login cannot read it) every endpoint answers { setup: true } and the page says what to do.
  const guard = (fn) => async (q) => {
    try { return await fn(q) }
    catch (e) { if (/v_chat_messages/.test(e.message) && /(does not exist|permission denied)/.test(e.message)) return { setup: true }; throw e }
  }

  async function totals(q) {
    const w = chWhere(q)
    const [r] = await Q(`${await base()} select count(*)::int as chats,
        count(*) filter (where cust_msgs > 0)::int as customer_chats,
        count(*) filter (where status = 'waiting')::int as waiting, count(*) filter (where status = 'replied')::int as replied,
        count(*) filter (where status = 'missed')::int as missed, count(*) filter (where status = 'outbound')::int as outbound,
        count(*) filter (where window_closed)::int as window_closed,
        count(*) filter (where assigned)::int as assigned, count(*) filter (where cust_msgs > 0 and not assigned)::int as unassigned,
        coalesce(sum(cust_msgs), 0)::int as cust_msgs, coalesce(sum(team_msgs), 0)::int as team_msgs, coalesce(sum(bot_msgs), 0)::int as bot_msgs, coalesce(sum(templates), 0)::int as templates, coalesce(sum(msgs), 0)::int as messages,
        count(*) filter (where fr_min is not null)::int as answered, count(*) filter (where fr_min <= 5)::int as within_5, count(*) filter (where fr_min <= 60)::int as within_hour,
        round((percentile_cont(0.5) within group (order by fr_min))::numeric, 1)::float as fr_median, round(avg(fr_min)::numeric, 1)::float as fr_avg
      from ch ${w.sql}`, w.args)
    const cc = r.customer_chats
    return { ...r, replied_pct: pct(r.replied, r.chats), waiting_pct: pct(r.waiting, r.chats), missed_pct: pct(r.missed, r.chats), outbound_pct: pct(r.outbound, r.chats),
      window_closed_pct: pct(r.window_closed, r.chats), assigned_pct: pct(r.assigned, cc), unassigned_pct: pct(r.unassigned, cc), customer_pct: pct(cc, r.chats),
      within_hour_pct: pct(r.within_hour, cc), within_5_pct: pct(r.within_5, cc), msgs_per_chat: r.chats ? Math.round((10 * r.messages) / r.chats) / 10 : null }
  }
  async function kpis(q) {
    const [cov] = await Q(`select to_char(min(at_ist), 'YYYY-MM-DD') as from_day, to_char(max(at_ist), 'YYYY-MM-DD') as to_day, count(*)::int as messages from reporting.v_chat_messages`)
    if (!cov.messages) return { empty: true, coverage: cov }
    const pw = prevWindow(q)
    return { coverage: cov, owners_from_assignments: await hasAssignments(), current: await totals(q), previous: pw ? await totals({ ...q, ...pw }) : null }
  }

  async function trend(q) {
    const g = grain(q); const w = chWhere(q)
    const rows = await Q(`${await base()} select to_char(date_trunc('${g}', ch.d), 'YYYY-MM-DD') as period, count(*)::int as chats,
        count(*) filter (where status = 'waiting')::int as waiting, count(*) filter (where status = 'replied')::int as replied, count(*) filter (where status = 'missed')::int as missed,
        count(*) filter (where status = 'outbound')::int as outbound, count(*) filter (where cust_msgs > 0 and not assigned)::int as unassigned
      from ch ${w.sql} group by 1 order by 1`, w.args)
    return { grain: g, rows }
  }

  // Chats with 2+ messages: how many, and the average minutes between their first and last message (WATI's "ticket duration vs count").
  async function duration(q) {
    const g = grain(q); const w = chWhere(q, ['ch.msgs > 1'])
    const rows = await Q(`${await base()} select to_char(date_trunc('${g}', ch.d), 'YYYY-MM-DD') as period, count(*)::int as chats,
        round(avg(extract(epoch from (ch.last_at - ch.first_at)) / 60.0)::numeric, 0)::float as avg_min
      from ch ${w.sql} group by 1 order by 1`, w.args)
    return { grain: g, rows }
  }

  // Weekday x hour of each chat's first message (India time). Weekday 0 = Sunday. Only cells with chats are returned.
  async function heatmap(q) {
    const w = chWhere(q)
    const rows = await Q(`${await base()} select extract(dow from ch.first_at)::int as dow, extract(hour from ch.first_at)::int as hour, count(*)::int as chats,
        count(*) filter (where cust_msgs > 0 and not assigned)::int as unassigned
      from ch ${w.sql} group by 1, 2 order by 1, 2`, w.args)
    return { cells: rows }
  }

  // One row per team member who owns chats (WATI's "Operator performance"). Owner = the assignee, else the named person who replied.
  async function operators(q) {
    const w = chWhere(q, ['ch.assigned'])
    const rows = await Q(`${await base()} select ch.owner as operator, count(*)::int as chats, coalesce(sum(ch.team_msgs), 0)::int as team_msgs, coalesce(sum(ch.cust_msgs), 0)::int as cust_msgs,
        count(*) filter (where status = 'missed')::int as missed, count(*) filter (where status = 'waiting')::int as waiting,
        count(*) filter (where fr_min is not null)::int as answered, count(*) filter (where fr_min <= 60)::int as within_hour,
        round((percentile_cont(0.5) within group (order by fr_min))::numeric, 1)::float as fr_median,
        coalesce(sum(ch.templates), 0)::int as templates, ${TS('max(ch.last_at)')} as last_active
      from ch ${w.sql} group by 1 order by 2 desc, 1`, w.args)
    return { rows: rows.map((r) => ({ ...r, within_hour_pct: pct(r.within_hour, r.chats) })) }
  }

  // Template spend inside chats: every template that was sent and did not fail, priced by name and send date with the Costs page's rate card.
  // Grouped by the chat's status so "money spent on chats nobody answered" is one number. Spend is dated by the chat, price by the send date.
  async function cost(q) {
    const g = grain(q); const w = chWhere(q)
    const p = makePricer(q.assume)
    const sends = await Q(`${await base()}, t as (select chat_key, template_name, at_ist::date as d from m where direction = 'template' and failed_at is null and template_name is not null)
      select ch.status, t.template_name, t.d::text as d, to_char(date_trunc('${g}', ch.d), 'YYYY-MM-DD') as period, count(*)::int as n
      from ch join t on t.chat_key = ch.chat_key ${w.sql} group by 1, 2, 3, 4`, w.args)
    const counts = await Q(`${await base()} select ch.status, to_char(date_trunc('${g}', ch.d), 'YYYY-MM-DD') as period, count(*)::int as chats from ch ${w.sql} group by 1, 2`, w.args)

    const byStatus = new Map(), byPeriod = new Map(), byTpl = new Map()
    const st = (s) => byStatus.get(s) ?? (byStatus.set(s, { status: s, chats: 0, units: 0, spend: 0 }), byStatus.get(s))
    const pd = (s) => byPeriod.get(s) ?? (byPeriod.set(s, { period: s, chats: 0, units: 0, spend: 0 }), byPeriod.get(s))
    for (const r of counts) { st(r.status).chats += r.chats; pd(r.period).chats += r.chats }
    let spend = 0, units = 0, assumedUnits = 0
    for (const r of sends) {
      const pr = p.price(r.template_name, r.d), c = pr.price * r.n
      spend += c; units += r.n; if (pr.assumed) assumedUnits += r.n
      const s = st(r.status); s.units += r.n; s.spend += c
      const x = pd(r.period); x.units += r.n; x.spend += c
      const t = byTpl.get(r.template_name) ?? { template: r.template_name, category: pr.category, units: 0, spend: 0, assumed: pr.assumed }
      t.units += r.n; t.spend += c; byTpl.set(r.template_name, t)
    }
    const chats = [...byStatus.values()].reduce((s, x) => s + x.chats, 0)
    const spendOf = (s) => byStatus.get(s)?.spend ?? 0
    const flags = p.flags()
    return {
      currency: p.currency, assume: p.assume, placeholder: flags.placeholder, unpriced: flags.unpriced, problems: p.problems, grain: g,
      totals: { spend: r2(spend), units, chats, assumed_units: assumedUnits, cost_per_chat: chats ? r2(spend / chats) : null,
        no_reply_spend: r2(spendOf('outbound')), missed_spend: r2(spendOf('missed')), no_reply_pct: pct(spendOf('outbound'), spend), missed_pct: pct(spendOf('missed'), spend) },
      by_status: [...byStatus.values()].map((x) => ({ ...x, spend: r2(x.spend), cost_per_chat: x.chats ? r2(x.spend / x.chats) : null })),
      by_period: [...byPeriod.values()].map((x) => ({ ...x, spend: r2(x.spend) })).sort((a, b) => (a.period < b.period ? -1 : 1)),
      by_template: [...byTpl.values()].map((x) => ({ ...x, spend: r2(x.spend) })).sort((a, b) => b.spend - a.spend || b.units - a.units).slice(0, 30),
    }
  }

  // The chats themselves, newest activity first (up to 200), each with its template cost. Numbers and names stay masked unless reveal=1 (and ALLOW_REVEAL is not false).
  async function list(q) {
    const show = reveal(q)
    const limit = Math.min(1000, Math.max(1, parseInt(q.limit, 10) || 200))
    // status=unassigned is not a status: it means "the customer wrote and nobody owns the chat" (the same rule as the Unassigned tile), whatever the chat's status is
    const unassignedOnly = String(q.status ?? '').trim() === 'unassigned'
    const w = chWhere(unassignedOnly ? { ...q, status: undefined } : q, unassignedOnly ? ['ch.cust_msgs > 0', 'not ch.assigned'] : undefined, { 'ch.status': 'status' })
    const rows = await Q(`${await base()} select ch.chat_key, ch.phone10, ch.customer, ch.status, ch.owner, ch.assigned, ch.cust_msgs, ch.team_msgs, ch.templates, ch.fr_min,
        ${TS('ch.first_at')} as first_at, ${TS('ch.last_at')} as last_at
      from ch ${w.sql} order by ch.last_at desc, ch.chat_key limit ${limit}`, w.args)
    const p = makePricer(q.assume)
    const costOf = new Map()
    if (rows.length) {
      const sends = await Q(`select chat_key, template_name, at_ist::date::text as d, count(*)::int as n from reporting.v_chat_messages
        where chat_key = any($1::text[]) and direction = 'template' and failed_at is null and template_name is not null group by 1, 2, 3`, [rows.map((r) => r.chat_key)])
      for (const s of sends) costOf.set(s.chat_key, (costOf.get(s.chat_key) ?? 0) + p.price(s.template_name, s.d).price * s.n)
    }
    // WhatsApp only gives us a name when the customer writes. For chats where only we have messaged, use the name from the Salesforce lead (or opportunity) with the
    // same phone number: the newest one wins, and a "name" that is really a phone number is ignored. The customer's own WhatsApp name always comes first.
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
      revealed: show, canReveal: process.env.ALLOW_REVEAL !== 'false', currency: p.currency, limit,
      rows: rows.map((r) => ({
        key: r.chat_key, status: r.status, owner: r.owner, assigned: r.assigned, unassigned: r.status !== 'outbound' && !r.assigned,
        customer: (() => { const nm = String(r.customer ?? '').trim() || nameOf.get(r.phone10) || ''; return (show ? nm : NAME(nm)) || 'Name unknown' })(),
        phone: show ? String(r.phone10 ?? '') : MASK(r.phone10),
        cust_msgs: r.cust_msgs, team_msgs: r.team_msgs, templates: r.templates, first_response_min: r.fr_min,
        first_at: r.first_at, last_at: r.last_at, cost: r2(costOf.get(r.chat_key) ?? 0),
      })),
    }
  }

  // ---- messages (not chats): these follow the date of the message itself, and ignore the team member filter
  const MSGS = `(select *, at_ist::date as d from reporting.v_chat_messages) x`
  const msgWhere = (q, extra) => where(q, { date: 'x.d', extra })
  // The same, plus the Agent filter: only messages in chats owned by the chosen agents (owner as in the chat list). pre goes in front of the select.
  async function ownedMsgs(q, extra) {
    const w = msgWhere(q, extra)
    const owners = String(q.owners ?? '').split('|').map((s) => s.trim()).filter(Boolean)
    if (!owners.length) return { sql: w.sql, args: w.args, pre: '' }
    const clause = `x.chat_key in (select ch.chat_key from ch where ch.owner = any(${w.ph(owners)}::text[]))`
    return { sql: w.sql ? `${w.sql} and ${clause}` : `where ${clause}`, args: w.args, pre: await base() }
  }
  const needsViewUpdate = (e) => /column .* does not exist/i.test(e.message)   // the view is older than this page: run chats.sql again

  // WATI's "Sent vs received messages": what we sent (templates that did not fail, plus team replies) against what customers sent
  async function flow(q) {
    const g = grain(q); const w = await ownedMsgs(q)
    const rows = await Q(`${w.pre} select to_char(date_trunc('${g}', x.d), 'YYYY-MM-DD') as period,
        count(*) filter (where x.direction in ('template', 'session') and x.failed_at is null)::int as sent,
        count(*) filter (where x.direction = 'inbound')::int as received,
        count(*) filter (where x.direction = 'template' and x.failed_at is not null)::int as failed
      from ${MSGS} ${w.sql} group by 1 order by 1`, w.args)
    return { grain: g, rows }
  }

  // WATI's "Sent messages by type" and "Total messages by type": text, image, template, ...
  async function messageTypes(q) {
    const w = await ownedMsgs(q)
    try {
      const rows = await Q(`${w.pre} select coalesce(x.message_type, 'unknown') as type,
          count(*) filter (where x.direction in ('template', 'session') and x.failed_at is null)::int as sent,
          count(*) filter (where x.direction = 'inbound')::int as received
        from ${MSGS} ${w.sql} group by 1 order by 2 desc, 3 desc, 1`, w.args)
      return { rows: rows.filter((r) => r.sent + r.received > 0) }
    } catch (e) { if (needsViewUpdate(e)) return { needsViewUpdate: true }; throw e }
  }

  // WATI's "Message delivery status": each template message counted once, at the furthest step it reached
  async function delivery(q) {
    const w = await ownedMsgs(q, ["x.direction = 'template'"])
    try {
      const [r] = await Q(`${w.pre} select count(*)::int as total,
          count(*) filter (where x.failed_at is not null)::int as failed,
          count(*) filter (where x.failed_at is null and x.replied_at is not null)::int as replied,
          count(*) filter (where x.failed_at is null and x.replied_at is null and x.read_at is not null)::int as read_,
          count(*) filter (where x.failed_at is null and x.replied_at is null and x.read_at is null and x.delivered_at is not null)::int as delivered,
          count(*) filter (where x.failed_at is null and x.replied_at is null and x.read_at is null and x.delivered_at is null)::int as sent_only
        from ${MSGS} ${w.sql}`, w.args)
      return { total: r.total, steps: { failed: r.failed, replied: r.replied, read: r.read_, delivered: r.delivered, sent_only: r.sent_only } }
    } catch (e) { if (needsViewUpdate(e)) return { needsViewUpdate: true }; throw e }
  }

  // ---- WATI's own ticket status, owners and tags, as saved by the n8n workflow "WATI Status Sync" (sql/wati_status.sql).
  // These cards read only reporting.v_wati_conversations. Until the sync has run they answer { available: false } and the page says so. They follow the date the
  // customer last wrote (India time). Open and Pending are WATI's live counts, so they ignore the dates; Expired and Missed follow the day the chat expired (customer's last message + 24 h).
  // Rows with WATI's status "broadcast" (we messaged, the customer never wrote) are left out of every number here: they are not conversations, and our own "Awaiting customer" count covers them.
  // d = the day the customer last wrote; xd = the day the chat expired (24 hours later). Expired and Missed follow xd, because that is how WATI dates them.
  // st = the status as it really is NOW. WATI flips a chat to Expired exactly 24 hours after the customer's last message, but our copy is only as fresh as the last sync (and a chat can sit
  // as Open for a few minutes after its 24 hours). So an Open, Pending or New chat whose 24 hours are up counts as Expired here, without waiting for the next sync.
  const ST = `case when status in ('open', 'pending', 'new') and last_customer_message_at + interval '24 hours' <= now() then 'expired' else status end`
  const WATI = `(select *, ${ST} as st, (last_customer_message_at at time zone 'Asia/Kolkata')::date as d, ((last_customer_message_at + interval '24 hours') at time zone 'Asia/Kolkata')::date as xd from reporting.v_wati_conversations where status is distinct from 'broadcast') c`
  const watiMissing = (e) => /v_wati_conversations/.test(e.message) && /(does not exist|permission denied)/.test(e.message)

  const WOWN = { 'coalesce(c.assignee_name, c.assignee_id)': 'owners' }   // the Agent filter on WATI's own rows

  // The "Right now" tiles and lists follow the page's filters: the date range, the Agent filter (owners) and the Lead source filter (sources). The Template and Status filters do
  // not apply to chats. Lead source: the customer behind a conversation is found by phone number (from the messages we saved for it) and gets the source of the newest lead with
  // that number, or "(no matching lead)". That lookup is only built when the Lead source filter is used. The date is d (the day the customer last wrote) or xd (the day it expired).
  const WATI_ALL = `(select *, ${ST} as st, (last_customer_message_at at time zone 'Asia/Kolkata')::date as d, ((last_customer_message_at + interval '24 hours') at time zone 'Asia/Kolkata')::date as xd from reporting.v_wati_conversations) c`
  const SRC_JOIN = `left join (select m.conversation_id, (array_agg(l.lead_source order by l.created_at desc nulls last))[1] as lead_source
      from (select conversation_id, (array_agg(phone10 order by at_utc desc) filter (where coalesce(phone10, '') <> ''))[1] as phone10 from reporting.v_chat_messages where conversation_id is not null group by 1) m
      join reporting.v_leads l on l.phone10 = m.phone10 group by 1) ls on ls.conversation_id = c.conversation_id`
  // Did a PERSON answer the customer's latest message? WATI's reply_state counts a bot's answer as a reply too, so a chat the bot owns is never "answered by a person".
  const REPLIED = `coalesce(c.reply_state = 'replied' and not coalesce(c.assignee_is_bot, false), false)`
  // Follow-up outside WhatsApp: the team also works leads by phone and writes it up in Salesforce, which WATI cannot see. The customer behind a conversation is found by phone number (from
  // the messages we saved for it); sf_signal = a lead with that number has moved on from "New", has a follow-up task or a status-change event, or an opportunity exists. A conversation whose
  // phone number we do not have gets no row here (shown as "can't tell", never as "untouched"). It is the lead's CURRENT state, so it shows that someone worked the lead, not when.
  const FLAG = (x) => `coalesce(${x}::text, '0') not in ('0', 'false', 'f', '')`
  const FU_JOIN = `left join (select m.conversation_id,
      (exists (select 1 from reporting.v_leads l where l.phone10 = m.phone10 and (coalesce(l.lead_status, '') not in ('', 'New', 'NA') or ${FLAG('l.task1')} or ${FLAG('l.task2')} or ${FLAG('l.task3')}
          or ${FLAG('l.to_nurturing')} or ${FLAG('l.to_not_connected')} or ${FLAG('l.to_unqualified')}))
       or exists (select 1 from reporting.v_opps o where o.phone10 = m.phone10)) as sf_signal
      from (select conversation_id, (array_agg(phone10 order by at_utc desc) filter (where coalesce(phone10, '') <> ''))[1] as phone10 from reporting.v_chat_messages where conversation_id is not null group by 1) m
      where m.phone10 is not null) fu on fu.conversation_id = c.conversation_id`
  const rnWhere = (q, dateCol, extra = [], withFollowUp = false) => {
    const bySource = String(q.sources ?? '').trim() !== ''
    const w = where(q, { date: dateCol, extra, lists: { ...WOWN, ...(bySource ? { "coalesce(ls.lead_source, '(no matching lead)')": 'sources' } : {}) } })
    return { ...w, from: `${WATI_ALL}${bySource ? ' ' + SRC_JOIN : ''}${withFollowUp ? ' ' + FU_JOIN : ''}` }
  }

  async function watiStatus(q) {
    try {
      const w = where(q, { date: 'c.d', lists: WOWN })
      const [live] = await Q(`select count(*)::int as known, count(*) filter (where c.st = 'open')::int as open, count(*) filter (where c.st = 'pending')::int as pending,
          to_char(max(c.evaluated_at) at time zone 'Asia/Kolkata', 'YYYY-MM-DD"T"HH24:MI:SS') as evaluated_at from ${WATI}`)
      if (!live.known) return { available: false }
      const wl = where(q, { date: null, lists: WOWN, extra: ["c.st in ('open', 'pending')"] })
      const [lv] = await Q(`select count(*) filter (where c.st = 'open')::int as open, count(*) filter (where c.st = 'pending')::int as pending from ${WATI} ${wl.sql}`, wl.args)
      const [p] = await Q(`select count(*)::int as total,
          count(*) filter (where c.st = 'solved')::int as solved,
          count(*) filter (where c.st = 'solved' and c.assignee_is_bot)::int as solved_by_bot,
          count(*) filter (where c.st = 'solved' and not c.assignee_is_bot)::int as solved_by_operator,
          count(*) filter (where c.assignment = 'unassigned')::int as unassigned
        from ${WATI} ${w.sql}`, w.args)
      const wx = where(q, { date: 'c.xd', lists: WOWN, extra: ["c.st = 'expired'"] })
      const [x] = await Q(`select count(*)::int as expired, count(*) filter (where c.assignment = 'assigned' and c.last_effective_reply_at is null)::int as missed from ${WATI} ${wx.sql}`, wx.args)
      // "Right now": WATI's own status as last saved, for the page's filters (see rnWhere). With nothing picked (All time, no agent, no source) these are the whole Team Inbox, so Open,
      // Pending and Expired can be compared with the Team Inbox filters of the same name. Open, Pending and Unassigned follow the day the customer last wrote; Expired follows the day the
      // chat expired (like the Expired tile above). Unassigned counts every conversation with no owner, including the ones we only sent a template to (WATI status "broadcast");
      // unassigned_customer leaves those out. Both are returned so either can be compared with the Team Inbox.
      const wr = rnWhere(q, 'c.d')
      const [rn] = await Q(`select count(*) filter (where c.st = 'open')::int as open, count(*) filter (where c.st = 'pending')::int as pending,
          count(*) filter (where c.assignment = 'unassigned')::int as unassigned,
          count(*) filter (where c.assignment = 'unassigned' and c.status is distinct from 'broadcast')::int as unassigned_customer,
          count(*) filter (where c.assignment = 'unassigned' and c.status is distinct from 'broadcast' and coalesce(c.assignee_is_bot, false))::int as unassigned_bot,
          count(*) filter (where c.assignment = 'unassigned' and c.status is distinct from 'broadcast' and c.assignee_id is null)::int as unassigned_nobody,
          count(*) filter (where c.st in ('open', 'pending') and not ${REPLIED})::int as needs_reply
        from ${wr.from} ${wr.sql}`, wr.args)
      const wrx = rnWhere(q, 'c.xd', ["c.st = 'expired'"])
      const [rx] = await Q(`select count(*)::int as expired from ${wrx.from} ${wrx.sql}`, wrx.args)
      return { available: true, evaluated_at: live.evaluated_at, live: { open: lv.open, pending: lv.pending },
        right_now: { open: rn.open, pending: rn.pending, expired: rx.expired, unassigned: rn.unassigned, unassigned_customer: rn.unassigned_customer,
          unassigned_bot: rn.unassigned_bot, unassigned_nobody: rn.unassigned_nobody, needs_reply: rn.needs_reply, as_of: live.evaluated_at },
        period: { ...p, expired: x.expired, missed: x.missed } }
    } catch (e) { if (watiMissing(e)) return { available: false }; throw e }
  }

  // The chats behind a "Right now" number, newest customer message first. state = open | pending | expired | unassigned (anything else is refused).
  // The phone number and the customer's WhatsApp name come from the messages we saved for that conversation; both stay masked unless reveal=1 (and ALLOW_REVEAL is not false).
  // needs_reply = open or pending and no person has answered the latest message; bot_held = no owner in WATI because the chatbot holds the chat (customers only, not template-only chats);
  // fu_* = the "who followed up" groups (see followUp below).
  const NOT_BC = `c.status is distinct from 'broadcast'`
  const WSTATES = { open: "c.st = 'open'", pending: "c.st = 'pending'", expired: "c.st = 'expired'", unassigned: "c.assignment = 'unassigned'",
    needs_reply: `c.st in ('open', 'pending') and not ${REPLIED}`, bot_held: `c.assignment = 'unassigned' and ${NOT_BC} and coalesce(c.assignee_is_bot, false)`,
    fu_replied: `${NOT_BC} and ${REPLIED}`, fu_elsewhere: `${NOT_BC} and not ${REPLIED} and fu.sf_signal`, fu_untouched: `${NOT_BC} and not ${REPLIED} and fu.sf_signal is false`,
    fu_unknown: `${NOT_BC} and not ${REPLIED} and fu.conversation_id is null` }
  async function watiList(q) {
    const state = String(q.state ?? '').trim()
    if (!Object.hasOwn(WSTATES, state)) return { rows: [], state: null, total: 0, limit: 0, error: 'state must be open, pending, expired, unassigned, needs_reply, bot_held or a fu_ group' }
    try {
      const show = reveal(q)
      const limit = Math.min(1000, Math.max(1, parseInt(q.limit, 10) || 200))
      const w = rnWhere(q, state === 'expired' ? 'c.xd' : 'c.d', [WSTATES[state]], state.startsWith('fu_'))   // the same filters as the tile it belongs to
      const [{ n: total }] = await Q(`select count(*)::int as n from ${w.from} ${w.sql}`, w.args)
      const rows = await Q(`select c.conversation_id, c.st as status, c.assignment, coalesce(c.assignee_name, c.assignee_id) as owner, coalesce(c.assignee_is_bot, false) as owner_is_bot,
          c.reply_state, ${TS("(c.last_customer_message_at at time zone 'Asia/Kolkata')")} as last_wrote,
          round(extract(epoch from (now() - c.last_customer_message_at)) / 60)::int as waiting_min
        from ${w.from} ${w.sql} order by c.last_customer_message_at desc nulls last, c.conversation_id limit ${limit}`, w.args)
      const who = new Map()
      if (rows.length) {
        try {
          const f = await Q(`select conversation_id,
              (array_agg(phone10 order by at_utc desc) filter (where coalesce(phone10, '') <> ''))[1] as phone10,
              (array_agg(sender_name order by at_utc desc) filter (where direction = 'inbound' and coalesce(btrim(sender_name), '') <> ''))[1] as name
            from reporting.v_chat_messages where conversation_id = any($1::text[]) group by 1`, [rows.map((r) => r.conversation_id)])
          for (const x of f) who.set(x.conversation_id, x)
        } catch { /* the chat messages view is not there: phone and name stay unknown */ }
      }
      return {
        revealed: show, canReveal: process.env.ALLOW_REVEAL !== 'false', state, total, limit,
        rows: rows.map((r) => {
          const x = who.get(r.conversation_id) ?? {}, nm = String(x.name ?? '').trim()
          return {
            key: r.conversation_id, status: r.status, assignment: r.assignment, owner: r.owner ?? null, owner_is_bot: r.owner_is_bot, reply_state: r.reply_state,
            customer: (show ? nm : NAME(nm)) || 'Name unknown', phone: x.phone10 ? (show ? String(x.phone10) : MASK(x.phone10)) : '', last_wrote: r.last_wrote, waiting_min: r.waiting_min,
          }
        }),
      }
    } catch (e) { if (watiMissing(e)) return { available: false, rows: [], state, total: 0, limit: 0 }; throw e }
  }

  async function watiOperators(q) {
    try {
      const w = where(q, { date: 'c.d', lists: WOWN, extra: ["c.assignment = 'assigned'", 'c.assignee_id is not null'] })
      // Assigned and Solved follow the day the customer last wrote. Expired and Missed follow the day the chat expired (like WATI's Operator Performance). Open and Pending are right now.
      const per = await Q(`select coalesce(c.assignee_name, c.assignee_id) as operator, bool_or(c.assignee_is_bot) as is_bot,
          count(*)::int as assigned, count(*) filter (where c.st = 'solved')::int as solved
        from ${WATI} ${w.sql} group by 1`, w.args)
      const wx = where(q, { date: 'c.xd', lists: WOWN, extra: ["c.st = 'expired'", "c.assignment = 'assigned'", 'c.assignee_id is not null'] })
      const exp = await Q(`select coalesce(c.assignee_name, c.assignee_id) as operator, bool_or(c.assignee_is_bot) as is_bot, count(*)::int as expired,
          count(*) filter (where c.last_effective_reply_at is null)::int as missed from ${WATI} ${wx.sql} group by 1`, wx.args)
      const wn = where(q, { date: null, lists: WOWN, extra: ["c.assignment = 'assigned'", 'c.assignee_id is not null', "c.st in ('open', 'pending')"] })
      const now = await Q(`select coalesce(c.assignee_name, c.assignee_id) as operator, bool_or(c.assignee_is_bot) as is_bot,
          count(*) filter (where c.st = 'open')::int as open, count(*) filter (where c.st = 'pending')::int as pending
        from ${WATI} ${wn.sql} group by 1`, wn.args)
      const by = new Map(per.map((r) => [r.operator, { ...r, open: 0, pending: 0, expired: 0, missed: 0 }]))
      const blank = (o) => ({ operator: o.operator, is_bot: o.is_bot, assigned: 0, solved: 0, expired: 0, missed: 0, open: 0, pending: 0 })
      for (const n of now) by.set(n.operator, { ...(by.get(n.operator) ?? blank(n)), open: n.open, pending: n.pending })
      for (const n of exp) by.set(n.operator, { ...(by.get(n.operator) ?? blank(n)), expired: n.expired, missed: n.missed })
      const rows = [...by.values()].sort((a, b) => b.assigned - a.assigned || b.open - a.open || String(a.operator).localeCompare(String(b.operator)))
      return { available: rows.length > 0, rows }
    } catch (e) { if (watiMissing(e)) return { available: false, rows: [] }; throw e }
  }

  async function watiTags(q) {
    try {
      const w = where(q, { date: 'c.d', lists: WOWN })
      const rows = await Q(`select coalesce(t ->> 'name', t ->> 'id') as tag, count(*)::int as chats from ${WATI}, jsonb_array_elements(c.tags) t ${w.sql} group by 1 order by 2 desc, 1 limit 20`, w.args)
      return { rows }
    } catch (e) { if (watiMissing(e)) return { rows: [] }; throw e }
  }

  // "Who followed up": every customer chat (template-only chats left out) whose customer last wrote in the dates, in exactly one of four groups, so the groups add up to the total:
  //   replied   = a person answered the latest message in WATI;
  //   elsewhere = nobody answered in WATI, but Salesforce shows the lead was worked (status moved on, task, or opportunity): the team called or followed up there;
  //   untouched = no answer in WATI and nothing in Salesforce: the ones to chase;
  //   unknown   = no answer in WATI and we have no phone number for the chat, so Salesforce cannot be checked.
  // Needs the Salesforce views and the chat messages view; without them it says so instead of failing.
  async function followUp(q) {
    try {
      const w = rnWhere(q, 'c.d', [NOT_BC], true)
      const [r] = await Q(`select count(*)::int as total,
          count(*) filter (where ${REPLIED})::int as replied,
          count(*) filter (where not ${REPLIED} and fu.sf_signal)::int as elsewhere,
          count(*) filter (where not ${REPLIED} and fu.sf_signal is false)::int as untouched,
          count(*) filter (where not ${REPLIED} and fu.conversation_id is null)::int as unknown
        from ${w.from} ${w.sql}`, w.args)
      return { available: true, ...r }
    } catch (e) {
      if (watiMissing(e)) return { available: false }
      if (/(column|relation) .* does not exist|permission denied/i.test(e.message)) return { available: false, needsSalesforceView: true }
      throw e
    }
  }

  return { 'chats/wati-status': watiStatus, 'chats/wati-list': watiList, 'chats/follow-up': followUp, 'chats/wati-operators': watiOperators, 'chats/wati-tags': watiTags, 'chats/flow': guard(flow), 'chats/message-types': guard(messageTypes), 'chats/delivery': guard(delivery), 'chats/kpis': guard(kpis), 'chats/trend': guard(trend), 'chats/duration': guard(duration), 'chats/heatmap': guard(heatmap), 'chats/operators': guard(operators), 'chats/cost': guard(cost), 'chats/list': guard(list) }
}
