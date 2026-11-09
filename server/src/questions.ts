import { q, partsOf, HALFTIME_BANK, FINAL_BANK } from './db.ts'

export type BankRow = {
  q_number: number
  category: string
  question: string
  answer: string
  note: string
}

// A real CSV parser, because question text contains commas ("Which city, in
// 1892, ...") and Excel quotes those fields. A naive split(',') mangles them.
// Handles quoted fields, "" escapes, and embedded newlines. CRLF or LF.
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let i = 0

  // Excel writes a UTF-8 BOM; it would otherwise end up inside the first header.
  if (text.charCodeAt(0) === 0xfeff) i = 1

  while (i < text.length) {
    const c = text[i]

    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue }
        quoted = false; i++; continue
      }
      field += c; i++; continue
    }

    if (c === '"') { quoted = true; i++; continue }
    if (c === ',') { row.push(field); field = ''; i++; continue }
    if (c === '\r') { i++; continue }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue }
    field += c; i++
  }

  // last line may lack a trailing newline
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''))
}

// What the Number column can say instead of a number.
const SPECIAL_NUMBERS: Record<string, number> = {
  h: HALFTIME_BANK, halftime: HALFTIME_BANK,
  f: FINAL_BANK, final: FINAL_BANK,
}

const CANON: Record<string, keyof BankRow> = {
  number: 'q_number', q: 'q_number', 'q number': 'q_number', '#': 'q_number',
  category: 'category', cat: 'category',
  question: 'question',
  answer: 'answer',
  note: 'note', notes: 'note',
}

export function parseQuestionCsv(text: string): { rows: BankRow[]; errors: string[] } {
  const errors: string[] = []

  // An .xlsx is a zip; its first bytes are "PK". Catch it here so the user gets
  // a useful message instead of a wall of parse errors.
  if (text.startsWith('PK')) {
    return { rows: [], errors: ['That looks like an .xlsx file. In Excel choose File > Save As > CSV, then upload that.'] }
  }

  const table = parseCsv(text)
  if (!table.length) return { rows: [], errors: ['That file is empty.'] }

  // app.py demanded the header be exactly "Number, Category, Question, Answer,
  // Note". That broke on reordered columns, different casing, or a missing Note.
  // Map by name instead, so only the required columns actually matter.
  const header = table[0].map((h) => h.trim().toLowerCase())
  const index = {} as Record<keyof BankRow, number>
  header.forEach((name, col) => {
    const key = CANON[name]
    if (key !== undefined && index[key] === undefined) index[key] = col
  })

  const missing = (['q_number', 'category', 'question', 'answer'] as const)
    .filter((k) => index[k] === undefined)
  if (missing.length) {
    const pretty = { q_number: 'Number', category: 'Category', question: 'Question', answer: 'Answer' }
    return {
      rows: [],
      errors: [
        `Missing required column(s): ${missing.map((m) => pretty[m]).join(', ')}.`,
        `Found: ${table[0].map((h) => h.trim()).filter(Boolean).join(', ') || '(nothing)'}.`,
        'Expected columns: Number, Category, Question, Answer, and optionally Note.',
      ],
    }
  }

  const cell = (r: string[], k: keyof BankRow) =>
    index[k] === undefined ? '' : (r[index[k]] ?? '').trim()

  const rows: BankRow[] = []
  const seen = new Map<number, number>()

  table.slice(1).forEach((r, n) => {
    const line = n + 2   // 1-based, and the header is line 1
    const rawNum = cell(r, 'q_number')
    const special = SPECIAL_NUMBERS[rawNum.toLowerCase()]
    const num = special ?? Number(rawNum)

    if (!rawNum) { errors.push(`Line ${line}: Number is blank.`); return }
    if (special === undefined && (!Number.isInteger(num) || num < 1)) {
      errors.push(`Line ${line}: Number must be a whole number 1 or greater, or Halftime or Final (got "${rawNum}").`)
      return
    }
    if (seen.has(num)) {
      errors.push(`Line ${line}: question ${rawNum} already appeared on line ${seen.get(num)}.`)
      return
    }

    const row = {
      q_number: num,
      category: cell(r, 'category'),
      question: cell(r, 'question'),
      answer: cell(r, 'answer'),
      note: cell(r, 'note'),
    }

    const blank = (['category', 'question', 'answer'] as const).filter((k) => !row[k])
    if (blank.length) {
      errors.push(`Line ${line} (question ${rawNum}): ${blank.join(', ')} cannot be blank.`)
      return
    }
    if (num === HALFTIME_BANK && !partsOf(row.answer).length) {
      errors.push(`Line ${line} (Halftime): list the answers in order, separated by semicolons.`)
      return
    }

    seen.set(num, line)
    rows.push(row)
  })

  return { rows, errors }
}

// All-or-nothing: a half-loaded question bank mid-game is worse than a rejected
// upload. app.py committed row by row.
export async function upsertQuestionBank(rows: BankRow[]): Promise<number> {
  if (!rows.length) return 0
  const client = await (await import('./db.ts')).pool.connect()
  try {
    await client.query('BEGIN')
    for (const r of rows) {
      await client.query(
        `INSERT INTO question_bank (q_number, category, question, answer, note)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (q_number) DO UPDATE SET
           category = excluded.category,
           question = excluded.question,
           answer   = excluded.answer,
           note     = excluded.note`,
        [r.q_number, r.category, r.question, r.answer, r.note || null],
      )
    }
    await client.query('COMMIT')
    return rows.length
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

export const questionIndex = () =>
  q<{ q_number: number; category: string }>(
    'SELECT q_number, category FROM question_bank ORDER BY q_number ASC',
  )

export const questionByNumber = (n: number) =>
  q('SELECT q_number, category, question, answer, note FROM question_bank WHERE q_number = $1', [n])
    .then((r) => r[0] ?? null)

// What teams see for a bank question, matching app.py's "[Category] Question".
export const liveText = (row: { category: string; question: string }) =>
  `[${row.category}] ${row.question}`
