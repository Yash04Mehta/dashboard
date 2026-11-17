// Checks on the phone number a message was sent to and on the customer's name, written as database regular expressions so they run over the whole message log at once.
// They return a short code (the page turns it into plain words, see src/lib/validate.ts) or null when the value looks fine. Nothing is changed and no value leaves the database:
// only the code does, so the checks work with the "show phone numbers" switch off.
//
// WHAT A GOOD NUMBER LOOKS LIKE: an Indian mobile, 10 digits starting with 6, 7, 8 or 9, with or without the country code 91 in front (so 10 or 12 digits).
// Real examples seen in the live log: 11 digits ("one digit too many"), 12 digits that do not start with 91, 13 or more digits, 91 typed twice, an extra 0 in front.
// Of the messages sent to numbers that fail these checks, about 19 in 20 failed; of the others, about 1 in 6 (mostly WhatsApp holding back marketing messages).
//
// Order matters: the first rule that matches wins.
export const PHONE_SQL = (c) => {
  const d = `regexp_replace(${c}, '\\D', '', 'g')`   // digits only
  return `(case
    when ${c} is null or btrim(${c}) = '' then null
    when ${c} ~ '[A-Za-z@]' then 'text'                                        -- an email or words where the number should be
    when ${d} ~ '(.)\\1{7,}' then 'repeated'                                    -- 9999999999, 0000000000: a placeholder
    when ${d} ~ '^(91){2}[0-9]{10}$' then 'double91'                           -- 91 typed twice (+91+91...)
    when ${d} ~ '^(0[0-9]{10}|910[0-9]{10}|0091[0-9]{10})$' then 'extra0'     -- a 0 (or 00) in front of the number
    when ${d} ~ '^[0-9]{11}$' then 'eleven'                                    -- one digit too many
    when ${d} ~ '^[0-9]{13,}$' then 'long'                                     -- far too many digits
    when ${d} ~ '^(?!91)[0-9]{12}$' then 'twelve'                              -- 12 digits, but not 91 + a 10-digit number
    when ${d} ~ '^[0-9]{0,9}$' then 'short'                                    -- incomplete
    when ${d} ~ '^[0-5][0-9]{9}$' or ${d} ~ '^91[0-5][0-9]{9}$' then 'bad_start'   -- Indian mobile numbers start with 6, 7, 8 or 9
    else null end)`
}

// The customer's name as saved on the Salesforce lead (or opportunity) with the same number: 'ok' when it looks like a name, null when there is no matching lead.
export const NAME_SQL = (c) => `(case
    when ${c} is null then null
    when btrim(${c}) = '' then 'empty'
    when ${c} ~ '@' then 'email'                                                -- an email address in the name field
    when ${c} ~ '^[+()\\s._/-]*[0-9][0-9+()\\s._/-]*$' then 'number'            -- only digits and symbols: a phone number in the name field
    when ${c} ~* '^(na|n/?a|none|null|nil|unknown|test|dummy|customer|sir|madam|[.?-]+)$' then 'placeholder'
    else 'ok' end)`

// the newest Salesforce lead or opportunity name for each 10-digit number (used by the checks above and by nothing else)
export const NAMES_CTE = (log) => `nm as materialized (select distinct on (phone10) phone10, name from (
    select phone10, customer_name as name, created_at as at from reporting.v_leads
    union all select phone10, customer_name, created_at from reporting.v_opps) x
  where phone10 in (select right(regexp_replace(wa_id, '\\D', '', 'g'), 10) from ${log} where wa_id is not null)   -- only the numbers in the log: keeps this small, so the join below stays fast
  order by phone10, at desc nulls last)`
