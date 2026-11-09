import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  q, tx, publicState, getGameState, allowedWagers, STEPS,
  stepIndexOf, kindOf, labelOf, halfForRound, partsOf, bankedPoints, usedWagers,
  HALFTIME_BANK, FINAL_BANK, HALFTIME_POINTS_PER_ANSWER,
} from './db.ts'
import { hashPassword, verifyPassword, createSession, sessionFrom, generateTempPassword } from './auth.ts'
import { parseQuestionCsv, upsertQuestionBank, questionIndex, questionByNumber, liveText } from './questions.ts'

const PORT = Number(process.env.PORT ?? 8789)
// Loopback by default. Set HOST to the tailnet IP to reach it from your own
// phone over Tailscale without exposing anything publicly; leave it alone when
// fronting with Funnel, which connects over loopback anyway.
const HOST = process.env.HOST ?? '127.0.0.1'
// Prefix this server should expect on INCOMING urls. Empty behind Tailscale
// Funnel, which strips its --set-path prefix before proxying. Set it only for a
// reverse proxy that forwards the prefix intact. The browser-facing prefix is a
// separate thing: PUBLIC_BASE, baked into the frontend at build time.
const BASE_PATH = process.env.BASE_PATH ?? ''
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD
const here = dirname(fileURLToPath(import.meta.url))

if (!ADMIN_PASSWORD) {
  console.error('refusing to start: ADMIN_PASSWORD is not set')
  process.exit(1)
}

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  bodyLimit: 8 * 1024 * 1024,   // question-bank CSVs arrive as a JSON string body
})
await app.register(websocket)

// --- live push -------------------------------------------------------------
// One long-running process holds every socket, so a state change reaches all
// phones directly. This is the piece Vercel's serverless model cannot do, and
// the reason a third-party realtime service is not needed here.
const clients = new Set<import('ws').WebSocket>()

async function broadcast() {
  const payload = JSON.stringify({ type: 'state', state: await publicState() })
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(payload)
    else clients.delete(ws)
  }
}

app.register(async (scope) => {
  scope.get('/ws', { websocket: true }, async (conn) => {
    clients.add(conn)
    conn.send(JSON.stringify({ type: 'state', state: await publicState() }))
    conn.on('close', () => clients.delete(conn))
    conn.on('error', () => clients.delete(conn))
  })
}, { prefix: BASE_PATH })

