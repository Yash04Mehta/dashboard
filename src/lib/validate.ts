// Plain-English names for the codes the server's regex checks return (server/validate.mjs). The checks run on the number a message was sent to
// and on the customer's name from the Salesforce lead or opportunity with the same number. Only the code reaches the page, never the number or name itself.

export type Issue = { label: string; short: string; means: string; todo: string }

export const PHONE_ISSUES: Record<string, Issue> = {
  eleven: { label: "11 digits: one digit too many", short: "11 digits", means: "The number has 11 digits. An Indian mobile has 10 (or 12 with the country code 91), so there is one digit too many.", todo: "Correct the number on the lead in Salesforce (find the extra digit), then send again." },
  twelve: { label: "12 digits that don't start with 91", short: "12 digits, not 91…", means: "The number has 12 digits but does not start with the country code 91, so there are extra digits in front of a 10-digit number.", todo: "Remove the extra digits in front on the lead in Salesforce, then send again." },
  long: { label: "More than 12 digits", short: "Too many digits", means: "The number has 13 or more digits, for example two numbers pasted together or a code added in front.", todo: "Correct the number on the lead in Salesforce, then send again." },
  double91: { label: "Country code 91 typed twice", short: "91 twice", means: "The country code 91 appears twice at the start (the +91+91 problem).", todo: "Remove one 91 on the lead in Salesforce, then send again." },
  extra0: { label: "Extra 0 at the start", short: "Extra 0", means: "A 0 (or 00) was typed in front of the number, which WhatsApp does not accept.", todo: "Remove the 0 on the lead in Salesforce, then send again." },
  short: { label: "Fewer than 10 digits", short: "Too short", means: "The number is incomplete: an Indian mobile has 10 digits.", todo: "Get the full number from the customer and correct the lead." },
  bad_start: { label: "Not a mobile number (must start 6 to 9)", short: "Not a mobile number", means: "Indian mobile numbers start with 6, 7, 8 or 9. This one starts with another digit, so it is a landline or a typing mistake.", todo: "Check the number with the customer and correct the lead." },
  repeated: { label: "Placeholder number (one digit repeated)", short: "Placeholder number", means: "The number is made of one repeated digit, such as 9999999999 or 0000000000. Someone filled the field to get past the form.", todo: "Ask the customer for a real number." },
  text: { label: "Text or an email where the number should be", short: "Text in phone field", means: "The phone field holds letters or an email address instead of a number.", todo: "Correct the phone field on the lead in Salesforce." },
}

export const NAME_ISSUES: Record<string, Issue> = {
  email: { label: "Email address in the name field", short: "Email as name", means: "The lead's name is an email address, so the message greets the customer with it.", todo: "Put the customer's real name on the lead." },
  number: { label: "Phone number in the name field", short: "Number as name", means: "The lead's name is a phone number, so the message greets the customer with it.", todo: "Put the customer's real name on the lead." },
  empty: { label: "Name is empty", short: "Empty name", means: "The lead has no name. A template that fills in the name then has nothing to put there.", todo: "Add the name on the lead." },
  placeholder: { label: "Placeholder name (like NA, test, unknown)", short: "Placeholder name", means: "The lead's name is a placeholder such as NA, test or unknown.", todo: "Put the customer's real name on the lead." },
}

export const phoneIssue = (code?: string | null) => (code ? PHONE_ISSUES[code] : undefined)
export const nameIssue = (code?: string | null) => (code ? NAME_ISSUES[code] : undefined)

/** The sentence shown in "Why it failed": what is most likely wrong with the number, in plain words. */
export function phoneBecause(code?: string | null, digits?: number | null): string | undefined {
  const d = digits ?? 0
  switch (code) {
    case "eleven": return "the number has 11 digits, one more than a mobile number (10 digits, or 12 with the country code 91)"
    case "twelve": return "the number has 12 digits but does not start with 91, so there are extra digits in front of a 10-digit number"
    case "long": return `the number has ${d || "more than 12"} digits, far more than a mobile number (10 digits, or 12 with the country code 91)`
    case "double91": return "the country code 91 is typed twice at the start of the number"
    case "extra0": return "an extra 0 was typed in front of the number"
    case "short": return `the number has only ${d || "fewer than 10"} digits, fewer than the 10 a mobile number needs`
    case "bad_start": return "the number does not start with 6, 7, 8 or 9, so it is not a mobile number"
    case "repeated": return "the number is a placeholder (one digit repeated), not a real number"
    case "text": return "the phone field holds text or an email address instead of a number"
    default: return undefined
  }
}
