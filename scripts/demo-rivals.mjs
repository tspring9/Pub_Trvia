// Two pretend teams, for trying the app without a room full of people. They sign
// up, then answer whatever the host opens, over the same API a phone uses. The
// host still grades them. Run on the server, with .env.dev in the environment:
//
//   sudo systemd-run --unit=pubtrivia-rivals --uid=tomne93 \
//     --property=EnvironmentFile=/home/tomne93/Pub_Trvia/.env.dev \
//     --property=RuntimeMaxSec=8h /usr/bin/node /home/tomne93/Pub_Trvia/scripts/demo-rivals.mjs
//   sudo systemctl stop pubtrivia-rivals
//
// They read the official answer with the host password so that some of their
// answers can be right. That is the one thing a real team cannot do.
import { createHash } from 'node:crypto'

const PORT = process.env.PORT ?? 8789
const BASE = `http://127.0.0.1:${PORT}`
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD
if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD is not set')

// Seconds a rival takes to answer. A short range is handy for testing.
const MIN_DELAY = Number(process.env.RIVALS_MIN_DELAY ?? 5)
const MAX_DELAY = Number(process.env.RIVALS_MAX_DELAY ?? 25)

const WRONG_ANSWERS = ['No idea', 'Paris', 'Abraham Lincoln', '42', 'Canada?', 'The Beatles', 'Mercury']

const rivals = [
  { name: 'Les Quizerables', skill: 0.7 },
  { name: 'Quiz Pro Quo', skill: 0.5 },
].map((r) => ({ ...r, token: null, pending: null, chain: Promise.resolve() }))

const log = (...args) => console.log(new Date().toISOString(), ...args)
const pick = (list) => list[Math.floor(Math.random() * list.length)]

const api = async (path, { method = 'GET', body, token } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, data: await res.json().catch(() => ({})) }
}

// The same password every run, so a restart can sign back in to the same team.
const passwordFor = (name) =>
  createHash('sha256').update(`${ADMIN_PASSWORD}:${name}`).digest('base64url')

async function join(rival) {
  const r = await api('/api/team/login', {
    method: 'POST',
    body: { team_name: rival.name, password: passwordFor(rival.name) },
  })
  if (r.status === 200) {
    rival.token = r.data.token
    log(rival.name, 'signed in')
  } else {
    log(rival.name, 'could not sign in:', r.status, r.data.error)
  }
}

let hostToken = null
async function officialAnswer() {
  let r = await api('/api/admin/state', { token: hostToken })
  if (r.status === 403) {
    const login = await api('/api/admin/login', { method: 'POST', body: { password: ADMIN_PASSWORD } })
    hostToken = login.data.token
    r = await api('/api/admin/state', { token: hostToken })
  }
  return r.data.answer_text ?? ''
}

// Mostly the right order, with a couple of spots swapped when they miss.
function halftimeGuess(official, skill) {
  const guess = official.split(';').map((p) => p.trim()).filter(Boolean)
  for (let i = 0; i < 2; i++) {
    if (Math.random() < skill) continue
    const a = Math.floor(Math.random() * guess.length)
    const b = Math.floor(Math.random() * guess.length)
    ;[guess[a], guess[b]] = [guess[b], guess[a]]
  }
  return guess
}

async function answer(rival, key) {
  const current = (await api('/api/state')).data
  if (!current.submissions_open || `${current.round}-${current.question}` !== key) return

  const me = (await api('/api/team/me', { token: rival.token })).data
  if (me.submission) return

  const official = await officialAnswer()
  const right = Math.random() < rival.skill
  const text = right ? official : pick(WRONG_ANSWERS)
  let body

  if (current.kind === 'tiebreaker') {
    if (!current.tiebreak_teams.includes(rival.name)) return
    body = { answer: text }
  } else if (current.kind === 'halftime') {
    body = { parts: halftimeGuess(official, rival.skill) }
  } else if (current.kind === 'final') {
    // Somewhere between half their limit and all of it.
    const low = Math.ceil(me.max_bet / 2)
    body = { answer: text, wager: low + Math.floor(Math.random() * (me.max_bet - low + 1)) }
  } else {
    body = { answer: text, wager: pick(current.wagers.filter((w) => !me.used_wagers.includes(w))) }
  }

  const r = await api('/api/submit', { method: 'POST', token: rival.token, body })
  log(rival.name, current.label, JSON.stringify(body), '->', r.status, r.data.error ?? '')
}

async function react(rival, state) {
  if (!rival.token) {
    // Back in only for a new game, so removing a rival mid-game keeps it removed.
    if (state.step === 1) await join(rival)
    return
  }

  const me = await api('/api/team/me', { token: rival.token })
  if (me.status === 401) {
    rival.token = null
    log(rival.name, 'was signed out')
    if (state.step === 1) await join(rival)
    return
  }

  const key = `${state.round}-${state.question}`
  if (!state.submissions_open || me.data.submission || rival.pending === key) return

  rival.pending = key
  const delay = MIN_DELAY + Math.random() * (MAX_DELAY - MIN_DELAY)
  setTimeout(() => {
    answer(rival, key)
      .catch((e) => log(rival.name, 'answer failed:', e.message))
      .finally(() => { rival.pending = null })
  }, delay * 1000)
}

function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
  ws.onopen = () => log('connected')
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data)
    if (msg.type !== 'state') return
    for (const rival of rivals) {
      // One at a time per rival, so a burst of pushes cannot sign up twice.
      rival.chain = rival.chain
        .then(() => react(rival, msg.state))
        .catch((err) => log(rival.name, 'failed:', err.message))
    }
  }
  ws.onclose = () => { log('disconnected, retrying'); setTimeout(connect, 2000) }
  ws.onerror = () => ws.close()
}

for (const rival of rivals) await join(rival)
connect()
