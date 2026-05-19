# Customer Triage

A local web app that pulls customer issues from JIRA and uses Claude to triage
them for an engineering manager.

It produces:

- **Weekly progress + daily tracker + resolution plan** for each hand-picked P0
  customer.
- **Ranked queue** of all customer tickets by severity and customer
  temperature (read from comment tone).
- **Close candidates** — issues that look resolved or have gone stale past the
  inactivity threshold.
- **Ping candidates** — issues where the reporter or assignee has gone silent
  past the ping threshold.
- **2-sprint resolution plan** for non-P0 tickets.

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create `.env.local`

Copy the template and fill in your keys:

```bash
cp .env.example .env.local
```

You need:

- `JIRA_BASE_URL` — your Atlassian Cloud URL, e.g. `https://acme.atlassian.net`
- `JIRA_EMAIL` — the email of the JIRA user the API token belongs to
- `JIRA_API_TOKEN` — create at <https://id.atlassian.com/manage-profile/security/api-tokens>
- `ANTHROPIC_API_KEY` — create at <https://console.anthropic.com/>
- `ANTHROPIC_MODEL` *(optional)* — defaults to `claude-opus-4-7`

### 3. Run the dev server

```bash
npm run dev
```

Open <http://localhost:3000>.

## How to use it

1. Open **Settings** and confirm JIRA + Anthropic show green. Set:
   - **Master JQL** — the universe of customer tickets to triage. Example:
     `project = SUP AND statusCategory != Done ORDER BY updated DESC`.
   - Sprint length, inactivity threshold, ping threshold.
2. Open **P0 Customers** and add your hand-picked list. Each customer has a
   name and a JQL fragment (e.g. `labels = "customer-acme"`). The fragment is
   used to identify which of the pulled tickets belong to that customer.
3. Back on the **Dashboard**, click **Sync from JIRA**. The app will:
   - Query JIRA via the master JQL (paginated).
   - Send tickets to Claude in batches for per-ticket analysis.
   - Generate weekly/daily/plan summaries for each P0 customer.
   - Build the 2-sprint plan for the remainder.
4. Click any row to see the full ticket, recommendation, and temperature
   evidence.

## What lives where

```
src/
├── app/                # Next.js App Router pages + API routes
│   ├── api/            # /config /p0 /sync /report /issues /health
│   ├── page.tsx        # dashboard
│   ├── p0/page.tsx     # P0 customer manager
│   └── settings/page.tsx
├── components/         # UI components
├── lib/
│   ├── jira.ts         # Atlassian REST v3 client
│   ├── anthropic.ts    # Claude SDK wrapper, JSON-mode helper
│   ├── analysis.ts     # ticket batches → analyses → reports
│   ├── db.ts           # better-sqlite3 schema + queries
│   ├── config.ts       # app config (JSON in SQLite)
│   └── sync-state.ts   # in-process sync progress state
└── types/triage.ts     # shared TypeScript types
data/triage.db          # SQLite cache (gitignored)
```

## Notes

- All data is stored locally in `data/triage.db`. Delete it to start fresh.
- The system prompt for ticket analysis is cached on every batch to keep token
  costs down across runs.
- Sync is single-process and single-user. Don't run two syncs at once.
- The 2-sprint plan only looks at the top ~60 non-P0 tickets by combined
  severity + temperature to keep the plan focused.
