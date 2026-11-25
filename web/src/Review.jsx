import { useEffect, useState } from 'react'
import { api } from './live.js'

const HALFTIME = -1
const FINAL = -2
const TIEBREAK = -3

// Four lists: tonight's lineup, then backups by how hard they are, so a swap can
// match the room. Untagged backups get a fifth list, shown only if there are any.
const BUCKETS = [
  { key: 'active', label: 'Active questions' },
  { key: 'easy', label: 'Easy' },
  { key: 'intermediate', label: 'Intermediate' },
  { key: 'hard', label: 'Hard' },
  { key: 'other', label: 'Other backups' },
]
const LEVEL_KEYS = ['easy', 'intermediate', 'hard']
const bucketOf = (row) => (LEVEL_KEYS.includes(row.difficulty) ? row.difficulty : 'other')

// Every question, sorted into the lists. The lineup follows the host's rounds
// setting: each round's three questions, halftime after the first half, then
// the final and the tiebreaker.
function sortIntoBuckets(state, questions) {
  const byNumber = new Map(questions.map((r) => [r.q_number, r]))
  const active = []
  const rounds = state.rounds_half1 + state.rounds_half2
  for (let round = 1, n = 1; round <= rounds; round++) {
    for (let question = 1; question <= 3; question++, n++)
      active.push({ n, label: `Round ${round} · Q${question}`, row: byNumber.get(n) })
    if (round === state.rounds_half1) active.push({ n: HALFTIME, label: 'Halftime', row: byNumber.get(HALFTIME) })
  }
  active.push({ n: FINAL, label: 'Final question', row: byNumber.get(FINAL) })
  active.push({ n: TIEBREAK, label: 'Tiebreaker', row: byNumber.get(TIEBREAK) })

  const lists = { active, easy: [], intermediate: [], hard: [], other: [] }
  for (const r of questions) {
    if (r.q_number > state.regular_count)
      lists[bucketOf(r)].push({ n: r.q_number, label: `Backup #${r.q_number}`, row: r, backup: true })
  }
  return lists
}

// What a swap target says in the picker. The buttons wrap, so nothing is cut off.
const optionText = (slot) => slot.backup
  ? `${slot.row.category} - ${slot.row.question}`
  : `${slot.label}: ${slot.row ? slot.row.question : '(empty)'}`

const halftimeOk = (answer) => answer.split(';').map((p) => p.trim()).filter(Boolean).length >= 2

