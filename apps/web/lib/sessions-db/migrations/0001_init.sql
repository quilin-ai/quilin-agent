-- Quilin Web session persistence — initial schema.
-- Spec: docs/09-deployment-runtime/web-session-persistence-spec.md §3.
-- Foreign keys + WAL must be PRAGMA'd at connection time, not here.

CREATE TABLE IF NOT EXISTS sessions (
    id            TEXT PRIMARY KEY,
    title         TEXT,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    origin        TEXT NOT NULL DEFAULT 'web',
    epoch         INTEGER NOT NULL DEFAULT 0,
    deleted_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_deleted_at ON sessions(deleted_at)
    WHERE deleted_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS messages (
    id            TEXT PRIMARY KEY,
    session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq           INTEGER NOT NULL,
    role          TEXT NOT NULL,
    parts_json    TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    finalized_at  INTEGER,
    UNIQUE(session_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, seq);
