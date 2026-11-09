import { useEffect, useRef, useState } from 'react'
import { api } from './live.js'

const points = (n) => `${n} point${Math.abs(n) === 1 ? '' : 's'}`

// One question on a team's phone. App keys this by position, so a new question
// starts with a clean form.
export function TeamQuestion({ state, auth, onSignedOut }) {
  const [answer, setAnswer] = useState('')
  const [parts, setParts] = useState([])
  const [wager, setWager] = useState(null)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  // This team's saved answer, banked points and spent wagers, from the server.
  const [me, setMe] = useState(null)
  const hadAnswer = useRef(false)

  // Re-read on every push: that is how a grade reaches this screen, and how a
  // phone finds out its team was removed.
  useEffect(() => {
    let live = true
    api('/api/team/me', { token: auth.token })
      .then((r) => {
        if (!live) return
        const saved = r.submission
        if (saved && !hadAnswer.current) {
          // First sight of a saved answer, e.g. after a reload: show it.
          setAnswer(saved.submitted_answer)
          setParts(saved.submitted_answer.split('\n'))
          setWager(saved.wager_points)
        } else if (!saved && hadAnswer.current) {
          // The host started a new game on this same question number.
          setAnswer(''); setParts([]); setWager(null); setMsg('')
        }
        hadAnswer.current = Boolean(saved)
        setMe(r)
      })
      .catch((e) => {
        if (!live) return
        if (e.status === 401) onSignedOut()
      })
    return () => { live = false }
  }, [state, auth.token])

  const submit = async (e) => {
    e.preventDefault()
    setErr(''); setMsg('')
    try {
      const body = state.kind === 'halftime'
        ? { parts: boxes }
        : { answer, wager: Number(wager) }
      await api('/api/submit', { method: 'POST', token: auth.token, body })
      setMsg('Answer locked in. You can change it until the host grades it.')
    } catch (e) { setErr(e.message) }
  }

  const mine = me?.submission ?? null
  const graded = mine && mine.is_correct !== null
  const boxes = Array.from({ length: state.parts }, (_, i) => parts[i] ?? '')

  const ready =
    state.kind === 'halftime' ? boxes.some((b) => b.trim())
    : state.kind === 'final' ? answer.trim() && wager !== null && wager !== ''
    : answer.trim() && wager

  return (
    <>
      {state.kind !== 'regular' && <p className="stage">{state.label}</p>}
      {state.question_text && <p className="question">{state.question_text}</p>}

      {state.revealed && state.answer_text && <Official state={state} />}

      {graded ? (
        <Result kind={state.kind} mine={mine} />
      ) : state.submissions_open && me ? (
        <form onSubmit={submit}>
          {state.kind === 'halftime' ? (
            <>
              <p className="muted">Worth {state.points_per_part} points for each answer in the right spot.</p>
              {boxes.map((value, i) => (
                <div className="spot" key={i}>
                  <span>{i + 1}.</span>
                  <input
                    placeholder={`Spot ${i + 1}`} value={value} autoComplete="off"
                    onChange={(e) => {
                      const next = [...boxes]
                      next[i] = e.target.value
                      setParts(next)
                    }}
                  />
                </div>
              ))}
            </>
          ) : (
            <input
              placeholder="Your answer" value={answer} autoComplete="off"
              onChange={(e) => setAnswer(e.target.value)} required
            />
          )}

          {state.kind === 'final' && (
            <>
              <p className="muted">
                You have {points(me.banked)}. Bet from 0 to {me.max_bet}. Get it right and
                you win your bet. Get it wrong and you lose it.
              </p>
              <input
                type="number" inputMode="numeric" min="0" max={me.max_bet} placeholder="Your bet"
                value={wager ?? ''} onChange={(e) => setWager(e.target.value)} required
              />
            </>
          )}

          {state.kind === 'regular' && (
            <>
              <p className="muted">Wager (each one once per round)</p>
              <div className="wagers">
                {state.wagers.map((w) => (
                  <button
                    key={w} type="button"
                    disabled={me.used_wagers.includes(w)}
                    className={wager === w ? 'wager on' : 'wager'}
                    onClick={() => setWager(w)}
                  >{w}</button>
                ))}
              </div>
            </>
          )}

          {err && <p className="err">{err}</p>}
          {msg && <p className="ok">{msg}</p>}
          <button className="big" disabled={!ready}>{mine ? 'Update answer' : 'Submit'}</button>
        </form>
      ) : mine ? (
        <Waiting kind={state.kind} mine={mine} />
      ) : (
        <p className="closed">⛔ Submissions are closed. Hang tight.</p>
      )}
    </>
  )
}

function Official({ state }) {
  if (state.kind !== 'halftime') {
    return <p className="reveal">✅ Official answer: <strong>{state.answer_text}</strong></p>
  }
  return (
    <div className="reveal">
      ✅ Official order:
      <ol>{state.answer_text.split(';').map((a, i) => <li key={i}>{a.trim()}</li>)}</ol>
    </div>
  )
}

function Result({ kind, mine }) {
  if (kind === 'halftime') {
    const spots = mine.submitted_answer.split('\n').length
    return (
      <p className={mine.correct_parts > 0 ? 'ok' : 'err'}>
        You got {mine.correct_parts} of {spots} in the right spot, for {points(mine.awarded_points)}.
      </p>
    )
  }
  if (kind === 'final') {
    return (
      <p className={mine.is_correct ? 'ok' : 'err'}>
        {mine.is_correct ? '✅ Correct' : '❌ Not this time'}: you said "{mine.submitted_answer}"
        {' '}and {mine.is_correct ? 'won' : 'lost'} {points(mine.wager_points)}.
      </p>
    )
  }
  return (
    <p className={mine.is_correct ? 'ok' : 'err'}>
      {mine.is_correct ? '✅ Correct' : '❌ Not this time'}: you said "{mine.submitted_answer}"
      {' '}for {mine.wager_points}, and got {points(mine.awarded_points)}.
    </p>
  )
}

function Waiting({ kind, mine }) {
  if (kind === 'halftime') {
    return (
      <div className="closed">
        Your order:
        <ol className="yours">
          {mine.submitted_answer.split('\n').map((a, i) => <li key={i}>{a || '(blank)'}</li>)}
        </ol>
        Waiting on the host.
      </div>
    )
  }
  const label = kind === 'final' ? 'with a bet of' : 'for'
  return (
    <p className="closed">Your answer: "{mine.submitted_answer}" {label} {mine.wager_points}. Waiting on the host.</p>
  )
}
