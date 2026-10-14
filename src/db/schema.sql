-- Niyam schema. Safe to run more than once.

CREATE TABLE IF NOT EXISTS lenders (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every version of a lender's rules is kept. Exactly one can be active.
-- Day 4-5: the policy agent writes 'draft' rows, a human flips them to 'active'.
CREATE TABLE IF NOT EXISTS rulesets (
  id           BIGSERIAL PRIMARY KEY,
  lender_id    TEXT NOT NULL REFERENCES lenders(id),
  version      INT  NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('draft', 'active', 'retired')),
  source       TEXT NOT NULL CHECK (source IN ('manual', 'agent')),
  ruleset      JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at  TIMESTAMPTZ,
  UNIQUE (lender_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_ruleset_per_lender
  ON rulesets (lender_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS applications (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key  TEXT NOT NULL UNIQUE,
  request_hash     TEXT NOT NULL,
  profile          JSONB NOT NULL,
  routing          JSONB NOT NULL,       -- ranked lenders + reasons at submit time
  ruleset_ids      BIGINT[] NOT NULL,    -- exactly which rule versions were used
  status           TEXT NOT NULL DEFAULT 'routed'
                   CHECK (status IN ('routed', 'no_match', 'submitting', 'approved', 'rejected', 'failed')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only log of everything that happens to an application.
CREATE TABLE IF NOT EXISTS audit_log (
  id              BIGSERIAL PRIMARY KEY,
  application_id  UUID REFERENCES applications(id),
  event           TEXT NOT NULL,
  data            JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ===== Day 3: submissions to lenders + webhooks =====

-- One row per (application, lender) we submit to. The DB is the source of
-- truth; the queue only delivers work. Unique pair = never submit twice.
CREATE TABLE IF NOT EXISTS submissions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  UUID NOT NULL REFERENCES applications(id),
  lender_id       TEXT NOT NULL REFERENCES lenders(id),
  rank            INT  NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'sending', 'pending_decision', 'approved', 'rejected', 'failed')),
  attempts        INT  NOT NULL DEFAULT 0,
  lender_ref      TEXT,
  offered_rate    NUMERIC,
  reason          TEXT,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (application_id, lender_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS submissions_lender_ref_idx
  ON submissions (lender_id, lender_ref) WHERE lender_ref IS NOT NULL;

-- Every webhook we receive, deduplicated. Lenders often send the same one twice.
CREATE TABLE IF NOT EXISTS webhook_events (
  id                  BIGSERIAL PRIMARY KEY,
  lender_id           TEXT NOT NULL,
  payload_hash        TEXT NOT NULL,
  lender_ref          TEXT,
  payload             JSONB NOT NULL,
  matched_submission  UUID REFERENCES submissions(id),
  received_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (lender_id, payload_hash)
);

-- ===== Day 4: agent-extracted rulesets carry their review report =====
ALTER TABLE rulesets ADD COLUMN IF NOT EXISTS report JSONB;
ALTER TABLE rulesets ADD COLUMN IF NOT EXISTS source_document TEXT;
CREATE INDEX IF NOT EXISTS audit_log_app_idx ON audit_log (application_id, created_at);


-- ===== Day 5: human review + versioning =====
ALTER TABLE rulesets ADD COLUMN IF NOT EXISTS agent_ruleset JSONB;  -- what the agent proposed, before human edits
ALTER TABLE rulesets ADD COLUMN IF NOT EXISTS source_pages JSONB;   -- extracted text, so citations can be shown and re-checked
ALTER TABLE rulesets ADD COLUMN IF NOT EXISTS created_by TEXT;
ALTER TABLE rulesets ADD COLUMN IF NOT EXISTS approved_by TEXT;
ALTER TABLE rulesets ADD COLUMN IF NOT EXISTS review_note TEXT;

ALTER TABLE rulesets DROP CONSTRAINT IF EXISTS rulesets_status_check;
ALTER TABLE rulesets ADD CONSTRAINT rulesets_status_check CHECK (status IN ('draft', 'active', 'retired', 'rejected'));

-- Who did what to which rule version, and when. Append-only.
CREATE TABLE IF NOT EXISTS ruleset_events (
  id          BIGSERIAL PRIMARY KEY,
  ruleset_id  BIGINT NOT NULL REFERENCES rulesets(id),
  lender_id   TEXT NOT NULL,
  event       TEXT NOT NULL,
  actor       TEXT NOT NULL,
  data        JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ruleset_events_lender_idx ON ruleset_events (lender_id, created_at);