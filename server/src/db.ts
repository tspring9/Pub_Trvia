import pg from 'pg'

// One pool, localhost only. Postgres is never exposed off this box;
// the sole public entry point is the Tailscale Funnel in front of Fastify.
export const pool = new pg.Pool({
  host: process.env.PGHOST ?? '127.0.0.1',
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? 'pubtrivia',
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE ?? 'pubtrivia_dev',
  max: 10,
})

export async function q<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool.query(sql, params)
  return res.rows as T[]
}

export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

export const allowedWagers = (half: number): number[] =>
  Number(half) === 1 ? [1, 3, 5] : [2, 4, 6]

// The game's shape: 6 rounds of 3, halftime after round 3, the final after round
// 6, and a tiebreaker only if first place is tied. Each step knows its bank number
// (round 2, question 1 is #4), which is what lets Next find its question even
// after the host swapped in a backup.
export type Kind = 'regular' | 'halftime' | 'final' | 'tiebreaker'
export type Step = { round: number; question: number; kind: Kind; bank: number }

const ROUNDS = 6
const QUESTIONS_PER_ROUND = 3
const LAST_ROUND_OF_HALF_1 = 3
const SPECIAL_QUESTION = QUESTIONS_PER_ROUND + 1

// These have no number in the CSV, so they get reserved ones.
export const HALFTIME_BANK = -1
export const FINAL_BANK = -2
export const TIEBREAK_BANK = -3
export const HALFTIME_POINTS_PER_ANSWER = 2
export const DEFAULT_FINAL_WAGER = 15
export const DEFAULT_TIMER_SECONDS = 180

export const STEPS: Step[] = []
for (let round = 1, bank = 1; round <= ROUNDS; round++) {
  for (let question = 1; question <= QUESTIONS_PER_ROUND; question++) {
    STEPS.push({ round, question, kind: 'regular', bank: bank++ })
  }
  if (round === LAST_ROUND_OF_HALF_1)
    STEPS.push({ round, question: SPECIAL_QUESTION, kind: 'halftime', bank: HALFTIME_BANK })
  if (round === ROUNDS) {
    STEPS.push({ round, question: SPECIAL_QUESTION, kind: 'final', bank: FINAL_BANK })
    STEPS.push({ round, question: SPECIAL_QUESTION + 1, kind: 'tiebreaker', bank: TIEBREAK_BANK })
  }
}

export const stepIndexOf = (round: number, question: number): number =>
  STEPS.findIndex((s) => s.round === round && s.question === question)

export const kindOf = (round: number, question: number): Kind =>
  STEPS[stepIndexOf(round, question)]?.kind ?? 'regular'

export const labelOf = (s: { round: number; question: number; kind: Kind }): string =>
  s.kind === 'halftime' ? 'Halftime'
    : s.kind === 'final' ? 'Final question'
    : s.kind === 'tiebreaker' ? 'Tiebreaker'
    : `Round ${s.round} · Question ${s.question}`

export const halfForRound = (round: number): number =>
  round > LAST_ROUND_OF_HALF_1 ? 2 : 1

// The last question of a round, and halftime, are where the scoreboard updates.
export const stageEndLabel = (round: number, question: number): string | null => {
  const kind = kindOf(round, question)
  if (kind === 'halftime') return 'After halftime'
  if (kind === 'regular' && question === QUESTIONS_PER_ROUND) return `After Round ${round}`
  return null
}

// A halftime answer is its spots in order, separated by semicolons. Fewer than
// two means the host has not set one up yet.
export const partsOf = (answer: string): string[] => {
  const parts = answer.split(';').map((p) => p.trim()).filter(Boolean)
  return parts.length >= 2 ? parts : []
}

// Everything the team has earned so far, leaving out the question being answered.
export const bankedPoints = async (teamId: number, round: number, question: number): Promise<number> =>
  (await q<{ banked: number }>(
    `SELECT COALESCE(SUM(awarded_points), 0)::int AS banked FROM submissions
     WHERE team_id = $1 AND NOT (round_num = $2 AND question_num = $3)`,
    [teamId, round, question],
  ))[0].banked

// Wagers the team spent on the round's other questions.
export const usedWagers = async (teamId: number, round: number, question: number): Promise<number[]> =>
  (await q<{ wager_points: number }>(
    `SELECT wager_points FROM submissions
     WHERE team_id = $1 AND round_num = $2 AND question_num <> $3 AND question_num <= $4`,
    [teamId, round, question, QUESTIONS_PER_ROUND],
  )).map((r) => r.wager_points)

