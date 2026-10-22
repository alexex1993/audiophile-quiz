CREATE TABLE users (
    id            BIGSERIAL PRIMARY KEY,
    google_sub    TEXT NOT NULL UNIQUE,       -- stable Google account ID ("sub" claim)
    email         TEXT NOT NULL,
    name          TEXT NOT NULL DEFAULT '',
    picture       TEXT NOT NULL DEFAULT '',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
    token_hash BYTEA PRIMARY KEY,             -- sha256 of the cookie value
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

CREATE TABLE tracks (
    id              BIGSERIAL PRIMARY KEY,
    artist          TEXT NOT NULL DEFAULT '',
    title           TEXT NOT NULL,
    source_filename TEXT NOT NULL,
    source_codec    TEXT NOT NULL,
    start_seconds   DOUBLE PRECISION NOT NULL,
    clip_seconds    INT NOT NULL,
    sample_rate     INT NOT NULL,
    channels        INT NOT NULL,
    bit_depth       INT NOT NULL,
    pcm_codec       TEXT NOT NULL,
    aac_bitrate     TEXT NOT NULL,
    storage_dir     TEXT NOT NULL,            -- relative to DATA_DIR
    file_size       BIGINT NOT NULL,          -- identical for both WAVs
    active          BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE attempts (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ,
    score       INT,
    total       INT NOT NULL
);
CREATE INDEX attempts_user_started_idx ON attempts (user_id, started_at DESC);

-- kind_a / kind_b: 'lossless' or 'aac'.
-- Answers: 1 = first lossless, 2 = second lossless, 3 = both lossless, 4 = both compressed.
CREATE TABLE attempt_questions (
    id             BIGSERIAL PRIMARY KEY,
    attempt_id     BIGINT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
    position       INT NOT NULL,
    track_id       BIGINT REFERENCES tracks(id) ON DELETE SET NULL,
    track_artist   TEXT NOT NULL,
    track_title    TEXT NOT NULL,
    kind_a         TEXT NOT NULL CHECK (kind_a IN ('lossless', 'aac')),
    kind_b         TEXT NOT NULL CHECK (kind_b IN ('lossless', 'aac')),
    correct_answer SMALLINT NOT NULL CHECK (correct_answer BETWEEN 1 AND 4),
    user_answer    SMALLINT CHECK (user_answer BETWEEN 1 AND 4),
    answered_at    TIMESTAMPTZ,
    token_a        TEXT NOT NULL UNIQUE,      -- opaque audio URLs, so the file kind can't be read from the URL
    token_b        TEXT NOT NULL UNIQUE,
    UNIQUE (attempt_id, position)
);
