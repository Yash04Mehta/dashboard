// Chatbots page: which chatbot is used, how often per day, and what customers answered. Read-only. No phone numbers and no message text are ever read:
// the four views behind it (server/sql/chatbots.sql) hold only counts, days, the bot's step and the answers the Delhi chatbot recorded.
//
// THREE SOURCES (each answers on its own, so the page still works when one is missing):
//   wati      reporting.v_chatbot_messages  every message a WATI bot sent ("Bot" = the flow chatbots, "KnowBot" = the AI assistant), grouped into a chatbot ("flow")
//             by the bot's own wording: Delhi chatbot / Welcome bot / KnowBot / other. Saved since 4 Nov 2026 (when the chat messages started being saved).
//   delhi     reporting.v_delhi_bot_journeys  one row per customer of the Delhi chatbot (n8n log): how far they got and what they answered
//             (solution, products, timeline, whether they asked a question) and the lead tier it led to. Dated by the day the customer FIRST appears in the log.
//   triggers  reporting.v_chatbot_triggers  WATI's own "chatbot triggered" event, which names a flow only by an id (saved since 25 Nov 2026).
//             config/chatbots.csv (chatbot_id,name) puts a name on an id.
// A customer is counted once per chatbot per day ("customers"); "messages" counts every bot message.
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

export function makeChatbots({ Q, where, pct, grain }) {
  const missing = (e) => /(v_delhi_bot|v_chatbot_)/.test(e.message) && /(does not exist|permission denied)/.test(e.message)
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
        const [flows, all, trend, steps, hours, span] = await Promise.all([
          Q(`select m.flow, count(*)::int as msgs, count(distinct m.chat_key)::int as chats, count(distinct m.day)::int as days, ${TS('max(m.at_ist)')} as last_at
             from reporting.v_chatbot_messages m ${xm.sql} group by 1 order by 3 desc, 2 desc`, xm.args),
          Q(`select count(*)::int as msgs, count(distinct m.chat_key)::int as chats, count(distinct m.day)::int as days from reporting.v_chatbot_messages m ${xm.sql}`, xm.args),
          Q(`select ${D(`date_trunc('${g}', m.day)`)} as period, m.flow, count(distinct m.chat_key)::int as chats, count(*)::int as msgs
             from reporting.v_chatbot_messages m ${xm.sql} group by 1, 2 order by 1`, xm.args),
          Q(`select m.flow, m.step, count(*)::int as msgs, count(distinct m.chat_key)::int as chats from reporting.v_chatbot_messages m ${xm.sql} group by 1, 2 order by 1, 4 desc`, xm.args),
          Q(`select extract(hour from m.at_ist)::int as hour, count(distinct m.chat_key)::int as chats from reporting.v_chatbot_messages m ${xm.sql} group by 1 order by 1`, xm.args),
          Q(`select ${D('min(m.day)')} as first_day, ${D('max(m.day)')} as last_day from reporting.v_chatbot_messages m`),
        ])
        return { flows, total: all[0], trend, steps, hours: Array.from({ length: 24 }, (_, h) => hours.find((x) => x.hour === h) ?? { hour: h, chats: 0 }), data_from: span[0]?.first_day ?? null, data_to: span[0]?.last_day ?? null }
      }),
      part(async () => {
        const solutionsEtc = `select t.k, t.v, count(*)::int as n from reporting.v_delhi_bot_journeys j cross join lateral (values ('solution', j.solution), ('products', j.products), ('timeline', j.timeline)) t(k, v)
          ${xj.sql ? xj.sql + ' and' : 'where'} t.v is not null group by 1, 2 order by 1, 3 desc`
        const [tot, tiers, dist, combos, trend, fresh] = await Promise.all([
          Q(`select count(*)::int as customers, count(*) filter (where j.opening_sent)::int as opening_sent, count(*) filter (where j.answered)::int as answered,
               count(*) filter (where j.solution is not null)::int as solution, count(*) filter (where j.products is not null)::int as products, count(*) filter (where j.timeline is not null)::int as timeline,
               count(*) filter (where j.asked_question)::int as asked_question, count(*) filter (where j.final_stage = 'no_reply')::int as no_reply
             from reporting.v_delhi_bot_journeys j ${xj.sql}`, xj.args),
          Q(`select coalesce(j.final_tier, 'No tier yet') as tier, count(*)::int as n from reporting.v_delhi_bot_journeys j ${xj.sql} group by 1 order by 2 desc`, xj.args),
          Q(solutionsEtc, xj.args),
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

  return { 'chatbots/overview': overview }
}