export type GameState = {
  current_round: number
  current_question: number
  half: number
  question_text: string
  answer_text: string
  submissions_open: boolean
  revealed: boolean
  allow_new_teams: boolean
  final_max_wager: number
  question_shown: boolean
  note_text: string
  timer_seconds: number
  deadline: Date | null
  show_winners: boolean
  scoreboard_label: string
  tiebreak_winner: number | null
}

export const getGameState = async (): Promise<GameState> =>
  (await q<GameState>('SELECT * FROM game_state WHERE id = 1'))[0]

// The real totals. Only the host sees these during the game.
export const liveScores = () =>
  q<{ id: number; team_name: string; score: number }>(`
    SELECT t.id, t.team_name, COALESCE(SUM(s.awarded_points), 0)::int AS score
    FROM teams t
    LEFT JOIN submissions s ON s.team_id = t.id
    GROUP BY t.id, t.team_name
    ORDER BY score DESC, t.team_name ASC
  `)

// The teams level on the top score. Empty when first place is not tied.
export const tiedForFirst = async () => {
  const scores = await liveScores()
  const top = scores.filter((t) => t.score === scores[0].score)
  return scores.length && top.length > 1 ? top : []
}

// Copies the live totals to what the room can see.
export async function publishScores(label: string) {
  await tx(async (client) => {
    await client.query(`
      UPDATE teams t SET published_score = COALESCE(
        (SELECT SUM(s.awarded_points) FROM submissions s WHERE s.team_id = t.id), 0)
    `)
    await client.query('UPDATE game_state SET scoreboard_label = $1 WHERE id = 1', [label])
  })
}

// What a *team* is allowed to see. answer_text is withheld until the host
// reveals it — the reason this project does not need row-level security:
// the browser never talks to Postgres, only to this function's output.
// question_text is withheld until the host opens it, because Next loads the
// upcoming question from the bank ahead of time. Scores are the published ones.
export async function publicState() {
  const gs = await getGameState()
  const round = gs.current_round
  const question = gs.current_question
  const index = stepIndexOf(round, question)
  const kind = kindOf(round, question)

  // A tiebreak winner sorts ahead of the teams level with them.
  const ranked = await q<{ id: number; team_name: string; score: number }>(
    `SELECT id, team_name, published_score AS score FROM teams
     ORDER BY published_score DESC, (id = $1) DESC NULLS LAST, team_name ASC`,
    [gs.tiebreak_winner],
  )
  const scores = ranked.map(({ team_name, score }) => ({ team_name, score }))
  const top = ranked.filter((t) => t.score === ranked[0].score)
  const decided = top.find((t) => t.id === gs.tiebreak_winner)
  const winners = (decided ? [decided] : top).map((t) => t.team_name)

  const answered = (await q<{ n: number }>(
    'SELECT count(*)::int AS n FROM submissions WHERE round_num = $1 AND question_num = $2',
    [round, question],
  ))[0].n

  return {
    round,
    question,
    kind,
    label: labelOf({ round, question, kind }),
    // Bank number for a regular question; null for the special ones.
    position: kind === 'regular' && index >= 0 ? STEPS[index].bank : null,
    step: index + 1,
    half: gs.half,
    wagers: kind === 'regular' ? allowedWagers(gs.half) : [],
    // How many boxes to show. Reveals the count only, never the answers.
    parts: kind === 'halftime' ? partsOf(gs.answer_text).length : 0,
    points_per_part: HALFTIME_POINTS_PER_ANSWER,
    final_max_wager: gs.final_max_wager,
    timer_seconds: gs.timer_seconds,
    seconds_left: gs.submissions_open && gs.deadline
      ? Math.max(0, Math.ceil((new Date(gs.deadline).getTime() - Date.now()) / 1000))
      : null,
    question_text: gs.question_shown || gs.submissions_open || gs.revealed ? gs.question_text : '',
    answer_text: gs.revealed ? gs.answer_text : null,
    note_text: gs.revealed ? gs.note_text : '',
    submissions_open: gs.submissions_open,
    revealed: gs.revealed,
    allow_new_teams: gs.allow_new_teams,
    answered,
    stage_end: stageEndLabel(round, question) !== null,
    tiebreak_teams: kind === 'tiebreaker' ? (await tiedForFirst()).map((t) => t.team_name) : [],
    show_winners: gs.show_winners,
    winners: gs.show_winners ? winners : [],
    scoreboard_label: gs.scoreboard_label,
    scores,
  }
}
