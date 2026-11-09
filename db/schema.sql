-- Pub Trivia schema — Postgres 17
-- Ported from the SQLite schema in app.py (init_db).
-- Differences from SQLite, all deliberate:
--   * TEXT timestamps    -> timestamptz
--   * INTEGER 0/1 flags  -> boolean
--   * team deletion      -> ON DELETE CASCADE (was a manual two-step in admin_delete_team)
--   * new: sessions      -> token auth, so a phone that sleeps stays logged in
--   * new: wager CHECK   -> encodes allowed_wagers(half) at the DB level

BEGIN;

CREATE TABLE IF NOT EXISTS teams (
    id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    team_name   text        NOT NULL UNIQUE,
    pass_hash   text        NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- Singleton: exactly one row, id = 1.
CREATE TABLE IF NOT EXISTS game_state (
    id               integer     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    current_round    integer     NOT NULL DEFAULT 1 CHECK (current_round >= 1),
    current_question integer     NOT NULL DEFAULT 1 CHECK (current_question >= 1),
    half             integer     NOT NULL DEFAULT 1 CHECK (half IN (1, 2)),
    question_text    text        NOT NULL DEFAULT '',
    answer_text      text        NOT NULL DEFAULT '',
    submissions_open boolean     NOT NULL DEFAULT false,
    revealed         boolean     NOT NULL DEFAULT false,
    allow_new_teams  boolean     NOT NULL DEFAULT true,
    updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS submissions (
    id               integer     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    team_id          integer     NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    round_num        integer     NOT NULL,
    question_num     integer     NOT NULL,
    half             integer     NOT NULL CHECK (half IN (1, 2)),
    submitted_answer text        NOT NULL,
    wager_points     integer     NOT NULL,
    submitted_at     timestamptz NOT NULL DEFAULT now(),
    is_correct       boolean,                      -- NULL = ungraded
    awarded_points   integer     NOT NULL DEFAULT 0,
    graded_at        timestamptz,
    UNIQUE (team_id, round_num, question_num),
    -- allowed_wagers(): half 1 -> 1/3/5, half 2 -> 2/4/6
    CONSTRAINT wager_valid_for_half CHECK (
        (half = 1 AND wager_points IN (1, 3, 5)) OR
        (half = 2 AND wager_points IN (2, 4, 6))
    )
);

-- Host grading screen reads this constantly; leaderboard aggregates by team.
CREATE INDEX IF NOT EXISTS submissions_current_idx ON submissions (round_num, question_num);
CREATE INDEX IF NOT EXISTS submissions_team_idx    ON submissions (team_id);

CREATE TABLE IF NOT EXISTS question_bank (
    id       integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    q_number integer NOT NULL UNIQUE,
    category text    NOT NULL,
    question text    NOT NULL,
    answer   text    NOT NULL,
    note     text
);

-- Replaces st.session_state. A token lives in the phone's localStorage, so
-- locking the screen or dropping wifi no longer logs a team out mid-round.
CREATE TABLE IF NOT EXISTS sessions (
    token      text        PRIMARY KEY,
    team_id    integer     REFERENCES teams(id) ON DELETE CASCADE,
    is_admin   boolean     NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen  timestamptz NOT NULL DEFAULT now(),
    -- a session is either a team or the host, never both and never neither
    CONSTRAINT session_subject CHECK (
        (is_admin AND team_id IS NULL) OR (NOT is_admin AND team_id IS NOT NULL)
    )
);

INSERT INTO game_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Halftime and the final. Both sit at question 4 of a round: halftime is round 3
-- question 4, the final is round 6 question 4.
--   * final_max_wager -> the most a team can bet on the final, set by the host
--   * correct_parts   -> halftime only: how many answers were in the right spot
ALTER TABLE game_state  ADD COLUMN IF NOT EXISTS final_max_wager integer NOT NULL DEFAULT 15
    CHECK (final_max_wager >= 0);
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS correct_parts integer
    CHECK (correct_parts >= 0);

-- The half's wager values only apply to questions 1-3. Halftime stores 0, and the
-- final stores the team's bet, which the API limits to what the team has banked.
ALTER TABLE submissions DROP CONSTRAINT IF EXISTS wager_valid_for_half;
ALTER TABLE submissions ADD CONSTRAINT wager_valid_for_half CHECK (
    wager_points >= 0 AND (
        question_num = 4 OR
        (half = 1 AND wager_points IN (1, 3, 5)) OR
        (half = 2 AND wager_points IN (2, 4, 6))
    )
);

-- Each wager value can be used once per round. They come back the next round.
CREATE UNIQUE INDEX IF NOT EXISTS submissions_one_wager_per_round
    ON submissions (team_id, round_num, wager_points) WHERE question_num <= 3;

COMMIT;
