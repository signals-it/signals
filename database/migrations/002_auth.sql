CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TABLE auth_transactions (
  id_hash TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX auth_transactions_expires_at_idx ON auth_transactions (expires_at);

CREATE TABLE auth_sessions (
  id_hash TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  token_payload TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  absolute_expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX auth_sessions_expires_at_idx ON auth_sessions (expires_at);
CREATE INDEX auth_sessions_absolute_expires_at_idx ON auth_sessions (absolute_expires_at);
CREATE INDEX auth_sessions_user_id_idx ON auth_sessions (user_id);

CREATE TRIGGER auth_sessions_updated_at
BEFORE UPDATE ON auth_sessions
FOR EACH ROW EXECUTE FUNCTION set_updated_at();