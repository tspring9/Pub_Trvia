import { Official } from './Team.jsx'
import { Timer } from './Timer.jsx'

// Watching on a phone, without a team: the same things the room TV shows.
export function Viewer({ state }) {
  if (state.show_standings) return (
    <section className="card">
      <p className="muted">👀 Watching</p>
      <h2>Standings</h2>
      <p className="muted">{state.scoreboard_label}</p>
      <Scores scores={state.scores} />
    </section>
  )

  if (!state.question_text) return (
    <section className="card">
      <p className="muted">👀 Watching</p>
      <p className="closed">Waiting for the next question…</p>
      {state.label && <p className="muted">Up next: {state.label}</p>}
    </section>
  )

  return (
    <section className="card">
      <p className="muted">👀 Watching · {state.label}</p>
      <p className="question">{state.question_text}</p>
      <Timer state={state} />
      {state.revealed && state.answer_text && <Official state={state} />}
      {state.note_text && <p className="note">💡 {state.note_text}</p>}
      {state.kind === 'tiebreaker' && (
        <p className="muted">Tiebreaker between {state.tiebreak_teams.join(' & ')}</p>
      )}
      {!state.revealed && (
        <p className="muted">
          {state.submissions_open
            ? `${state.answered} of ${state.kind === 'tiebreaker' ? state.tiebreak_teams.length : state.scores.length} teams answered`
            : 'Answers are locked'}
        </p>
      )}
    </section>
  )
}

export function Scores({ scores }) {
  if (!scores.length) return <p className="muted">No teams yet.</p>
  return (
    <ol className="scores">
      {scores.map((s) => (
        <li key={s.team_name}><span>{s.team_name}</span><strong>{s.score}</strong></li>
      ))}
    </ol>
  )
}
