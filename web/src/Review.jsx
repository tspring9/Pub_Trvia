import { useEffect, useState } from 'react'
import { api } from './live.js'

const HALFTIME = -1
const FINAL = -2
const TIEBREAK = -3

// The lineup in play order, from the host's rounds setting: each round's three
// numbered questions, halftime after the first half, then the final, the
// tiebreaker and any backups.
function lineup(state, questions) {
  const byNumber = new Map(questions.map((r) => [r.q_number, r]))
  const slots = []
  const rounds = state.rounds_half1 + state.rounds_half2
  for (let round = 1, n = 1; round <= rounds; round++) {
    for (let question = 1; question <= 3; question++, n++)
      slots.push({ n, label: `Round ${round} · Q${question}`, row: byNumber.get(n) })
    if (round === state.rounds_half1) slots.push({ n: HALFTIME, label: 'Halftime', row: byNumber.get(HALFTIME) })
  }
  slots.push({ n: FINAL, label: 'Final question', row: byNumber.get(FINAL) })
  slots.push({ n: TIEBREAK, label: 'Tiebreaker', row: byNumber.get(TIEBREAK) })
  const backups = questions.filter((r) => r.q_number > state.regular_count)
  for (const r of backups) slots.push({ n: r.q_number, label: `Backup #${r.q_number}`, row: r, backup: true })
  return slots
}

const halftimeOk = (answer) => answer.split(';').map((p) => p.trim()).filter(Boolean).length >= 2

export function Review({ state, token, onChanged }) {
  const [open, setOpen] = useState(false)
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

  const slots = lineup(state, questions)
  const numbered = questions.filter((r) => r.q_number > 0).map((r) => r.q_number)
  const nextBackup = Math.max(state.regular_count, ...numbered) + 1

  const problems = []
  const empty = slots.filter((s) => !s.row && !s.backup).map((s) => s.label)
  if (empty.length) problems.push(`Nothing loaded for: ${empty.join(', ')}.`)
  const ht = questions.find((r) => r.q_number === HALFTIME)
  if (ht && !halftimeOk(ht.answer)) problems.push('The halftime answer needs its spots separated by semicolons.')

  return (
    <div className="bank">
      <h3>Review questions</h3>
      <button className="link" onClick={() => setOpen(!open)}>
        {open ? '▾ Hide the lineup' : '▸ Show the full lineup to review, edit or swap'}
      </button>

      {open && (
        <>
          {problems.length > 0
            ? <div className="errbox">{problems.map((p) => <p key={p} className="err">{p}</p>)}</div>
            : <p className="ok">All {state.regular_count} questions, halftime, final and tiebreaker are loaded.</p>}
          {err && <p className="err">{err}</p>}
          {msg && <p className="ok">{msg}</p>}

          <ol className="lineup">
            {slots.map((slot) => (
              <li key={slot.n} className={current === slot.n ? 'in-play' : ''}>
                <div className="slot-head">
                  <strong>{slot.label}</strong>
                  {slot.n > 0 && !slot.backup && <span className="pill">#{slot.n}</span>}
                  {current === slot.n && <span className="pill open">in play</span>}
                  {slot.row && <span className="pill">{slot.row.category}</span>}
                </div>

                {editing === slot.n ? (
                  <Editor
                    row={slot.row} halftime={slot.n === HALFTIME}
                    onSave={(fields) => save(slot.n, fields)} onCancel={() => setEditing(null)}
                  />
                ) : slot.row ? (
                  <>
                    <p className="slot-q">{slot.row.question}</p>
                    <p className="slot-a">
                      {slot.n === HALFTIME ? slot.row.answer.split(';').map((p) => p.trim()).join(' → ') : slot.row.answer}
                    </p>
                    {slot.row.note && <p className="muted">💡 {slot.row.note}</p>}
                    <div className="row">
                      <button onClick={() => setEditing(slot.n)}>Edit</button>
                      {slot.n > 0 && (
                        <select
                          value="" aria-label={`Swap ${slot.label} with`}
                          onChange={(e) => e.target.value && swap(slot.n, Number(e.target.value))}
                        >
                          <option value="">Swap with…</option>
                          {slots.filter((s) => s.n > 0 && s.n !== slot.n).map((s) => (
                            <option key={s.n} value={s.n}>{s.label}{s.row ? `: ${s.row.question.slice(0, 40)}` : ' (empty)'}</option>
                          ))}
                        </select>
                      )}
                      <button onClick={() => remove(slot)}>Delete</button>
                    </div>
                  </>
                ) : (
                  <div className="row">
                    <span className="err">Empty</span>
                    <button onClick={() => setEditing(slot.n)}>Add a question here</button>
                  </div>
                )}
              </li>
            ))}

            <li>
              {editing === 'new' ? (
                <Editor row={null} halftime={false} onSave={(fields) => save(nextBackup, fields)} onCancel={() => setEditing(null)} />
              ) : (
                <button className="ghost" onClick={() => setEditing('new')}>+ Add a backup (#{nextBackup})</button>
              )}
            </li>
          </ol>
        </>
      )}
    </div>
  )
}

function Editor({ row, halftime, onSave, onCancel }) {
  const [fields, setFields] = useState({
    category: row?.category ?? '', question: row?.question ?? '',
    answer: row?.answer ?? '', note: row?.note ?? '',
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
      <div className="row">
        <button type="submit" className="wager on">Save</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}
