CREATE TABLE IF NOT EXISTS cf_shadow_requests (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  result_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  completed_at TEXT,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cf_shadow_requests_pending
  ON cf_shadow_requests (status, created_at);

CREATE INDEX IF NOT EXISTS idx_cf_shadow_requests_expires
  ON cf_shadow_requests (expires_at);
