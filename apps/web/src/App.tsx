import { useEffect, useState } from 'react';
import {
  Activity, Boxes, CircleHelp, ClipboardList, Gauge, LayoutDashboard,
  LockKeyhole, Network, Settings, ShieldCheck, Ticket, Workflow
} from 'lucide-react';
import './styles.css';
import { SessionPanel, type SessionInfo } from '../../../modules/administration/ui/SessionPanel';

type ApiHealth = { status: string; service: string; timestamp: string };
type Integration = { name: string; configured: boolean; mode: string; description: string };

const navigation = [
  { label: 'Overview', icon: LayoutDashboard, key: 'overview' },
  { label: 'IT Service Desk', icon: Ticket, key: 'itsm' },
  { label: 'Asset Management', icon: Boxes, key: 'assets' },
  { label: 'Monitoring', icon: Activity, key: 'monitoring' },
  { label: 'Orchestration', icon: Workflow, key: 'orchestration' },
  { label: 'Administration', icon: Settings, key: 'administration' },
];

const moduleCopy: Record<string, { title: string; description: string; provider: string; items: string[] }> = {
  overview: { title: 'Signals overview', description: 'A single workspace for service management, asset inventory, and infrastructure health.', provider: 'Platform shell', items: ['Keycloak login implemented', 'Add GLPI-backed assets and tickets', 'Add Zabbix-backed monitoring views'] },
  itsm: { title: 'IT Service Desk', description: 'The future React ticketing experience backed by GLPI workflows and data.', provider: 'GLPI backend', items: ['Ticket queue and filters', 'Ticket details, assignment and status', 'Service requests and SLA views'] },
  assets: { title: 'Asset Management', description: 'The future React asset experience backed by GLPI inventory capabilities.', provider: 'GLPI backend', items: ['Hardware and software inventory', 'Asset details and lifecycle', 'Ownership, location and relationship views'] },
  monitoring: { title: 'Monitoring', description: 'The future React monitoring experience backed by the Zabbix monitoring engine.', provider: 'Zabbix backend', items: ['Hosts and availability', 'Problems, triggers and events', 'Metrics and trend charts'] },
  orchestration: { title: 'Orchestration', description: 'A place for approved configuration plans, deployment steps, and execution history.', provider: 'Platform services', items: ['Configuration requests', 'Approval and execution status', 'Auditable job history'] },
  administration: { title: 'Administration', description: 'Tenant-aware platform settings, access controls, and product connections.', provider: 'Platform services + Keycloak', items: ['Tenant and membership management', 'Role and permission mapping', 'Integration health and audit events'] },
};

