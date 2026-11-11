import { useEffect, useRef, useState } from 'react'
import { api } from './live.js'

// Question bank: bulk CSV upload, the index, and loading one into the live game.
export function Bank({ token, position }) {
  const [questions, setQuestions] = useState([])
  const [errors, setErrors] = useState([])
  const [loadErr, setLoadErr] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [pick, setPick] = useState(position)
  const [open, setOpen] = useState(false)
  const file = useRef(null)

  // Halftime and the final have no position, so the box keeps its last number.
  useEffect(() => { if (position) setPick(position) }, [position])

  useEffect(() => {
    api('/api/admin/questions', { token })
      .then(setQuestions)
      .catch((e) => setErrors([e.message]))
  }, [token])

  const upload = async (e) => {
    const f = e.target.files?.[0]
    if (!f) return
    setBusy(true); setErrors([]); setLoadErr(''); setMsg('')
    try {
      const text = await f.text()
      const r = await api('/api/admin/questions', { method: 'POST', token, body: { csv: text } })
      setQuestions(r.questions)
      setMsg(`Imported ${r.imported} question${r.imported === 1 ? '' : 's'} from ${f.name}.`)
    } catch (err) {
      // The server sends a list for row-level problems, one string otherwise.
      setErrors(err.rows ?? [err.message])
    } finally {
      setBusy(false)
      if (file.current) file.current.value = ''   // let the same file be retried
    }
  }

  const load = async (n, label = `question ${n}`, reset = false) => {
    setErrors([]); setLoadErr(''); setMsg('')
    try {
      await api('/api/admin/load-question', { method: 'POST', token, body: { q_number: n, reset_answers: reset } })
      setMsg(`Loaded ${label}${reset ? ' and cleared the earlier answers' : ''}. Submissions are closed.`)
    } catch (e) {
      if (e.data?.needs_reset && window.confirm(
        `${e.data.answers} team(s) already answered this question. Swap it and clear their answers?`,
      )) return load(n, label, true)
      setLoadErr(e.message)
    }
  }

  // Halftime and the final are stored under reserved negative numbers.
  const specials = [
    { n: -1, label: 'Halftime' },
    { n: -2, label: 'Final question' },
    { n: -3, label: 'Tiebreaker' },
  ].filter((s) => questions.some((r) => r.q_number === s.n))
  const numbered = questions.filter((r) => r.q_number > 0)

  // app.py grouped the index in blocks of three; keeping that, it maps to rounds.
  const blocks = []
  if (numbered.length) {
    const nums = numbered.map((r) => r.q_number)
    const start = Math.min(...nums) - ((Math.min(...nums) - 1) % 3)
    for (let s = start; s <= Math.max(...nums); s += 3) {
      const block = numbered.filter((r) => r.q_number >= s && r.q_number <= s + 2)
      if (block.length) blocks.push({ label: `${s}–${s + 2}`, block })
    }
  }

  return (
    <div className="bank">
      <h3>
        Question bank
        {questions.length > 0 && <span className="pill">{questions.length} loaded</span>}
      </h3>

      <label className="ghost upload">
        {busy ? 'Importing…' : '📄 Upload CSV'}
        <input
          ref={file} type="file" accept=".csv,text/csv" onChange={upload} disabled={busy} hidden
        />
      </label>
      <p className="muted">
        Columns: <strong>Number, Category, Question, Answer</strong>, and optionally Note.
        Order and capitalisation do not matter. Re-uploading updates questions with
        the same Number. In Excel, save as CSV first.
      </p>
      <p className="muted">
        Number 1–18 in play order, with backups from 19 up. Use <strong>Halftime</strong>,
        {' '}<strong>Tiebreaker</strong> or
        {' '}<strong>Final</strong> as the Number for those three, and list the halftime answers
        in order with semicolons: A; B; C; D.
      </p>

      {questions.length > 0 && !questions.some((r) => r.q_number === -3) && (
        <p className="err">No tiebreaker is loaded. Add a row with Number "Tiebreaker" before the game.</p>
      )}
      {msg && <p className="ok">{msg}</p>}
      {loadErr && <p className="err">{loadErr}</p>}
      {errors.length > 0 && (
        <div className="errbox">
          <p className="err"><strong>Nothing was imported.</strong></p>
          <ul>{errors.slice(0, 15).map((e, i) => <li key={i} className="err">{e}</li>)}</ul>
          {errors.length > 15 && <p className="muted">…and {errors.length - 15} more.</p>}
        </div>
      )}

      {questions.length > 0 && (
        <>
          <div className="row">
            <input
              type="number" min="1" value={pick} style={{ width: 90, margin: 0 }}
              onChange={(e) => setPick(Number(e.target.value))}
            />
            <button className="ghost" style={{ margin: 0, flex: 1 }} onClick={() => load(pick)}>
              Load #{pick} into game
            </button>
          </div>

          <button className="link" onClick={() => setOpen(!open)}>
            {open ? '▾ Hide index' : '▸ Show index'}
          </button>

          {open && (
            <div className="index">
              {specials.length > 0 && (
                <div className="blk">
                  <strong>Halftime, final and tiebreaker</strong>
                  {specials.map((s) => (
                    <button key={s.n} className="qrow" onClick={() => load(s.n, s.label)}>
                      {s.label}
                    </button>
                  ))}
                </div>
              )}
              {blocks.map(({ label, block }) => (
                <div className="blk" key={label}>
                  <strong>{label}</strong>
                  {block.map((r) => (
                    <button key={r.q_number} className="qrow" onClick={() => load(r.q_number)}>
                      <span className="pill">{r.q_number}</span> {r.category}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
