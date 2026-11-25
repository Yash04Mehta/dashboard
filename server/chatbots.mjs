// Chatbots page: which chatbot is used, how many customers it talks to each day, what they answered, and the past conversations behind the numbers. Read-only.
// No message text is ever read. Phone numbers are masked unless reveal=1 (and ALLOW_REVEAL is not false), like the Chats and Agents pages.
//
// THE WORDS (the page uses only these three):
//   customer   one person (one phone number). Counted ONCE per chatbot per day, so "customers per day" never counts the same person twice for the same chatbot.
//   message    one message a bot sent.
//   chatbot    which bot flow it was: Delhi chatbot, Welcome bot, KnowBot (AI assistant), or other.
//
// THREE SOURCES (each answers on its own, so the page still works when one is missing):
//   wati      reporting.v_chatbot_messages  every message a WATI bot ("Bot" = the flow chatbots, "KnowBot" = the AI assistant) sent, grouped into a chatbot ("flow")
//             by the bot's own wording. Saved since 3 Nov 2026 (when the chat messages started being saved).
//   delhi     reporting.v_delhi_bot_journeys  one row per customer of the Delhi chatbot (n8n log, since 17 Nov 2026): how far they got and what they answered
//             (solution, products, timeline, whether they asked a question) and the lead tier it led to. Dated by the day the customer FIRST appears in the log.
//   triggers  reporting.v_chatbot_triggers  WATI's own "chatbot started" event, which names a flow only by an id (saved since 25 Nov 2026).
//             config/chatbots.csv (chatbot_id,name) puts a name on an id.
// Older conversations exist in WATI itself (its history starts 6 Oct 2026) but were never saved here: that needs a separate import.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_DIR = process.env.AQ_CONFIG_DIR || path.resolve(here, '..', 'config')

