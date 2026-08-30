export const SCHEMA_SQL = `
CREATE TABLE prompts (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  icon TEXT,
  draft_content TEXT,
  current_version_id TEXT REFERENCES versions(id),
  is_starred INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE branches (
  id TEXT PRIMARY KEY,
  prompt_id TEXT NOT NULL REFERENCES prompts(id),
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (prompt_id, name)
);

CREATE TABLE versions (
  id TEXT PRIMARY KEY,
  prompt_id TEXT NOT NULL REFERENCES prompts(id),
  branch_id TEXT NOT NULL REFERENCES branches(id),
  parent_version_id TEXT REFERENCES versions(id),
  number INTEGER NOT NULL,
  label TEXT,
  content TEXT NOT NULL,
  content_format TEXT NOT NULL DEFAULT 'markdown',
  change_note TEXT,
  author TEXT NOT NULL DEFAULT 'You',
  created_at TEXT NOT NULL
);

CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  prompt_id TEXT NOT NULL REFERENCES prompts(id),
  version_id TEXT REFERENCES versions(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  color TEXT
);

CREATE TABLE prompt_tags (
  prompt_id TEXT NOT NULL REFERENCES prompts(id),
  tag_id TEXT NOT NULL REFERENCES tags(id),
  PRIMARY KEY (prompt_id, tag_id)
);

CREATE TABLE collections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE collection_prompts (
  collection_id TEXT NOT NULL REFERENCES collections(id),
  prompt_id TEXT NOT NULL REFERENCES prompts(id),
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (collection_id, prompt_id)
);

CREATE TABLE ratings (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL CHECK (target_type IN ('prompt', 'version')),
  target_id TEXT NOT NULL,
  effectiveness REAL CHECK (effectiveness IS NULL OR (effectiveness >= 1 AND effectiveness <= 5)),
  clarity REAL CHECK (clarity IS NULL OR (clarity >= 1 AND clarity <= 5)),
  completeness REAL CHECK (completeness IS NULL OR (completeness >= 1 AND completeness <= 5)),
  actionability REAL CHECK (actionability IS NULL OR (actionability >= 1 AND actionability <= 5)),
  created_at TEXT NOT NULL
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  prompt_id TEXT NOT NULL REFERENCES prompts(id),
  version_id TEXT NOT NULL REFERENCES versions(id),
  tool TEXT NOT NULL DEFAULT 'manual',
  model TEXT,
  outcome_rating REAL CHECK (outcome_rating IS NULL OR (outcome_rating >= 1 AND outcome_rating <= 5)),
  result_summary TEXT,
  metrics_json TEXT,
  started_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Full-text search index over prompt title/description, tag names, note bodies
-- and version content. Maintained by explicit writes inside mutation
-- transactions (no triggers). One prompt-level row (version_id NULL) plus one
-- row per version.
CREATE VIRTUAL TABLE search_index USING fts5(
  prompt_id UNINDEXED,
  version_id UNINDEXED,
  title,
  description,
  tags,
  notes,
  content,
  tokenize = 'porter'
);
`;
