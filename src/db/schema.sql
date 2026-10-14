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
CREATE INDEX IF NOT EXISTS audit_log_app_idx ON audit_log (application_id, created_at);