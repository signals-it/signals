CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE platform_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  keycloak_subject TEXT UNIQUE NOT NULL,
  email TEXT,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO tenants(slug,name) VALUES('signals-demo','Signals Demo Tenant');
CREATE TABLE tenant_memberships (
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID REFERENCES platform_users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  role_key TEXT NOT NULL CHECK (role_key IN ('tenant_admin','operator','viewer')),
  PRIMARY KEY (tenant_id,user_id)
);
CREATE TABLE audit_events (
  id BIGSERIAL PRIMARY KEY,
  actor_subject TEXT,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_actor_subject_idx ON audit_events (actor_subject);
CREATE INDEX audit_events_occurred_at_idx ON audit_events (occurred_at DESC);


-- Dev only: auto-assign first-login users, or seed explicitly after first login
-- Run this after john.doe has logged in once (so the platform_users row exists)
INSERT INTO tenant_memberships (tenant_id, user_id, role_key)
SELECT t.id, u.id, 'tenant_admin'
FROM tenants t, platform_users u
WHERE t.slug = 'signals-demo'
AND u.email = 'john.doe@corporatexyz.com';

CREATE TRIGGER platform_users_updated_at
BEFORE UPDATE ON platform_users
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