/** config/chatbots.csv: "chatbot_id,name" per line; blank lines and lines starting with # are ignored */
export function chatbotNames() {
  const out = new Map()
  try {
    for (const line of fs.readFileSync(path.join(CONFIG_DIR, 'chatbots.csv'), 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
      const t = line.trim(); if (!t || t.startsWith('#')) continue
      const i = t.indexOf(','); if (i < 0) continue
      const id = t.slice(0, i).trim(), name = t.slice(i + 1).trim()
      if (id && name && id.toLowerCase() !== 'chatbot_id') out.set(id, name)
    }
  } catch { /* no file: ids are shown as they are */ }
  return out
}

// a customer = the 10-digit number; a chat that has none (rare) stands for itself
const PERSON = `coalesce(nullif(m.phone10, ''), m.chat_key)`

export function makeChatbots({ Q, where, pct, grain, MASK, NAME, reveal }) {
  // Does the installed copy of reporting.v_chatbot_messages already have phone10 (added 25 Nov evening)? If not (chatbots.sql not re-run yet), customers are counted by chat and the
  // conversation list says what to run. Checked at most once a minute.
  let probe = { at: 0, ok: false }
  const hasPhone = async () => {
    if (Date.now() - probe.at < 60000) return probe.ok
    let ok = false
    try { await Q('select phone10 from reporting.v_chatbot_messages limit 0'); ok = true } catch { ok = false }
    probe = { at: Date.now(), ok }
    return ok
  }
  // a view that is not installed, or an installed copy from before phone10 was added: say what to run instead of failing
  const missing = (e) => /(v_delhi_bot|v_chatbot_|phone10)/.test(e.message) && /(does not exist|permission denied)/.test(e.message)
  const part = async (fn) => { try { return await fn() } catch (e) { if (missing(e)) return { setup: true }; throw e } }
  const TS = (c) => `to_char(${c}, 'YYYY-MM-DD"T"HH24:MI:SS')`
  const D = (c) => `to_char(${c}, 'YYYY-MM-DD')`

  async function overview(q) {
    const g = grain(q)
    const xm = where(q, { date: 'm.day' }), xj = where(q, { date: 'j.first_day' }), xja = where(q, { date: 'j.first_day', extra: ['j.answered'] })
    const xe = where(q, { date: 'e.day' }), xt = where(q, { date: 't.day' })
    // the three sources run at the same time; a missing view only blanks its own part
    const [wati, delhi, triggers] = await Promise.all([
      part(async () => {
        const CK = (await hasPhone()) ? PERSON : 'm.chat_key'
        const [flows, all, trend, steps, hours, span] = await Promise.all([
          Q(`select m.flow, count(*)::int as msgs, count(distinct ${CK})::int as customers, count(distinct m.day)::int as days, ${TS('max(m.at_ist)')} as last_at
             from reporting.v_chatbot_messages m ${xm.sql} group by 1 order by 3 desc, 2 desc`, xm.args),
          Q(`select count(*)::int as msgs, count(distinct ${CK})::int as customers, count(distinct m.day)::int as days from reporting.v_chatbot_messages m ${xm.sql}`, xm.args),
          // one customer per chatbot per day, then added up per period (a customer who comes back on another day counts again)
          Q(`select period, flow, count(*)::int as customers, sum(msgs)::int as msgs from (
               select ${D(`date_trunc('${g}', m.day)`)} as period, m.flow, m.day, ${CK} as ck, count(*) as msgs from reporting.v_chatbot_messages m ${xm.sql} group by 1, 2, 3, 4) t
             group by 1, 2 order by 1`, xm.args),
          Q(`select m.flow, m.step, count(*)::int as msgs, count(distinct ${CK})::int as customers from reporting.v_chatbot_messages m ${xm.sql} group by 1, 2 order by 1, 4 desc`, xm.args),
          Q(`select extract(hour from m.at_ist)::int as hour, count(distinct ${CK})::int as customers from reporting.v_chatbot_messages m ${xm.sql} group by 1 order by 1`, xm.args),
          Q(`select ${D('min(m.day)')} as first_day, ${D('max(m.day)')} as last_day from reporting.v_chatbot_messages m`),
        ])
        return { flows, total: all[0], trend, steps, hours: Array.from({ length: 24 }, (_, h) => hours.find((x) => x.hour === h) ?? { hour: h, customers: 0 }), data_from: span[0]?.first_day ?? null, data_to: span[0]?.last_day ?? null }
      }),
      part(async () => {
        const answersEtc = `select t.k, t.v, count(*)::int as n from reporting.v_delhi_bot_journeys j cross join lateral (values ('solution', j.solution), ('products', j.products), ('timeline', j.timeline)) t(k, v)
          ${xj.sql ? xj.sql + ' and' : 'where'} t.v is not null group by 1, 2 order by 1, 3 desc`
        const [tot, tiers, dist, combos, trend, fresh] = await Promise.all([
          Q(`select count(*)::int as customers, count(*) filter (where j.opening_sent)::int as opening_sent, count(*) filter (where j.answered)::int as answered,
               count(*) filter (where j.solution is not null)::int as solution, count(*) filter (where j.products is not null)::int as products, count(*) filter (where j.timeline is not null)::int as timeline,
               count(*) filter (where j.asked_question)::int as asked_question, count(*) filter (where j.final_stage = 'no_reply')::int as no_reply
             from reporting.v_delhi_bot_journeys j ${xj.sql}`, xj.args),
          Q(`select coalesce(j.final_tier, 'No tier yet') as tier, count(*)::int as n from reporting.v_delhi_bot_journeys j ${xj.sql} group by 1 order by 2 desc`, xj.args),
          Q(answersEtc, xj.args),
          Q(`select j.solution, j.products, j.timeline, j.final_tier as tier, count(*)::int as customers, count(*) filter (where j.asked_question)::int as asked_question
             from reporting.v_delhi_bot_journeys j ${xja.sql} group by 1, 2, 3, 4 order by 5 desc, 1, 2, 3 limit 60`, xja.args),
          Q(`select ${D(`date_trunc('${g}', j.first_day)`)} as period, count(*)::int as customers, count(*) filter (where j.answered)::int as answered
             from reporting.v_delhi_bot_journeys j ${xj.sql} group by 1 order by 1`, xj.args),
          Q(`select count(*)::int as events, ${TS('max(e.at_ist)')} as last_event, ${D('min(e.day)')} as first_day from reporting.v_delhi_bot_events e ${xe.sql}`, xe.args),
        ])
        const t = tot[0]
        return {
          total: { ...t, answered_pct: pct(t.answered, t.customers), solution_pct: pct(t.solution, t.customers), timeline_pct: pct(t.timeline, t.customers), question_pct: pct(t.asked_question, t.customers) },
          tiers, trend,
          answers: { solution: dist.filter((x) => x.k === 'solution'), products: dist.filter((x) => x.k === 'products'), timeline: dist.filter((x) => x.k === 'timeline') },
          combos: combos.map((r) => ({ ...r, share: pct(r.customers, t.answered) })),
          events: fresh[0]?.events ?? 0, last_event: fresh[0]?.last_event ?? null, data_from: fresh[0]?.first_day ?? null,
        }
      }),
      part(async () => {
        const names = chatbotNames()
        const [by, since] = await Promise.all([
          Q(`select t.chatbot_id, count(*)::int as triggers, count(*) filter (where t.first_for_customer_today)::int as customers, ${D('min(t.day)')} as first_day, ${D('max(t.day)')} as last_day
             from reporting.v_chatbot_triggers t ${xt.sql} group by 1 order by 2 desc`, xt.args),
          Q(`select ${D('min(t.day)')} as first_day from reporting.v_chatbot_triggers t`),
        ])
        return { rows: by.map((r) => ({ ...r, name: names.get(r.chatbot_id) ?? null })), since: since[0]?.first_day ?? null, named: names.size }
      }),
    ])
    return { grain: g, wati, delhi, triggers }
  }

  // The past conversations behind the numbers: one row per customer per chatbot, newest first, with the steps the bot went through and, for the Delhi chatbot, what the customer
  // answered and the lead tier it led to. No message text. Numbers and names appear only with reveal=1.
  async function chats(q) {
    const show = reveal(q)
    const limit = Math.min(1000, Math.max(1, parseInt(q.limit, 10) || 100))
    const x = where(q, { date: 'm.day', lists: { 'm.flow': 'flow' } })
    const res = !(await hasPhone()) ? { setup: true } : await part(async () => {
      const rows = await Q(`with m as (select m.flow, m.step, m.at_ist, m.phone10, ${PERSON} as ck from reporting.v_chatbot_messages m ${x.sql}),
          conv as (select ck, flow, max(phone10) as phone10, min(at_ist) as first_at, max(at_ist) as last_at, count(*)::int as msgs, array_agg(step order by at_ist) as steps from m group by ck, flow)
        select c.flow, c.phone10, c.msgs, c.steps, ${TS('c.first_at')} as first_at, ${TS('c.last_at')} as last_at, count(*) over ()::int as total,
               j.final_tier as tier, j.solution, j.products, j.timeline, j.asked_question, j.answered
        from conv c left join reporting.v_delhi_bot_journeys j on c.flow = 'Delhi chatbot' and coalesce(c.phone10, '') <> '' and j.phone10 = c.phone10
        order by c.last_at desc, c.flow limit ${limit}`, x.args)
      const nameOf = new Map()
      if (show) {
        const need = [...new Set(rows.map((r) => r.phone10).filter(Boolean))]
        if (need.length) {
          try {
            const found = await Q(`select phone10, name from (
                select phone10, customer_name as name, created_at as at from reporting.v_leads where phone10 = any($1::text[])
                union all select phone10, customer_name, created_at from reporting.v_opps where phone10 = any($1::text[])) x
              where coalesce(trim(name), '') <> '' and name !~ '^[0-9+ ()-]{7,}$' order by at desc nulls last`, [need])
            for (const f of found) if (!nameOf.has(f.phone10)) nameOf.set(f.phone10, String(f.name).trim())
          } catch { /* the lead views are not there: names stay unknown */ }
        }
      }
      return {
        total: rows[0]?.total ?? 0,
        rows: rows.map((r) => ({
          flow: r.flow, msgs: r.msgs, first_at: r.first_at, last_at: r.last_at,
          steps: [...new Set(r.steps ?? [])],                                   // in the order the bot sent them, each once
          phone: r.phone10 ? (show ? String(r.phone10) : MASK(r.phone10)) : null,
          name: show ? nameOf.get(r.phone10) ?? null : null,
          tier: r.tier ?? null, solution: r.solution ?? null, products: r.products ?? null, timeline: r.timeline ?? null, asked_question: !!r.asked_question, delhi: r.answered != null,
        })),
      }
    })
    return { revealed: show, canReveal: process.env.ALLOW_REVEAL !== 'false', limit, ...res }
  }

  return { 'chatbots/overview': overview, 'chatbots/chats': chats }
}
