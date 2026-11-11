import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  q, tx, publicState, getGameState, allowedWagers, STEPS, liveScores, tiedForFirst, publishScores,
  stepIndexOf, kindOf, labelOf, halfForRound, partsOf, bankedPoints, usedWagers, stageEndLabel,
  HALFTIME_BANK, FINAL_BANK, TIEBREAK_BANK, HALFTIME_POINTS_PER_ANSWER,
  DEFAULT_FINAL_WAGER, DEFAULT_TIMER_SECONDS,
} from './db.ts'
import { hashPassword, verifyPassword, createSession, sessionFrom, generateTempPassword } from './auth.ts'
import { parseQuestionCsv, upsertQuestionBank, questionIndex, questionByNumber, liveText } from './questions.ts'
import {
  clientIp, lockedForMinutes, recordFailure, clearFailures,
  HOST_LOGIN_ATTEMPTS, TEAM_LOGIN_ATTEMPTS, MAX_TEAMS, MAX_TEAM_NAME, MAX_PASSWORD, MAX_ANSWER,
} from './limits.ts'

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

// The countdown lives here rather than on the phones, so it closes for everyone
// at once and survives a restart.
setInterval(async () => {
  try {
    const closed = await q(
      `UPDATE game_state SET submissions_open = false, deadline = NULL, updated_at = now()
       WHERE id = 1 AND submissions_open AND deadline IS NOT NULL AND deadline <= now()
       RETURNING id`,
    )
    if (closed.length) await broadcast()
  } catch (e) {
    app.log.error(e)
  }
}, 1000)

const isHost = async (req: any, reply: any): Promise<boolean> => {
  const session = await sessionFrom(req.headers.authorization)
  if (session?.is_admin) return true
  reply.code(403).send({ error: 'Host only.' })
  return false
}

const answersAtCurrent = async (round: number, question: number): Promise<number> =>
  (await q<{ n: number }>(
    'SELECT count(*)::int AS n FROM submissions WHERE round_num = $1 AND question_num = $2',
    [round, question],
  ))[0].n

const clearAnswersAtCurrent = (round: number, question: number) =>
  q('DELETE FROM submissions WHERE round_num = $1 AND question_num = $2', [round, question])

// Works out one grade. Returns an error message when the input does not fit.
function scoreFor(sub: any, body: { correct?: boolean; correct_parts?: number; awarded_points?: number }) {
  const kind = kindOf(sub.round_num, sub.question_num)

  if (kind === 'halftime') {
    const spots = sub.submitted_answer.split('\n').length
    const parts = body.correct_parts as number
    if (!Number.isInteger(parts) || parts < 0 || parts > spots)
      return { error: `correct_parts must be from 0 to ${spots}.` }
    return { isCorrect: parts > 0, awarded: parts * HALFTIME_POINTS_PER_ANSWER, parts }
  }

  if (typeof body.correct !== 'boolean') return { error: 'correct is required.' }
  // The final is the one real bet: a miss costs the points wagered. Anywhere else
  // a miss earns nothing, and the host can override a correct one.
  const awarded = kind === 'final'
    ? (body.correct ? sub.wager_points : -sub.wager_points)
    : kind === 'tiebreaker' ? 0
    : (body.awarded_points ?? (body.correct ? sub.wager_points : 0))
  return { isCorrect: body.correct, awarded, parts: null }
}

const saveGrade = (id: number, s: { isCorrect?: boolean; awarded?: number; parts?: number | null }) =>
  q(
    `UPDATE submissions
     SET is_correct = $2, awarded_points = $3, correct_parts = $4, graded_at = now()
     WHERE id = $1`,
    [id, s.isCorrect, s.awarded, s.parts],
  )

