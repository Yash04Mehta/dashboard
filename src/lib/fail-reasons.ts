// Turns the raw reason WATI gives for a failed message ("131026 · Message undeliverable") into a plain-English group,
// what it means and what to do about it. The codes are Meta's WhatsApp Cloud API error codes; when there is no code we match on the wording.
// Nothing here changes data: it only changes how the reasons are shown.

import { phoneBecause, phoneIssue } from "./validate"

export type FailGroupId = "number" | "customer" | "window" | "meta" | "template" | "account" | "other"

export type FailGroup = {
  id: FailGroupId
  title: string        // short name shown on the card
  who: string          // whose side the problem is on
  color: string        // css colour
  means: string        // what happened, in plain words
  todo: string         // what to do about it
}

export const GROUPS: Record<FailGroupId, FailGroup> = {
  number: { id: "number", title: "Phone number problem", who: "Our data", color: "var(--warn)",
    means: "The number saved on the lead is not a valid WhatsApp number (wrong number of digits, an extra 0, 91 twice, or text in the field), so WhatsApp could not deliver to it. Found by the dashboard's own check, not reported by WhatsApp.",
    todo: "Correct the number on the lead in Salesforce, then send again." },
  customer: { id: "customer", title: "Customer can't receive it", who: "Customer's side", color: "var(--c4)",
    means: "The number isn't on WhatsApp, the customer has blocked business messages or opted out, or their phone can't show this kind of message.",
    todo: "Nothing to fix in the template. Check the phone number on the lead, and call or text these customers instead." },
  window: { id: "window", title: "Too late for a free reply", who: "Timing", color: "var(--c3)",
    means: "A normal message can only be sent within 24 hours of the customer's last message. After that only an approved template can be sent.",
    todo: "Send an approved template to reopen the chat, or send sooner after the customer writes." },
  meta: { id: "meta", title: "WhatsApp held it back", who: "WhatsApp's decision", color: "var(--c5)",
    means: "WhatsApp chose not to deliver it. Usually the customer has already received many marketing messages, or the number's quality rating dropped.",
    todo: "Send fewer marketing messages to the same people, and keep templates useful. Check the quality rating in WATI." },
  template: { id: "template", title: "Template problem", who: "Our template", color: "var(--c1)",
    means: "The template was paused, disabled or rejected, or the details filled into it (name, date, link) were missing or in the wrong format.",
    todo: "Open the template in WATI. Re-approve it if it is paused, and check that every filled-in detail has a value." },
  account: { id: "account", title: "Account or sending limit", who: "Our account", color: "var(--warn)",
    means: "Too many messages went out at once, the daily limit was reached, the payment method failed, or the WhatsApp account is restricted.",
    todo: "Spread large sends over more time. Ask whoever manages the WATI account to check limits, billing and account status." },
  other: { id: "other", title: "Other reasons", who: "Not classified", color: "var(--c6)",
    means: "WATI gave a reason this dashboard does not recognise yet. The exact wording is shown underneath.",
    todo: "Send the wording to whoever maintains the dashboard so it can be added." },
}

export const ORDER: FailGroupId[] = ["number", "customer", "window", "meta", "template", "account", "other"]

// Meta WhatsApp Cloud API error codes -> group and a short plain label
const CODES: Record<string, [FailGroupId, string]> = {
  "131026": ["customer", "Message undeliverable"],
  "131021": ["customer", "Sent to ourselves"],
  "131030": ["customer", "Number not on the allowed list"],
  "131051": ["customer", "Message type not supported"],
  "131052": ["customer", "Media could not be downloaded"],
  "131053": ["customer", "Media could not be uploaded"],
  "131050": ["customer", "Customer opted out of marketing"],
  "133010": ["customer", "Phone number not registered"],
  "131047": ["window", "More than 24 hours since the customer wrote"],
  "131049": ["meta", "Held back to keep customers engaged"],
  "130472": ["meta", "Number is in a WhatsApp experiment"],
  "131048": ["meta", "Spam rate limit hit"],
  "130429": ["account", "Too many messages at once"],
  "131056": ["account", "Too many messages to the same customer"],
  "131042": ["account", "Payment problem on the business account"],
  "131031": ["account", "Business account locked"],
  "131045": ["account", "Number not registered for sending"],
  "131000": ["other", "Something went wrong at WhatsApp"],
  "131008": ["template", "A required detail is missing"],
  "131009": ["template", "A detail has the wrong format"],
  "132000": ["template", "Number of filled-in details does not match"],
  "132001": ["template", "Template does not exist in this language"],
  "132005": ["template", "Translated text is too long"],
  "132007": ["template", "Text breaks WhatsApp's format rules"],
  "132012": ["template", "A filled-in detail has the wrong format"],
  "132015": ["template", "Template is paused"],
  "132016": ["template", "Template is disabled"],
  "132068": ["template", "Flow is blocked"],
  "135000": ["template", "Invalid message details"],
}