export default function App() {
  const [active, setActive] = useState('overview');
  const [health, setHealth] = useState<ApiHealth | null>(null);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [apiError, setApiError] = useState('');

  const [session, setSession] = useState<SessionInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [tenant, setTenant] = useState('');
  const [authError, setAuthError] = useState('');
  useEffect(() => {
    fetch('/api/session').then(async r => {
      if (r.status === 401) return null;
      if (!r.ok) throw new Error('Login service unavailable');
      return r.json() as Promise<SessionInfo>;
    }).then(s => { setSession(s); setTenant(s?.memberships[0]?.id ?? ''); })
      .catch(() => setAuthError('Login service unavailable. Check the API and database.'))
      .finally(() => setLoading(false));
  }, []);
  async function logout() {
    try {
      const r = await fetch('/api/logout', { method: 'POST', headers: { 'X-CSRF-Token': session?.csrfToken ?? '' } });
      if (r.status === 401) { setSession(null); return; }
      if (!r.ok) throw new Error('Logout failed');
      const data = await r.json(); window.location.assign(data.logoutUrl);
    } catch { setApiError('Sign out failed. Please try again.'); }
  }

  useEffect(() => {
    if (!session || !tenant) return;
    // The SPA only talks to the proxy API. Backend calls are forwarded through
    // POST /api/proxy and never sent directly to the Signals backend API.
    Promise.all([
      fetch('/api/health').then((r) => { if (!r.ok) throw new Error('API health request failed'); return r.json(); }),
      fetch('/api/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
        body: JSON.stringify({ method: 'GET', path: `/signals/api/v1/tenants/${tenant}/integrations` }),
      }).then(async (r) => {
        if (r.status === 401) { setSession(null); throw new Error('Session expired'); }
        if (!r.ok) throw new Error('Integration status request failed');
        const envelope = await r.json();
        if (envelope.status === 401) { setSession(null); throw new Error('Session expired'); }
        if (envelope.status !== 200) throw new Error('Integration status request failed');
        return envelope.body as { integrations?: Integration[] };
      }),
    ]).then(([h, i]) => { setHealth(h); setIntegrations(i.integrations ?? []); })
      .catch(() => setApiError('API is not reachable. Start the proxy API (port 4000) and backend API (port 4100).'));
  }, [session, tenant]);

  if (loading) return <main className="login-page"><h1>Signals</h1><p>Checking your session…</p></main>;
  if (!session) return <main className="login-page"><div className="panel"><h1>Signals</h1><p>One workspace for your IT operations.</p><p>{authError}</p><a className="login-button" href="/auth/login">Sign in with your organization</a><p>Enterprise identity powered by Keycloak</p></div></main>;
  if (!session.memberships.length) return <main className="login-page"><div className="panel"><h1>Welcome to Signals</h1><p>You are signed in. Ask your administrator to grant tenant access.</p><p>Your Keycloak subject: <code>{session.user.keycloak_subject}</code></p><button onClick={() => window.location.reload()}>Check access again</button> <button onClick={logout}>Sign out</button><p>{apiError}</p></div></main>;

  const page = moduleCopy[active];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><Network size={22} /></div>
          <div><strong>Signals</strong><span>Management Platform</span></div>
        </div>
        <div className="workspace-label">WORKSPACE</div>
        <nav>
          {navigation.filter(n => n.key !== 'administration' || session.memberships.find(m => m.id === tenant)?.role_key === 'tenant_admin').map(({ label, icon: Icon, key }) => (
            <button key={key} className={`nav-item ${active === key ? 'active' : ''}`} onClick={() => setActive(key)}>
              <Icon size={18} strokeWidth={1.8} /><span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="security-note"><ShieldCheck size={17} /><div><strong>Security first</strong><span>Identity via Keycloak</span></div></div>
          <button className="nav-item muted" onClick={() => setActive('administration')}><CircleHelp size={18} /><span>Setup & help</span></button>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumbs">Workspace <span>/</span> {page.title}</div>
          <div className="topbar-right"><SessionPanel session={session} tenant={tenant} onTenant={id => { setTenant(id); setActive('overview'); }} onLogout={logout} /><span className="environment-pill"><span className="status-dot" /> Local development</span><div className="avatar">IT</div></div>
        </header>

        <div className="page-content">
          <section className="welcome-row">
            <div>
              <div className="eyebrow">UNIFIED OPERATIONS</div>
              <h1>{page.title}</h1>
              <p>{page.description}</p>
            </div>
            <div className="page-icon"><Gauge size={26} /></div>
          </section>

          {apiError && <div className="alert"><CircleHelp size={18} />{apiError}</div>}

          <section className="status-grid">
            <div className="status-card"><div className="card-icon indigo"><ShieldCheck size={19} /></div><div className="card-label">Platform API</div><div className="card-value">{health?.status === 'ok' ? 'Connected' : 'Checking'}</div><div className="card-foot">{health?.service ?? 'Waiting for API response'}</div></div>
            <div className="status-card"><div className="card-icon teal"><Boxes size={19} /></div><div className="card-label">ITSM & Assets</div><div className="card-value">GLPI adapter</div><div className="card-foot">Connector scaffolded</div></div>
            <div className="status-card"><div className="card-icon orange"><Activity size={19} /></div><div className="card-label">Infrastructure</div><div className="card-value">Zabbix adapter</div><div className="card-foot">Connector scaffolded</div></div>
            <div className="status-card"><div className="card-icon slate"><LockKeyhole size={19} /></div><div className="card-label">Identity</div><div className="card-value">Keycloak</div><div className="card-foot">Signed in</div></div>
          </section>

          <section className="content-grid">
            <div className="panel primary-panel">
              <div className="panel-heading"><div><h2>{active === 'overview' ? 'Implementation roadmap' : `${page.title} workspace`}</h2><p>{active === 'overview' ? 'Build the unified experience incrementally.' : `Provider: ${page.provider}`}</p></div><span className="tag">Starter</span></div>
              <div className="task-list">
                {page.items.map((item, i) => <div className="task-row" key={item}><div className="task-number">{String(i + 1).padStart(2, '0')}</div><div className="task-copy"><strong>{item}</strong><span>{item === 'Keycloak login implemented' ? 'Available now' : active === 'overview' ? 'Planned milestone' : 'Screen/workflow to implement'}</span></div><span className="status-badge pending">{item === 'Keycloak login implemented' ? 'Complete' : 'Planned'}</span></div>)}
              </div>
            </div>
            <div className="panel">
              <div className="panel-heading"><div><h2>Connected products</h2><p>Adapter readiness</p></div><Network size={18} className="heading-icon" /></div>
              <div className="integration-list">
                {(integrations.length ? integrations : [
                  { name: 'GLPI', configured: false, mode: 'API adapter scaffold', description: 'ITSM and assets' },
                  { name: 'Zabbix', configured: false, mode: 'API adapter scaffold', description: 'Infrastructure monitoring' },
                  { name: 'Keycloak', configured: false, mode: 'OIDC active', description: 'Central identity and SSO' },
                ]).map((item) => <div className="integration-row" key={item.name}><div className={`product-logo ${item.name.toLowerCase()}`}>{item.name.slice(0, 1)}</div><div className="integration-copy"><strong>{item.name}</strong><span>{item.description}</span></div><span className={`mini-status ${item.configured ? 'ready' : ''}`}>{item.configured ? 'Ready' : 'Setup'}</span></div>)}
              </div>
              <div className="panel-note"><ClipboardList size={16} /><span>Product adapters are intentionally server-side. No product secrets are exposed to the browser.</span></div>
            </div>
          </section>
          <footer className="footer"><span>Signals · Starter 0.1.0</span><span><span className="status-dot" /> {health?.status === 'ok' ? 'API healthy' : 'API status unknown'}</span></footer>
        </div>
      </main>
    </div>
  );
}
