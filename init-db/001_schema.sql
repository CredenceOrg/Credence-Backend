CREATE TABLE IF NOT EXISTS audit_logs (
	id TEXT PRIMARY KEY,
	occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	actor_id TEXT NOT NULL,
	actor_email TEXT NOT NULL,
	action TEXT NOT NULL,
	resource_type TEXT NOT NULL,
	resource_id TEXT NOT NULL,
	details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
	status TEXT NOT NULL CHECK (status IN ('success', 'failure')),
	ip_address TEXT,
	error_message TEXT
);

CREATE INDEX IF NOT EXISTS audit_logs_actor_time_idx
	ON audit_logs (actor_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS audit_logs_resource_time_idx
	ON audit_logs (resource_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS audit_logs_time_idx
	ON audit_logs (occurred_at DESC);