// --- api -------------------------------------------------------------------
const api = async (scope: typeof app) => {
  scope.get('/api/state', async () => publicState())

  scope.post<{ Body: { team_name?: string; password?: string } }>(
    '/api/team/login', async (req, reply) => {
      const name = String(req.body?.team_name ?? '').trim()
      const pw = String(req.body?.password ?? '')
      if (!name || !pw) return reply.code(400).send({ error: 'Team name and password are required.' })
      if (name.length > MAX_TEAM_NAME)
        return reply.code(400).send({ error: `Team names can be up to ${MAX_TEAM_NAME} characters.` })
      if (pw.length > MAX_PASSWORD) return reply.code(400).send({ error: 'That password is too long.' })

      // Keyed by team as well: a whole bar shares one internet address.
      const key = `team:${clientIp(req)}:${name.toLowerCase()}`
      const locked = lockedForMinutes(key, TEAM_LOGIN_ATTEMPTS)
      if (locked) return reply.code(429).send({ error: `Too many wrong passwords. Try again in ${locked} min, or ask the host for a new one.` })

      const existing = (await q('SELECT * FROM teams WHERE lower(team_name) = lower($1)', [name]))[0]
      if (existing) {
        if (!(await verifyPassword(pw, existing.pass_hash))) {
          recordFailure(key)
          return reply.code(401).send({ error: 'Wrong password for that team.' })
        }
        clearFailures(key)
        return { token: await createSession({ teamId: existing.id }), team_name: existing.team_name }
      }

      const gs = await getGameState()
      if (!gs.allow_new_teams)
        return reply.code(403).send({ error: 'The host has closed new team sign-ups.' })

      const count = (await q<{ n: number }>('SELECT count(*)::int AS n FROM teams'))[0].n
      if (count >= MAX_TEAMS) return reply.code(403).send({ error: 'This game is full.' })

      const created = (await q(
        'INSERT INTO teams (team_name, pass_hash) VALUES ($1, $2) RETURNING id, team_name',
        [name, await hashPassword(pw)],
      ))[0]
      await broadcast()   // new team shows up on the scoreboard immediately
      return { token: await createSession({ teamId: created.id }), team_name: created.team_name }
    })

  scope.post<{ Body: { password?: string } }>('/api/admin/login', async (req, reply) => {
    // A signed-in host is unaffected by this, so guessing cannot lock them out mid-game.
    const key = `host:${clientIp(req)}`
    const locked = lockedForMinutes(key, HOST_LOGIN_ATTEMPTS)
    if (locked) return reply.code(429).send({ error: `Too many wrong passwords. Try again in ${locked} min.` })

    if (req.body?.password !== ADMIN_PASSWORD) {
      recordFailure(key)
      return reply.code(401).send({ error: 'Wrong host password.' })
    }
    clearFailures(key)
    return { token: await createSession({ admin: true }) }
  })

  scope.post<{ Body: { answer?: string; parts?: string[]; wager?: number } }>(
    '/api/submit', async (req, reply) => {
      const session = await sessionFrom(req.headers.authorization)
      if (!session?.team_id) return reply.code(401).send({ error: 'Log in as a team first.' })

      const gs = await getGameState()
      const expired = gs.deadline && new Date(gs.deadline).getTime() <= Date.now()
      if (!gs.submissions_open || expired) return reply.code(409).send({ error: 'Submissions are closed.' })

      const round = gs.current_round
      const question = gs.current_question
      const kind = kindOf(round, question)
      let answer = String(req.body?.answer ?? '').trim()
      let wager = Number(req.body?.wager)

      if (kind === 'halftime') {
        // One line per spot. Blanks are kept so every answer stays in its spot.
        const expected = partsOf(gs.answer_text).length
        const parts = req.body?.parts
        if (!Array.isArray(parts) || parts.length !== expected)
          return reply.code(400).send({ error: `Halftime needs ${expected} answers.` })
        const cleaned = parts.map((p) => String(p ?? '').replace(/\s+/g, ' ').trim())
        if (!cleaned.some(Boolean)) return reply.code(400).send({ error: 'Answer cannot be empty.' })
        if (cleaned.some((p) => p.length > MAX_ANSWER))
          return reply.code(400).send({ error: `Answers can be up to ${MAX_ANSWER} characters.` })
        answer = cleaned.join('\n')
        wager = 0
      } else {
        if (!answer) return reply.code(400).send({ error: 'Answer cannot be empty.' })
        if (answer.length > MAX_ANSWER)
          return reply.code(400).send({ error: `Answers can be up to ${MAX_ANSWER} characters.` })
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

      if (kind === 'tiebreaker') {
        const tied = await tiedForFirst()
        if (!tied.some((t) => t.id === session.team_id))
          return reply.code(403).send({ error: 'Only the tied teams answer the tiebreaker.' })
        wager = 0
      }

      // Same rule as app.py: editable until the host grades it.
      const graded = (await q(
        `SELECT is_correct FROM submissions
         WHERE team_id = $1 AND round_num = $2 AND question_num = $3`,
        [session.team_id, round, question],
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
    let submission = (await q(
      `SELECT submitted_answer, wager_points, is_correct, awarded_points, correct_parts
       FROM submissions
       WHERE team_id = $1 AND round_num = $2 AND question_num = $3`,
      [session.team_id, round, question],
    ))[0] ?? null

    // Keeps the suspense: a final result stays hidden until the host shows it.
    if (submission && kindOf(round, question) === 'final' && !gs.revealed && !gs.show_winners)
      submission = { ...submission, is_correct: null, awarded_points: 0 }

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
  // Moving on from the last question of a round updates the public scoreboard.
  scope.post<{ Body: { direction?: number } }>('/api/admin/move', async (req, reply) => {
    if (!(await isHost(req, reply))) return reply

    const direction = req.body?.direction
    if (direction !== 1 && direction !== -1)
      return reply.code(400).send({ error: 'direction must be 1 or -1.' })

    const gs = await getGameState()
    const target = stepIndexOf(gs.current_round, gs.current_question) + direction
    if (target < 0) return reply.code(409).send({ error: 'Already at the first question.' })
    if (target >= STEPS.length) return reply.code(409).send({ error: 'That was the last question.' })

    const step = STEPS[target]
    if (step.kind === 'tiebreaker' && !(await tiedForFirst()).length)
      return reply.code(409).send({ error: 'That was the final question, and first place is not tied.' })

    const stageEnd = stageEndLabel(gs.current_round, gs.current_question)
    if (direction === 1 && stageEnd) await publishScores(stageEnd)

    const row = await questionByNumber(step.bank)
    await q(
      `UPDATE game_state
       SET current_round = $1, current_question = $2, half = $3,
           question_text = $4, answer_text = $5, note_text = $6,
           submissions_open = false, revealed = false, question_shown = false,
           deadline = NULL, show_winners = false,
           tiebreak_winner = CASE WHEN $7 THEN NULL ELSE tiebreak_winner END,
           updated_at = now()
       WHERE id = 1`,
      [step.round, step.question, halfForRound(step.round), row ? liveText(row) : '',
       row?.answer ?? '', row?.note ?? '', step.kind === 'tiebreaker'],
    )
    await broadcast()
    return { ok: true, label: labelOf(step), in_bank: Boolean(row) }
  })

  // Puts the scoreboard up without waiting for Next, e.g. to show the room the
  // standings at the end of a round before moving on.
  scope.post('/api/admin/publish-scores', async (req, reply) => {
    if (!(await isHost(req, reply))) return reply
    const gs = await getGameState()
    const label = stageEndLabel(gs.current_round, gs.current_question)
    if (!label) return reply.code(409).send({ error: 'The scoreboard updates at the end of a round.' })
    await publishScores(label)
    await broadcast()
    return { ok: true, label }
  })

  // The host's trigger, so grades can be fixed first. Hiding it again allows
  // another correction, and showing it again picks that up.
  scope.post<{ Body: { show?: boolean } }>('/api/admin/winners', async (req, reply) => {
    if (!(await isHost(req, reply))) return reply
    const gs = await getGameState()
    const kind = kindOf(gs.current_round, gs.current_question)
    if (kind !== 'final' && kind !== 'tiebreaker')
      return reply.code(409).send({ error: 'The winner screen comes after the final question.' })

    const show = req.body?.show === true
    if (show) await publishScores('Final standings')
    await q(
      `UPDATE game_state SET show_winners = $1,
         submissions_open = CASE WHEN $1 THEN false ELSE submissions_open END,
         deadline = CASE WHEN $1 THEN NULL ELSE deadline END,
         updated_at = now()
       WHERE id = 1`,
      [show],
    )
    await broadcast()
    return { ok: true }
  })

  scope.post<{ Body: { team_id?: number | null } }>('/api/admin/tiebreak-winner', async (req, reply) => {
    if (!(await isHost(req, reply))) return reply
    const id = req.body?.team_id ?? null
    if (id !== null && !(await tiedForFirst()).some((t) => t.id === id))
      return reply.code(400).send({ error: 'That team is not tied for first.' })
    await q('UPDATE game_state SET tiebreak_winner = $1, updated_at = now() WHERE id = 1', [id])
    await broadcast()
    return { ok: true }
  })

  // Adds time to the running countdown.
  scope.post<{ Body: { seconds?: number } }>('/api/admin/extend', async (req, reply) => {
    if (!(await isHost(req, reply))) return reply
    const seconds = req.body?.seconds
    if (!Number.isInteger(seconds) || seconds! < 1 || seconds! > 600)
      return reply.code(400).send({ error: 'seconds must be from 1 to 600.' })
    const updated = await q(
      `UPDATE game_state SET deadline = deadline + $1 * interval '1 second', updated_at = now()
       WHERE id = 1 AND submissions_open AND deadline IS NOT NULL RETURNING id`,
      [seconds],
    )
    if (!updated.length) return reply.code(409).send({ error: 'No countdown is running.' })
    await broadcast()
    return { ok: true }
  })

  // Wipes the scoreboard for a new night. The question bank is left alone.
  scope.post<{ Body: { remove_teams?: boolean } }>('/api/admin/new-game', async (req, reply) => {
    if (!(await isHost(req, reply))) return reply

    const row = await questionByNumber(1)
    await tx(async (client) => {
      await client.query('DELETE FROM submissions')
      // Cascades to the teams' sessions, which signs their phones out.
      if (req.body?.remove_teams === true) await client.query('DELETE FROM teams')
      await client.query('UPDATE teams SET published_score = 0')
      await client.query(
        `UPDATE game_state
         SET current_round = 1, current_question = 1, half = 1,
             question_text = $1, answer_text = $2, note_text = $3,
             submissions_open = false, revealed = false, question_shown = false,
             allow_new_teams = true, final_max_wager = $4, timer_seconds = $5,
             deadline = NULL, show_winners = false, scoreboard_label = '',
             tiebreak_winner = NULL, updated_at = now()
         WHERE id = 1`,
        [row ? liveText(row) : '', row?.answer ?? '', row?.note ?? '',
         DEFAULT_FINAL_WAGER, DEFAULT_TIMER_SECONDS],
      )
    })
    await broadcast()
    return { ok: true, label: labelOf(STEPS[0]), in_bank: Boolean(row) }
  })

  scope.get('/api/admin/teams', async (req, reply) => {
    if (!(await isHost(req, reply))) return reply
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
    if (!(await isHost(req, reply))) return reply

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
    if (!(await isHost(req, reply))) return reply

    const id = Number(req.params.id)
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'Bad team id.' })

    // Cascades to the team's submissions and sessions.
    const removed = await q('DELETE FROM teams WHERE id = $1 RETURNING id', [id])
    if (!removed.length) return reply.code(404).send({ error: 'That team no longer exists.' })
    await broadcast()   // scoreboard drops them, and their phone finds out
    return { ok: true }
  })

  scope.post<{ Body: Record<string, unknown> }>('/api/admin/state', async (req, reply) => {
    if (!(await isHost(req, reply))) return reply

    // Round, question and half are not here: they only change through Next and
    // Back, so the game cannot end up somewhere its scoring does not recognise.
    const allowed = ['question_text', 'answer_text', 'note_text', 'submissions_open', 'revealed',
                     'allow_new_teams', 'final_max_wager', 'timer_seconds']
    const body = req.body ?? {}
    const keys = Object.keys(body).filter((k) => allowed.includes(k))
    if (!keys.length) return reply.code(400).send({ error: 'Nothing to update.' })

    if ('final_max_wager' in body) {
      const limit = body.final_max_wager
      if (!Number.isInteger(limit) || (limit as number) < 0)
        return reply.code(400).send({ error: 'The final wager limit must be a whole number, 0 or more.' })
    }
    if ('timer_seconds' in body) {
      const seconds = body.timer_seconds
      if (!Number.isInteger(seconds) || (seconds as number) < 0 || (seconds as number) > 3600)
        return reply.code(400).send({ error: 'The timer must be from 0 to 60 minutes.' })
    }

    const gs = await getGameState()

    // Changing the question under answers already given needs a decision: a typo
    // fix keeps them, a different question clears them.
    if ('question_text' in body && body.question_text !== gs.question_text) {
      const answers = await answersAtCurrent(gs.current_round, gs.current_question)
      if (answers && typeof body.reset_answers !== 'boolean')
        return reply.code(409).send({ error: 'Teams have already answered this question.', needs_reset: true, answers })
      if (answers && body.reset_answers === true)
        await clearAnswersAtCurrent(gs.current_round, gs.current_question)
    }

    const sets = keys.map((k, i) => `${k} = $${i + 1}`)
    // Opening starts the countdown and puts the question up; closing stops it.
    if (body.submissions_open === true) {
      sets.push('question_shown = true')
      sets.push(`deadline = CASE WHEN timer_seconds > 0
                 THEN now() + timer_seconds * interval '1 second' END`)
    }
    if (body.submissions_open === false) sets.push('deadline = NULL')
    if (body.revealed === true) sets.push('question_shown = true')

    await q(
      `UPDATE game_state SET ${sets.join(', ')}, updated_at = now() WHERE id = 1`,
      keys.map((k) => body[k]),
    )
    await broadcast()
    return { ok: true, state: await publicState() }
  })

  // The host needs answer_text to grade, which publicState() deliberately
  // withholds from teams until reveal. This is the host's full view.
  scope.get('/api/admin/state', async (req, reply) => {
    if (!(await isHost(req, reply))) return reply
    const gs = await getGameState()
    const kind = kindOf(gs.current_round, gs.current_question)
    return {
      ...gs,
      live_scores: await liveScores(),
      tied_teams: kind === 'final' || kind === 'tiebreaker' ? await tiedForFirst() : [],
    }
  })

  scope.get('/api/admin/submissions', async (req, reply) => {
    if (!(await isHost(req, reply))) return reply
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
    if (!(await isHost(req, reply))) return reply

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
    if (!(await isHost(req, reply))) return reply
    return questionIndex()
  })

  // Pull any question from the bank into the live game, e.g. a backup. Next and
  // Back go by position, so the game picks up where it left off afterwards.
  scope.post<{ Body: { q_number?: number; reset_answers?: boolean } }>(
    '/api/admin/load-question', async (req, reply) => {
      if (!(await isHost(req, reply))) return reply

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
      if (n === TIEBREAK_BANK && kind !== 'tiebreaker')
        return reply.code(409).send({ error: 'Move to the tiebreaker before loading it.' })

      // Answers given to the old question would be graded against the new one.
      const answers = await answersAtCurrent(gs.current_round, gs.current_question)
      if (answers && req.body?.reset_answers !== true)
        return reply.code(409).send({ error: 'Question not changed: teams have already answered it.', needs_reset: true, answers })
      if (answers) await clearAnswersAtCurrent(gs.current_round, gs.current_question)

      await q(
        `UPDATE game_state
         SET question_text = $1, answer_text = $2, note_text = $3, submissions_open = false,
             revealed = false, question_shown = false, deadline = NULL, updated_at = now()
         WHERE id = 1`,
        [liveText(row), row.answer, row.note ?? ''],
      )
      await broadcast()
      return { ok: true, loaded: n }
    })

  scope.post<{ Body: { id?: number; correct?: boolean; correct_parts?: number; awarded_points?: number } }>(
    '/api/admin/grade', async (req, reply) => {
      if (!(await isHost(req, reply))) return reply

      const id = req.body?.id
      if (!id) return reply.code(400).send({ error: 'id is required.' })

      const sub = (await q('SELECT * FROM submissions WHERE id = $1', [id]))[0]
      if (!sub) return reply.code(404).send({ error: 'That answer no longer exists.' })

      const score = scoreFor(sub, req.body)
      if ('error' in score) return reply.code(400).send({ error: score.error })

      await saveGrade(id, score)
      await broadcast()   // the team's phone hears its result
      return { ok: true }
    })

  // One tap for every team that gave the same answer.
  scope.post<{ Body: { ids?: number[]; correct?: boolean } }>(
    '/api/admin/grade-group', async (req, reply) => {
      if (!(await isHost(req, reply))) return reply

      const { ids, correct } = req.body ?? {}
      if (!Array.isArray(ids) || !ids.length || typeof correct !== 'boolean')
        return reply.code(400).send({ error: 'ids and correct are required.' })

      const subs = await q('SELECT * FROM submissions WHERE id = ANY($1::int[])', [ids])
      for (const sub of subs) {
        const score = scoreFor(sub, { correct })
        if ('error' in score) return reply.code(400).send({ error: score.error })
        await saveGrade(sub.id, score)
      }
      await broadcast()
      return { ok: true, graded: subs.length }
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