export function Review({ state, token, onChanged }) {
  const [open, setOpen] = useState(false)
  const [bucket, setBucket] = useState(null)
  const [questions, setQuestions] = useState([])
  const [current, setCurrent] = useState(null)
  const [editing, setEditing] = useState(null)   // a question number, or 'new'
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')

  const load = () => api('/api/admin/bank', { token })
    .then((r) => { setQuestions(r.questions); setCurrent(r.current) })
    .catch((e) => setErr(e.message))

  // Re-read when opened and whenever the game moves, so "in play" stays right.
  useEffect(() => { if (open) load() }, [open, state.round, state.question])

  const done = (text) => { setMsg(text); setErr(''); setEditing(null); load(); onChanged() }

  const save = async (n, fields) => {
    try {
      const r = await api(`/api/admin/bank/${n}`, { method: 'PUT', token, body: fields })
      done(r.live ? 'Saved, and updated on every screen.' : 'Saved.')
    } catch (e) { setErr(e.message) }
  }

  const remove = async (slot) => {
    if (!window.confirm(`Delete ${slot.label}? This cannot be undone.`)) return
    try {
      await api(`/api/admin/bank/${slot.n}`, { method: 'DELETE', token })
      done(`Deleted ${slot.label}.`)
    } catch (e) { setErr(e.message) }
  }

  const swap = async (a, b, reset = false) => {
    try {
      const r = await api('/api/admin/bank/swap', { method: 'POST', token, body: { a, b, reset_answers: reset } })
      done(`Swapped #${a} and #${b}.${r.live ? ' The question in play changed.' : ''}`)
    } catch (e) {
      if (e.data?.needs_reset && window.confirm(
        `${e.data.answers} team(s) already answered the question in play. Swap anyway and clear their answers?`,
      )) return swap(a, b, true)
      setErr(e.message)
    }
  }

  const lists = sortIntoBuckets(state, questions)
  const shown = BUCKETS.filter((b) => b.key !== 'other' || lists.other.length)
  const numbered = questions.filter((r) => r.q_number > 0).map((r) => r.q_number)
  const nextBackup = Math.max(state.regular_count, ...numbered) + 1

  const problems = []
  const empty = lists.active.filter((s) => !s.row).map((s) => s.label)
  if (empty.length) problems.push(`Nothing loaded for: ${empty.join(', ')}.`)
  const ht = questions.find((r) => r.q_number === HALFTIME)
  if (ht && !halftimeOk(ht.answer)) problems.push('The halftime answer needs its spots separated by semicolons.')

  const countText = (key) => key === 'active'
    ? `${state.regular_count} questions + halftime, final, tiebreaker`
    : `${lists[key].length} question${lists[key].length === 1 ? '' : 's'}`

  const openList = BUCKETS.find((b) => b.key === bucket)

  return (
    <div className="bank">
      <h3>Review questions</h3>
      <button className="link" onClick={() => { setOpen(!open); setBucket(null); setEditing(null) }}>
        {open ? '▾ Hide' : '▸ Review, edit or swap questions'}
      </button>

      {open && (
        <>
          {problems.length > 0
            ? <div className="errbox">{problems.map((p) => <p key={p} className="err">{p}</p>)}</div>
            : <p className="ok">All {state.regular_count} questions, halftime, final and tiebreaker are loaded.</p>}
          {err && <p className="err">{err}</p>}
          {msg && <p className="ok">{msg}</p>}

          {!openList ? (
            <div className="tiles">
              {shown.map((b) => (
                <button key={b.key} className={`tile tile-${b.key}`} onClick={() => { setBucket(b.key); setMsg(''); setEditing(null) }}>
                  <strong>{b.label}</strong>
                  <span>{countText(b.key)}</span>
                </button>
              ))}
            </div>
          ) : (
            <>
              <div className="list-head">
                <button className="link" onClick={() => { setBucket(null); setEditing(null) }}>← All lists</button>
                <strong className={`list-title tile-${openList.key}`}>{openList.label}</strong>
                <span className="muted">{countText(openList.key)}</span>
              </div>

              <ol className="lineup">
                {lists[openList.key].map((slot) => (
                  <SlotCard
                    key={slot.n} slot={slot} lists={lists} shown={shown}
                    inPlay={current === slot.n} editing={editing === slot.n}
                    onEdit={() => setEditing(slot.n)} onCancel={() => setEditing(null)}
                    onSave={(fields) => save(slot.n, fields)} onDelete={() => remove(slot)}
                    onSwap={(target) => swap(slot.n, target)}
                  />
                ))}

                {openList.key !== 'active' && (
                  <li>
                    {editing === 'new' ? (
                      <Editor
                        row={null} halftime={false} levels
                        defaultLevel={LEVEL_KEYS.includes(openList.key) ? openList.key : ''}
                        onSave={(fields) => save(nextBackup, fields)} onCancel={() => setEditing(null)}
                      />
                    ) : (
                      <button className="ghost" onClick={() => setEditing('new')}>
                        + Add {openList.key === 'other' ? 'a' : `an ${openList.label.toLowerCase()}`} backup (#{nextBackup})
                      </button>
                    )}
                  </li>
                )}
              </ol>
            </>
          )}
        </>
      )}
    </div>
  )
}

function SlotCard({ slot, lists, shown, inPlay, editing, onEdit, onCancel, onSave, onDelete, onSwap }) {
  return (
    <li className={inPlay ? 'in-play' : ''}>
      <div className="slot-head">
        <strong>{slot.label}</strong>
        {slot.n > 0 && !slot.backup && <span className="pill">#{slot.n}</span>}
        {inPlay && <span className="pill open">in play</span>}
        {slot.row && <span className="pill">{slot.row.category}</span>}
      </div>

      {editing ? (
        <Editor row={slot.row} halftime={slot.n === HALFTIME} levels={slot.n > 0} onSave={onSave} onCancel={onCancel} />
      ) : slot.row ? (
        <>
          <p className="slot-q">{slot.row.question}</p>
          <p className="slot-a">
            {slot.n === HALFTIME ? slot.row.answer.split(';').map((p) => p.trim()).join(' → ') : slot.row.answer}
          </p>
          {slot.row.note && <p className="muted">💡 {slot.row.note}</p>}
          <div className="row">
            <button onClick={onEdit}>Edit</button>
            <button onClick={onDelete}>Delete</button>
          </div>
          {slot.n > 0 && <SwapPicker slot={slot} lists={lists} shown={shown} onSwap={onSwap} />}
        </>
      ) : (
        <div className="row">
          <span className="err">Empty</span>
          <button onClick={onEdit}>Add a question here</button>
        </div>
      )}
    </li>
  )
}

// Two steps: pick one of the lists, then a question from just that list.
function SwapPicker({ slot, lists, shown, onSwap }) {
  const [step, setStep] = useState(null)   // null (closed), 'lists', or a list key

  // Anything with a number can trade places; halftime, final and tiebreaker cannot.
  const targets = (key) => lists[key].filter((s) => s.n > 0 && s.n !== slot.n)

  if (!step) return <button className="ghost swap-open" onClick={() => setStep('lists')}>Swap with…</button>

  if (step === 'lists') {
    return (
      <div className="picker">
        <p className="muted">Swap {slot.label} with a question from:</p>
        <div className="tiles small">
          {shown.filter((b) => targets(b.key).length).map((b) => (
            <button key={b.key} className={`tile tile-${b.key}`} onClick={() => setStep(b.key)}>
              <strong>{b.label}</strong><span>{targets(b.key).length}</span>
            </button>
          ))}
        </div>
        <button className="link" onClick={() => setStep(null)}>Cancel</button>
      </div>
    )
  }

  const list = shown.find((b) => b.key === step)
  return (
    <div className="picker">
      <div className="list-head">
        <button className="link" onClick={() => setStep('lists')}>← Lists</button>
        <strong className={`list-title tile-${list.key}`}>{list.label}</strong>
      </div>
      <ul className="choices">
        {targets(step).map((s) => (
          <li key={s.n}>
            <button onClick={() => { setStep(null); onSwap(s.n) }}>{optionText(s)}</button>
          </li>
        ))}
      </ul>
      <button className="link" onClick={() => setStep(null)}>Cancel</button>
    </div>
  )
}

function Editor({ row, halftime, levels, defaultLevel = '', onSave, onCancel }) {
  const [fields, setFields] = useState({
    category: row?.category ?? '', question: row?.question ?? '',
    answer: row?.answer ?? '', note: row?.note ?? '', difficulty: row ? (row.difficulty ?? '') : defaultLevel,
  })
  const set = (k) => (e) => setFields({ ...fields, [k]: e.target.value })

  return (
    <form className="editor" onSubmit={(e) => { e.preventDefault(); onSave(fields) }}>
      <input placeholder="Category" value={fields.category} onChange={set('category')} required />
      <textarea rows={3} placeholder="Question" value={fields.question} onChange={set('question')} required />
      <input
        placeholder={halftime ? 'Right order, separated by semicolons: A; B; C' : 'Answer (alternatives with /)'}
        value={fields.answer} onChange={set('answer')} required
      />
      <textarea rows={2} placeholder="Fun fact (optional)" value={fields.note} onChange={set('note')} />
      {levels && (
        <select value={fields.difficulty} onChange={set('difficulty')} aria-label="Difficulty">
          <option value="">No difficulty</option>
          <option value="easy">Easy</option>
          <option value="intermediate">Intermediate</option>
          <option value="hard">Hard</option>
        </select>
      )}
      <div className="row">
        <button type="submit" className="wager on">Save</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}
