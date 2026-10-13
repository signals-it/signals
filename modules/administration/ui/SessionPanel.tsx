export type Membership = { id: string; name: string; slug: string; role_key: string };
export type SessionInfo = { user: { keycloak_subject: string; display_name: string; email: string }; memberships: Membership[]; csrfToken: string };
export function SessionPanel({ session, tenant, onTenant, onLogout }: {
  session: SessionInfo; tenant: string; onTenant: (id: string) => void; onLogout: () => void;
}) {
  return <div className="session-bar">
    <span>{session.user.display_name || session.user.email}</span>
    <select aria-label="Active tenant" value={tenant} onChange={e => onTenant(e.target.value)}>
      {session.memberships.map(m => <option key={m.id} value={m.id}>{m.name} · {m.role_key}</option>)}
    </select>
    <button onClick={onLogout}>Sign out</button>
  </div>;
}