// --- api -------------------------------------------------------------------
const api = async (scope: typeof app) => {
  scope.get('/api/state', async () => publicState())

  scope.post<{ Body: { team_name?: string; password?: string } }>(
    '/api/team/login', async (req, reply) => {
      const name = (req.body?.team_name ?? '').trim()
      const pw = req.body?.password ?? ''
      if (!name || !pw) return reply.code(400).send({ error: 'Team name and password are required.' })

      const existing = (await q('SELECT * FROM teams WHERE lower(team_name) = lower($1)', [name]))[0]
      if (existing) {
        if (!(await verifyPassword(pw, existing.pass_hash)))
          return reply.code(401).send({ error: 'Wrong password for that team.' })
        return { token: await createSession({ teamId: existing.id }), team_name: existing.team_name }
      }

      const gs = await getGameState()
      if (!gs.allow_new_teams)
        return reply.code(403).send({ error: 'The host has closed new team sign-ups.' })

      const created = (await q(
        'INSERT INTO teams (team_name, pass_hash) VALUES ($1, $2) RETURNING id, team_name',
        [name, await hashPassword(pw)],
      ))[0]
      await broadcast()   // new team shows up on the scoreboard immediately
      return { token: await createSession({ teamId: created.id }), team_name: created.team_name }
    })

  scope.post<{ Body: { password?: string } }>('/api/admin/login', async (req, reply) => {
    if (req.body?.password !== ADMIN_PASSWORD)
      return reply.code(401).send({ error: 'Wrong host password.' })
    return { token: await createSession({ admin: true }) }
  })

  scope.post<{ Body: { answer?: string; parts?: string[]; wager?: number } }>(
    '/api/submit', async (req, reply) => {
      const session = await sessionFrom(req.headers.authorization)
      if (!session?.team_id) return reply.code(401).send({ error: 'Log in as a team first.' })

      const gs = await getGameState()
      if (!gs.submissions_open) return reply.code(409).send({ error: 'Submissions are closed.' })

      const round = gs.current_round
      const question = gs.current_question
      const kind = kindOf(round, question)
      let answer = (req.body?.answer ?? '').trim()
      let wager = Number(req.body?.wager)

      if (kind === 'halftime') {
        // One line per spot. Blanks are kept so every answer stays in its spot.
        const expected = partsOf(gs.answer_text).length
        const parts = req.body?.parts
        if (!Array.isArray(parts) || parts.length !== expected)
          return reply.code(400).send({ error: `Halftime needs ${expected} answers.` })
        const cleaned = parts.map((p) => String(p ?? '').replace(/\s+/g, ' ').trim())
        if (!cleaned.some(Boolean)) return reply.code(400).send({ error: 'Answer cannot be empty.' })
        answer = cleaned.join('\n')
        wager = 0
      } else {
        if (!answer) return reply.code(400).send({ error: 'Answer cannot be empty.' })
      }

      if (kind === 'regular') {
        if (!allowedWagers(gs.half).includes(wager))
          return reply.code(400).send({ error: `Wager must be one of ${allowedWagers(gs.half).join(', ')}.` })
        if ((await usedWagers(session.team_id, round, question)).includes(wager))
          return reply.code(409).send({ error: `You already used ${wager} this round. Pick another.` })
      }

      if (kind === 'final') {
        const banked = await bankedPoints(session.team_id, round, question)
        const max = Math.min(gs.final_max_wager, Math.max(banked, 0))
        if (!Number.isInteger(wager) || wager < 0 || wager > max)
          return reply.code(400).send({ error: `Your bet must be a whole number from 0 to ${max}.` })
      }

      // Same rule as app.py: editable until the host grades it.
      const graded = (await q(
        `SELECT is_correct FROM submissions
         WHERE team_id = $1 AND round_num = $2 AND question_num = $3`,
        [session.team_id, gs.current_round, gs.current_question],
      ))[0]
      if (graded && graded.is_correct !== null)
        return reply.code(409).send({ error: 'Already graded, so your answer is locked.' })

      try {
        await q(
          `INSERT INTO submissions
             (team_id, round_num, question_num, half, submitted_answer, wager_points)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (team_id, round_num, question_num) DO UPDATE
             SET submitted_answer = excluded.submitted_answer,
                 wager_points     = excluded.wager_points,
                 submitted_at     = now()`,
          [session.team_id, round, question, gs.half, answer, wager],
        )
      } catch (e) {
        // Two phones on one team racing past the check above.
        if ((e as { code?: string }).code === '23505')
          return reply.code(409).send({ error: `You already used ${wager} this round. Pick another.` })
        throw e
      }
      await broadcast()   // host watches answers land in real time
      return { ok: true }
    })

  // A team's own answer for the current question, so a phone that reloads can
  // show it again. Also how a phone learns its team was removed: this returns 401.
  scope.get('/api/team/me', async (req, reply) => {
    const session = await sessionFrom(req.headers.authorization)
    if (!session?.team_id) return reply.code(401).send({ error: 'Log in as a team first.' })

    const gs = await getGameState()
    const round = gs.current_round
    const question = gs.current_question
    const submission = (await q(
      `SELECT submitted_answer, wager_points, is_correct, awarded_points, correct_parts
       FROM submissions
       WHERE team_id = $1 AND round_num = $2 AND question_num = $3`,
      [session.team_id, round, question],
    ))[0] ?? null
    const banked = await bankedPoints(session.team_id, round, question)
    return {
      round,
      question,
      submission,
      banked,
      used_wagers: await usedWagers(session.team_id, round, question),
      max_bet: Math.min(gs.final_max_wager, Math.max(banked, 0)),
    }
  })

  // --- host controls ---
  // Next / Back. Always lands closed and unrevealed, with the bank question for
  // the new position already in the host's boxes; teams see it once it is opened.
  // Earlier answers are keyed by position, so going back finds them again.
  scope.post<{ Body: { direction?: number } }>('/api/admin/move', async (req, reply) => {
    const session = await sessionFrom(req.headers.authorization)
    if (!session?.is_admin) return reply.code(403).send({ error: 'Host only.' })

    const direction = req.body?.direction
    if (direction !== 1 && direction !== -1)
      return reply.code(400).send({ error: 'direction must be 1 or -1.' })

    const gs = await getGameState()
    const target = stepIndexOf(gs.current_round, gs.current_question) + direction
    if (target < 0) return reply.code(409).send({ error: 'Already at the first question.' })
    if (target >= STEPS.length) return reply.code(409).send({ error: 'That was the final question.' })

    const step = STEPS[target]
    const row = await questionByNumber(step.bank)
    await q(
      `UPDATE game_state
       SET current_round = $1, current_question = $2, half = $3,
           question_text = $4, answer_text = $5,
           submissions_open = false, revealed = false, updated_at = now()
       WHERE id = 1`,
      [step.round, step.question, halfForRound(step.round), row ? liveText(row) : '', row?.answer ?? ''],
    )
    await broadcast()
    return { ok: true, label: labelOf(step), in_bank: Boolean(row), note: row?.note ?? null }
  })

  // Wipes the scoreboard for a new night. The question bank is left alone.
  scope.post<{ Body: { remove_teams?: boolean } }>('/api/admin/new-game', async (req, reply) => {
    const session = await sessionFrom(req.headers.authorization)
    if (!session?.is_admin) return reply.code(403).send({ error: 'Host only.' })

    const row = await questionByNumber(1)
    await tx(async (client) => {
      await client.query('DELETE FROM submissions')
      // Cascades to the teams' sessions, which signs their phones out.
      if (req.body?.remove_teams === true) await client.query('DELETE FROM teams')
      await client.query(
        `UPDATE game_state
         SET current_round = 1, current_question = 1, half = 1,
             question_text = $1, answer_text = $2,
             submissions_open = false, revealed = false, allow_new_teams = true,
             final_max_wager = 15, updated_at = now()
         WHERE id = 1`,
        [row ? liveText(row) : '', row?.answer ?? ''],
      )
    })
    await broadcast()
    return { ok: true, label: labelOf(STEPS[0]), in_bank: Boolean(row), note: row?.note ?? null }
  })

  scope.get('/api/admin/teams', async (req, reply) => {
    const session = await sessionFrom(req.headers.authorization)
    if (!session?.is_admin) return reply.code(403).send({ error: 'Host only.' })
    return q(`
      SELECT t.id, t.team_name, COALESCE(SUM(s.awarded_points), 0)::int AS score
      FROM teams t
      LEFT JOIN submissions s ON s.team_id = t.id
      GROUP BY t.id, t.team_name
      ORDER BY t.team_name ASC
    `)
  })

  // Generates the password rather than taking one, so the host just reads it
  // out. Signs out the team's other phones: whoever had the old one is out.
  scope.post<{ Params: { id: string } }>('/api/admin/teams/:id/reset-password', async (req, reply) => {
    const session = await sessionFrom(req.headers.authorization)
    if (!session?.is_admin) return reply.code(403).send({ error: 'Host only.' })

    const id = Number(req.params.id)
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'Bad team id.' })

    const password = generateTempPassword()
    const hash = await hashPassword(password)
    const updated = await tx(async (client) => {
      const res = await client.query('UPDATE teams SET pass_hash = $1 WHERE id = $2', [hash, id])
      await client.query('DELETE FROM sessions WHERE team_id = $1', [id])
      return res.rowCount
    })
    if (!updated) return reply.code(404).send({ error: 'That team no longer exists.' })
    await broadcast()   // their phones re-check and find they are signed out
    return { ok: true, password }
  })

  scope.delete<{ Params: { id: string } }>('/api/admin/teams/:id', async (req, reply) => {
    const session = await sessionFrom(req.headers.authorization)
    if (!session?.is_admin) return reply.code(403).send({ error: 'Host only.' })

    const id = Number(req.params.id)
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'Bad team id.' })

    // Cascades to the team's submissions and sessions.
    const removed = await q('DELETE FROM teams WHERE id = $1 RETURNING id', [id])
    if (!removed.length) return reply.code(404).send({ error: 'That team no longer exists.' })
    await broadcast()   // scoreboard drops them, and their phone finds out
    return { ok: true }
  })

  scope.post<{ Body: Record<string, unknown> }>('/api/admin/state', async (req, reply) => {
    const session = await sessionFrom(req.headers.authorization)
    if (!session?.is_admin) return reply.code(403).send({ error: 'Host only.' })

    // Round, question and half are not here: they only change through Next and
    // Back, so the game cannot end up somewhere its scoring does not recognise.
    const allowed = ['question_text', 'answer_text', 'submissions_open', 'revealed',
                     'allow_new_teams', 'final_max_wager']
    const keys = Object.keys(req.body ?? {}).filter((k) => allowed.includes(k))
    if (!keys.length) return reply.code(400).send({ error: 'Nothing to update.' })

    if ('final_max_wager' in req.body) {
      const limit = req.body.final_max_wager
      if (!Number.isInteger(limit) || (limit as number) < 0)
        return reply.code(400).send({ error: 'The final wager limit must be a whole number, 0 or more.' })
    }

    await q(
      `UPDATE game_state SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')},
       updated_at = now() WHERE id = 1`,
      keys.map((k) => req.body[k]),
    )
    await broadcast()
    return { ok: true, state: await publicState() }
  })

  // The host needs answer_text to grade, which publicState() deliberately
  // withholds from teams until reveal. This is the host's full view.
  scope.get('/api/admin/state', async (req, reply) => {
    const session = await sessionFrom(req.headers.authorization)
    if (!session?.is_admin) return reply.code(403).send({ error: 'Host only.' })
    return getGameState()
  })

  scope.get('/api/admin/submissions', async (req, reply) => {
    const session = await sessionFrom(req.headers.authorization)
    if (!session?.is_admin) return reply.code(403).send({ error: 'Host only.' })
    const gs = await getGameState()
    return q(
      `SELECT s.*, t.team_name FROM submissions s
       JOIN teams t ON t.id = s.team_id
       WHERE s.round_num = $1 AND s.question_num = $2
       ORDER BY s.submitted_at ASC`,
      [gs.current_round, gs.current_question],
    )
  })

  // --- question bank ---
  // The browser reads the file with FileReader and posts the text, so there is
  // no multipart dependency. Fine for a bank of a few hundred questions.
  scope.post<{ Body: { csv?: string } }>('/api/admin/questions', async (req, reply) => {
    const session = await sessionFrom(req.headers.authorization)
    if (!session?.is_admin) return reply.code(403).send({ error: 'Host only.' })

    const text = req.body?.csv
    if (typeof text !== 'string' || !text.trim())
      return reply.code(400).send({ error: 'No file contents received.' })

    const { rows, errors } = parseQuestionCsv(text)
    // Refuse the whole upload if anything is wrong, so the bank never ends up
    // half-loaded and silently missing questions mid-game.
    if (errors.length) return reply.code(400).send({ error: 'Nothing was imported.', errors })

    const count = await upsertQuestionBank(rows)
    return { ok: true, imported: count, questions: await questionIndex() }
  })

  scope.get('/api/admin/questions', async (req, reply) => {
    const session = await sessionFrom(req.headers.authorization)
    if (!session?.is_admin) return reply.code(403).send({ error: 'Host only.' })
    return questionIndex()
  })

  // Pull any question from the bank into the live game, e.g. a backup. Next and
  // Back go by position, so the game picks up where it left off afterwards.
  scope.post<{ Body: { q_number?: number } }>('/api/admin/load-question', async (req, reply) => {
    const session = await sessionFrom(req.headers.authorization)
    if (!session?.is_admin) return reply.code(403).send({ error: 'Host only.' })

    const n = Number(req.body?.q_number)
    if (!Number.isInteger(n)) return reply.code(400).send({ error: 'q_number is required.' })

    const row = await questionByNumber(n)
    if (!row) return reply.code(404).send({ error: `Question ${n} is not in the bank.` })

    // Scoring follows the game's position, so these only fit in their own spot.
    const gs = await getGameState()
    const kind = kindOf(gs.current_round, gs.current_question)
    if (n === HALFTIME_BANK && kind !== 'halftime')
      return reply.code(409).send({ error: 'Move to halftime before loading the halftime question.' })
    if (n === FINAL_BANK && kind !== 'final')
      return reply.code(409).send({ error: 'Move to the final before loading the final question.' })

    await q(
      `UPDATE game_state
       SET question_text = $1, answer_text = $2, submissions_open = false,
           revealed = false, updated_at = now()
       WHERE id = 1`,
      [liveText(row), row.answer],
    )
    await broadcast()
    return { ok: true, loaded: n, note: row.note ?? null }
  })

  scope.post<{ Body: { id?: number; correct?: boolean; correct_parts?: number; awarded_points?: number } }>(
    '/api/admin/grade', async (req, reply) => {
      const session = await sessionFrom(req.headers.authorization)
      if (!session?.is_admin) return reply.code(403).send({ error: 'Host only.' })

      const { id, correct, correct_parts: correctParts } = req.body ?? {}
      if (!id) return reply.code(400).send({ error: 'id is required.' })

      const sub = (await q('SELECT * FROM submissions WHERE id = $1', [id]))[0]
      if (!sub) return reply.code(404).send({ error: 'That answer no longer exists.' })

      const kind = kindOf(sub.round_num, sub.question_num)
      let isCorrect: boolean
      let awarded: number
      let parts: number | null = null

      if (kind === 'halftime') {
        const spots = sub.submitted_answer.split('\n').length
        if (!Number.isInteger(correctParts) || correctParts! < 0 || correctParts! > spots)
          return reply.code(400).send({ error: `correct_parts must be from 0 to ${spots}.` })
        parts = correctParts!
        isCorrect = parts > 0
        awarded = parts * HALFTIME_POINTS_PER_ANSWER
      } else {
        if (typeof correct !== 'boolean')
          return reply.code(400).send({ error: 'correct is required.' })
        isCorrect = correct
        // The final is the one real bet: a miss costs the points wagered.
        // Anywhere else a miss earns nothing, and the host can override a correct one.
        awarded = kind === 'final'
          ? (correct ? sub.wager_points : -sub.wager_points)
          : (req.body.awarded_points ?? (correct ? sub.wager_points : 0))
      }

      await q(
        `UPDATE submissions
         SET is_correct = $2, awarded_points = $3, correct_parts = $4, graded_at = now()
         WHERE id = $1`,
        [id, isCorrect, awarded, parts],
      )
      await broadcast()   // scoreboard moves the instant the host grades
      return { ok: true }
    })
}

app.register(api as never, { prefix: BASE_PATH })

// --- frontend --------------------------------------------------------------
const webRoot = join(here, '../../web/dist')
app.register(fastifyStatic, { root: webRoot, prefix: `${BASE_PATH}/`, wildcard: false })
app.setNotFoundHandler((req, reply) => {
  if (req.url.startsWith(`${BASE_PATH}/api`)) return reply.code(404).send({ error: 'Not found' })
  return reply.sendFile('index.html')
})

// Funnel is the sole route in from outside; see HOST above.
await app.listen({ port: PORT, host: HOST })
