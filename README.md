# Aquant Insight

One dashboard for WhatsApp messages, leads and opportunities, with a lookup for a single customer.
Built with React, **shadcn/ui** (Tailwind), Recharts and a small local server. It runs on your own computer: customer data never goes to a website.

## Run it
Double-click **`start.bat`**. After about 15 seconds your browser opens at http://localhost:8787. Close the window, or run `stop.bat`, to stop it.
(First time only it installs packages and builds the app. Needs Node 22 or newer.)

## Hosting on Netlify
The dashboard can also run as a website on Netlify: Netlify serves the built web app and runs the API as a Netlify Function (`netlify.toml`, `netlify/functions/api.mjs`). Connect the GitHub repo to a Netlify site (no build settings to type, they are in `netlify.toml`), then add these under **Site configuration > Environment variables** and deploy again:

| Variable | What to put |
|---|---|
| `DATABASE_URL` | the read-only `dashboard_ro` connection (or `PGHOST`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`). The database must be reachable from the internet. Use the direct or session-mode address, not a transaction pooler |
| `DEMO_USER`, `DEMO_PASS` | your own login for the site. The default password is public and is refused |
| `SESSION_SECRET` | any random text of 32 or more characters |
| `ALLOW_REVEAL` | leave unset: after logging in, a "Show phone numbers and messages" switch appears (everything stays hidden until it is pressed, and again after a reload or log out). `false` removes the switch for everyone |

Until all four are set the site says what is missing on the login screen. Do not put the `.env` file in the repo; it is ignored on purpose. The website works only with the live database, never with the CSV files.

## Log in
The app asks for a demo login first: user name **admin**, password **pass@123**. Change them with `DEMO_USER` and `DEMO_PASS` in `.env` (do this before sharing a link). It is one shared demo account, not user management. The session lasts 8 hours or until the server restarts, and there is a **Log out** button in the top bar.

## Pages
Five pages. Every page opens on **yesterday**; pick another range in the date filter (an explicit "All time" is kept as you move between pages).
| Page | What it answers |
|---|---|
| **Overview** | Chats, leads and WhatsApp messages in one place: counts with percentages, reply time, send-time chart, message funnel (grey = sent, green = delivered, blue = read) and a template table. |
| **Messages** | How messages and templates perform: numbers, funnel, trend, why messages failed, and a list of every message sent ("WhatsApp message sent to Name (+91…)"). Pick a template to see its text, cost and price type. |
| **Chats** | WATI-style chat reporting: activity, status over time, volume heat map, chat length, team performance and what each chat cost. |
| **Agents** | The people who handle the chats: chats assigned, answered, missed, waiting, how long customers waited (typical, slowest 1 in 10, within 5 minutes and 1 hour), reply times by hour of day, bots kept separate, and the chats behind every number. Reply time comes from WATI's own record plus the team replies the workflow saved, and every figure shows how many chats it rests on. |
| **Customer lookup** | Search one customer by phone digits (4 or more), name, lead id or opportunity id. Shows their leads, opportunities, every WhatsApp template sent and its outcome, customer messages, data-quality notes and a dated timeline. |

**Export report** (top bar) makes a printable report for the dates and filters you picked: it opens in a new tab, where you can download it as a file or save it as a PDF. It holds totals only (no phone numbers or message text).

Filters (date range, template, lead source, owner, status) sit at the top of each page and live in the web address, so a filtered view can be bookmarked or sent.
When a date range is chosen, each rate is compared with the same number of days before it.

## Privacy
- The server listens on this computer only and rejects requests for any other host name.
- Phone numbers are masked (last 4 digits). Names that are really phone numbers are masked too.
- On a customer page, a switch reveals the full phone and the text of that customer's messages. Turn this off for everyone with `ALLOW_REVEAL=false` in `.env`.
- The `dashboard` folder holds no customer data. It reads the CSV exports from `..\data_insight`.

## Data sources
**CSV mode (default).** Reads the five exports in `..\data_insight` (`lead_insight`, `opportunity_insight`, `wati_message_pivot`, `wati_message_log`, `wati_sessions`). It is a snapshot. To refresh, replace the files and restart.

**Connecting the live database.** Then every page reads the real data and the header badge says "Live database".
1. Someone with database admin rights runs, in this order, `server/sql/reporting_views.sql` then `server/sql/app.sql`. They create read-only views in a new schema called `reporting`; no table is changed.
2. Create a read-only login:
   ```sql
   create role dashboard_ro login password '<choose-a-strong-password>';
   grant connect on database <your_db> to dashboard_ro;
   grant usage on schema reporting to dashboard_ro;
   grant select on all tables in schema reporting to dashboard_ro;
   alter default privileges in schema reporting grant select on tables to dashboard_ro;
   -- the Chats and Customer lookup pages read these two source tables directly (read-only)
   grant usage on schema public to dashboard_ro;
   grant select on public.wati_message_log, public.wati_sessions to dashboard_ro;
   ```
   Re-run the `grant select` line after re-running the SQL files, because the views are recreated.
3. Copy `.env.example` to `.env`, set `DATABASE_URL`, and restart. Do not share the file. For Supabase, use the "Session pooler" address from Project, Connect (the plain address only works over IPv6).
4. Run `node server/check_live.mjs`. It connects read-only and tells you in plain words what is missing (views, grants, an old feed). Fix anything marked FIX, then start the dashboard with `start.bat`.
5. Open **Overview** or **Messages** in the sidebar. The badge at the top right says "Live" with the time of the last refresh, and the numbers refresh by themselves every minute. In snapshot mode the same badge says "Snapshot" and nothing refreshes.

Real time depends on the feed, not on the dashboard: WATI sends each event to n8n, n8n saves it to the database, and the dashboard reads it within a minute. If the newest message in the log is old, the problem is the WATI webhook or the n8n workflow, and `check_live.mjs` says so.

Every query runs inside a read-only transaction, so the app cannot change your data even by mistake. Answers are cached for 60 seconds in live mode.

## What the numbers mean
- **Messages followed** = sent plus failed, minus repeat sends of the same template to the same number. Only the first message of a template is tracked today, so later ones cannot be followed.
- **Delivered, read** = the highest of the delivered, read and replied counters per row. The raw delivered counter misses most events, so these are lower bounds. (The earlier dashboard showed 23.3% delivered; measured, it is 60.5%.)
- **Dates** on message pages are the first send to that person for that template, the same rule the earlier dashboard used.
- **Won and lost** are counted from the opportunity status, not the flag columns, which disagree on some rows.

## Known data problems the dashboard shows rather than hides
- The real lead source was replaced by a status for 62% of leads (workflow #7). It shows as "unknown".
- The phone number was replaced by text for 31% of leads. Those leads cannot be linked to their messages.
- The WhatsApp feed was silent from 6 to 12 March and from 2 September to 22 October 2026.
- No agent messages are logged, so reply time is not available yet.

## Tests
With the server running, `npm test` runs 61 checks against the API. The expected numbers were verified independently. The same checks also pass when the app reads through the Postgres driver (tested against a Postgres-protocol stand-in loaded with the same data, not against your real database, so run `npm test` once after connecting it).

## Folder map
```
server/      index.mjs (web server), db.mjs (CSV or live), queries.mjs (every number), sql/ (the views), test_api.mjs
src/         pages/ (the five pages), components/ (shadcn/ui and shared pieces), lib/ (data, filters, formatting)
start.bat    stop.bat    .env.example
```
