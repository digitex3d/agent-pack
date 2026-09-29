CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS agents (
  id    SERIAL PRIMARY KEY,
  name  VARCHAR(128) NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS memories (
  id          SERIAL PRIMARY KEY,
  agent_id    INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  snippet     TEXT NOT NULL,
  use_count   INTEGER NOT NULL DEFAULT 0,
  connections INTEGER NOT NULL DEFAULT 0,
  last_used   DATE NOT NULL DEFAULT CURRENT_DATE,
  created     DATE NOT NULL DEFAULT CURRENT_DATE
);

CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories (agent_id);
CREATE INDEX IF NOT EXISTS idx_memories_fts ON memories USING GIN (to_tsvector('english', snippet));
CREATE INDEX IF NOT EXISTS idx_memories_trgm ON memories USING GIN (snippet gin_trgm_ops);
