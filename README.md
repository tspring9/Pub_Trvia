# Pub Trivia

Live pub trivia: teams answer on their phones, the host opens/closes questions and
grades, the scoreboard updates for everyone the instant a grade lands.

Self-hosted on `rbsandbox`. Postgres and the app both run on that box; the only
public entry point is a Tailscale Funnel path.

```
Postgres 17 (127.0.0.1:5432)   pubtrivia / pubtrivia_dev, never leaves the box
        |
Node 24 + Fastify (127.0.0.1)  API + websocket fan-out + static frontend
        |
Tailscale Funnel               /trivia -> :8790 (prod), /trivia-dev -> :8789
        |
phones                         no Tailscale needed, valid TLS
```

## Why not Supabase / Vercel

A single long-running process holds every websocket, so `broadcast()` pushes state
to all connected phones directly. That removes the two things a serverless host
would have forced:

- **No third-party realtime.** Vercel functions cannot hold a socket open, which
  is the only reason Supabase Realtime was ever on the table.
- **No row-level security.** The browser never talks to Postgres. `publicState()`
  is the sole thing a team can see, and it withholds `answer_text` until the host
  reveals it.

## Layout

| Path | What |
|---|---|
| `db/schema.sql` | Postgres schema, idempotent |
| `server/src/index.ts` | Fastify routes + websocket broadcast |
| `server/src/db.ts` | Pool, `publicState()`, leaderboard |
| `server/src/auth.ts` | scrypt hashing, token sessions |
| `web/src/live.js` | `useLiveState()` — websocket with reconnect-on-wake |
| `web/src/App.jsx` | Login, scoreboard |
| `web/src/Team.jsx` | Team screen: answers, wagers, halftime spots, final bet |
| `web/src/Host.jsx` | Host console: open/close/reveal/next, grading, new game |
| `web/src/Bank.jsx` | Question bank: CSV upload, index, load into the game |
| `web/src/Teams.jsx` | Team list: new password, remove |
| `deploy/*.service` | systemd units |
| `app.py` | the original Streamlit version, kept for reference |

Node 24 runs the TypeScript directly, no build step — same as `leaguelens.service`.

## Environments

Mirrors the `leaguelens` / `leaguelens-live` split.

| | dev | prod |
|---|---|---|
| database | `pubtrivia_dev` | `pubtrivia` |
| port | 8789 | 8790 |
| path | `/trivia-dev` | `/trivia` |
| env file | `.env.dev` | `.env.prod` |
| unit | `pubtrivia-dev.service` | `pubtrivia.service` |

## Setup

Database. Safe to re-run, and needed after any deploy that changes the schema:

```sh
PGPASSWORD=... psql -h 127.0.0.1 -U pubtrivia -d pubtrivia_dev -f db/schema.sql
```

Deploy from the laptop:

```sh
tar --exclude=.git --exclude=node_modules --exclude=dist -czf - . \
  | ssh leaguelens-sbx 'tar -xzf - -C ~/Pub_Trvia'
ssh leaguelens-sbx 'cd ~/Pub_Trvia/server && npm install'
ssh leaguelens-sbx 'cd ~/Pub_Trvia/web && npm install && PUBLIC_BASE=/trivia-dev npm run build'
ssh leaguelens-sbx 'sudo systemctl restart pubtrivia-dev'
```

`PUBLIC_BASE` must match the funnel path — it is compiled into the asset URLs.

Service:

```sh
sudo cp deploy/pubtrivia-dev.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now pubtrivia-dev
journalctl -u pubtrivia-dev -f
```

## Exposing it

**Public, for game night.** Adds a path beside LeagueLens on `/`; back up first:

```sh
tailscale serve status --json > ~/.funnel-backup/serve-$(date +%F-%H%M).json
sudo tailscale funnel --bg --set-path /trivia-dev 8789
```

Gives `https://leaguelens-sbx.tail0ad7bc.ts.net/trivia-dev`. Print a QR code —
nobody is typing that. To undo: `sudo tailscale funnel --set-path /trivia-dev off`.

**Tailnet only, for testing on your own phone.** No public exposure; set
`HOST=<tailnet-ip>` in `.env.dev`, restart, then browse to
`http://<tailnet-ip>:8789/trivia-dev`. ufw already allows all tailnet traffic.

## Local development

```sh
cd server && npm start                      # API on :8789
cd web && npm run dev                       # Vite on :5173, proxies to :8789
```

Point `.env` at `pubtrivia_dev` so you are never developing against game data.

## Operational notes

- **Backups are not set up.** Losing scores mid-game is the one unrecoverable
  failure here, so add a `pg_dump` cron before you play for real.
- **Your house is the single point of failure.** Power or internet dropping at 8pm
  stops the game. Accepted tradeoff for running it yourself.
- **Funnel is not for heavy traffic.** Fine for ~15 phones exchanging small JSON.
- **`ADMIN_PASSWORD` has no default.** The server refuses to boot without it, so
  the old `changeme` cannot reach the internet.

- **Prod's port is taken.** FantasyCFB's Funnel route now uses 8790, so give prod
  a different port before starting `pubtrivia.service`.

## Game rules, as implemented

- A game runs: rounds 1-3, halftime, rounds 4-6, final. Each round has 3 questions.
  Next and Back move through them and load the matching bank question: round 2,
  question 1 is #4, and the last regular question is #18. Loading a different bank
  question is a one-off swap and does not shift the rest.
- Rounds 1-3 are half 1 and rounds 4-6 are half 2, set by Next and Back.
- Teams only see a question once the host has opened or revealed it.
- New game clears answers and scores, keeping or removing teams, and puts the final
  wager limit back to 15. The bank stays.
- One submission per team per question; editable until the host grades it.

**Regular questions.** Wagers are 1/3/5 in the first half and 2/4/6 in the second.
Each value can be used once per round and comes back the next round. A correct
answer earns the wager and a miss earns 0.

**Halftime.** The CSV row has Number `Halftime`, and its Answer lists the right order
with semicolons: `A; B; C; D`. Teams get one box per spot. The host taps how many are
in the right spot, worth 2 points each, and a miss costs nothing.

**Final.** The CSV row has Number `Final`. Teams bet from 0 up to the host's limit
(default 15), and never more than their banked points. A correct answer adds the bet
and a miss subtracts it. Bet and answer go in together, and can be changed until the
host grades them.
