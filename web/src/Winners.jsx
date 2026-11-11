// Shown on phones and the room display once the host triggers it.
export function Winners({ state }) {
  const tied = state.winners.length > 1
  return (
    <section className="card winners">
      <p className="trophy">🏆</p>
      <h2>{tied ? "It's a tie!" : 'Winner'}</h2>
      <p className="champ">{state.winners.join(' & ')}</p>
      <ol className="scores">
        {state.scores.map((s) => (
          <li key={s.team_name}><span>{s.team_name}</span><strong>{s.score}</strong></li>
        ))}
      </ol>
    </section>
  )
}