// wording fallbacks, checked in order, when WATI sends text but no code
const WORDS: [RegExp, FailGroupId][] = [
  [/re-?engagement|24.?h(ou)?r|outside.*window|window.*closed/i, "window"],
  [/opt(ed)?.?out|blocked|not (a )?valid whatsapp|not on whatsapp|no whatsapp|invalid (phone|number|recipient)|undeliverable|not registered|unreachable|unsupported/i, "customer"],
  [/ecosystem|engagement|spam|quality|experiment|healthy/i, "meta"],
  [/paused|disabled|rejected|not approved|template|parameter|variable|placeholder|format/i, "template"],
  [/rate.?limit|too many|throttl|limit|payment|billing|locked|restricted|balance|credit/i, "account"],
]

export type Classified = { group: FailGroup; code: string | null; label: string; raw: string; via?: string; fix?: string; because?: string }

/** The server joins code and text as "131026 · Message undeliverable". Split them, then name the group. */
export function classify(reason: string | null | undefined): Classified {
  const raw = (reason ?? "").trim()
  const m = raw.match(/^(\d{3,6})\b\s*[·\-:]?\s*(.*)$/)
  const code = m ? m[1] : null
  const text = (m ? m[2] : raw).trim()
  if (code && CODES[code]) return { group: GROUPS[CODES[code][0]], code, label: CODES[code][1], raw }
  const hit = WORDS.find(([re]) => re.test(text))
  const group = GROUPS[hit ? hit[1] : "other"]
  return { group, code, label: text ? text.charAt(0).toUpperCase() + text.slice(1) : "Reason not recorded", raw }
}

// ---- the three questions a reader actually has: is it ours to fix, WhatsApp's call, or the customer's side? ----
export type BucketId = "ours" | "whatsapp" | "customer" | "unclear"
export type Bucket = { id: BucketId; title: string; tagline: string; color: string; means: string; todo: string; groups: FailGroupId[] }

export const BUCKETS: Record<BucketId, Bucket> = {
  ours: { id: "ours", title: "We can fix these", tagline: "A problem on our side", color: "var(--warn)", groups: ["number", "template", "window", "account"],
    means: "The message was fine to send, but our template, our timing or our account stopped it.", todo: "Start here. These are the failures you can stop." },
  whatsapp: { id: "whatsapp", title: "WhatsApp held it back", tagline: "WhatsApp's decision", color: "var(--c5)", groups: ["meta"],
    means: "WhatsApp chose not to deliver it. Usually this customer already received many marketing messages, or our number's quality rating slipped.",
    todo: "Send fewer marketing messages to the same people and keep templates useful. Check the quality rating in WATI." },
  customer: { id: "customer", title: "Customer's side", tagline: "Not ours to fix", color: "var(--c4)", groups: ["customer"],
    means: "The number is not on WhatsApp, or the customer blocked business messages or opted out.",
    todo: "Nothing to change in the template. Check the number on the lead, or call or text these customers instead." },
  unclear: { id: "unclear", title: "Not clear yet", tagline: "Reason not recognised", color: "var(--c6)", groups: ["other"],
    means: "WATI gave a reason this dashboard does not recognise yet. The exact wording is listed below.", todo: "Send the wording to whoever maintains the dashboard so it can be added." },
}
export const BUCKET_ORDER: BucketId[] = ["ours", "whatsapp", "customer", "unclear"]
export const bucketOf = (g: FailGroupId): BucketId => BUCKET_ORDER.find((b) => BUCKETS[b].groups.includes(g)) ?? "unclear"

/** Like classify, but for one row of the message log: when the dashboard's own check finds the number malformed, that is named as the cause
 *  (WhatsApp's own code is kept in `via`). A bad number is also why WhatsApp reports "Message undeliverable", so the two agree. */
export function classifyMsg(r: { status: string; reason?: string | null; phone_issue?: string | null; phone_digits?: number | null }): Classified | null {
  if (r.status !== "failed") return null
  const meta = classify(r.reason)
  const p = phoneIssue(r.phone_issue)
  if (p) return { group: GROUPS.number, code: meta.code, label: p.label, raw: meta.raw, via: meta.label, fix: p.todo, because: phoneBecause(r.phone_issue, r.phone_digits) }
  return meta
}
