# Enterprise SSO for Signals

Signals always trusts one Keycloak issuer. Keycloak brokers customer identity using OIDC or SAML 2.0. Microsoft Entra ID, Okta, Ping and other enterprise providers connect at this boundary; AD can also be federated through LDAP as required.

1. Create the customer OIDC/SAML app in the customer's identity provider.
2. In Keycloak Signals realm, add the matching Identity Provider and copy its broker callback URL into that customer app. Do not use the Signals `/auth/callback` URL for the upstream provider.
3. Configure issuer/discovery URL, client ID/secret, scopes or SAML metadata/signing certificate from that organization. Use HTTPS and verified metadata.
4. Configure first-broker-login policy carefully. Avoid automatic linking of an existing account merely because email matches. Enforce MFA/conditional access in the enterprise provider or Keycloak.
5. Grant explicit tenant memberships by verified Keycloak subject through an authorized provisioning process. The starter uses a trusted CLI. Customer identity-provider aliases or a browser tenant selector do not establish membership.
6. Test new user, existing user, disabled user, revoked tenant membership, refresh expiry and logout.

The starter uses one realm with application-managed memberships. A user may access several tenants. If contractual isolation requires a realm per customer, implement an issuer allowlist, issuer+subject user identity key, discovery selection and per-issuer session handling before enabling that mode.

## Native GLPI, Zabbix and Wazuh screens

The Signals portal session does not automatically create a native product session. To launch native screens without repeated credential entry, each product must independently trust Keycloak through a supported SAML/OIDC plugin or documented reverse-proxy authentication mechanism. Confirm product edition/version support, user mapping, role mapping and logout behavior. Never pass passwords, Signals session cookies, or privileged API tokens into browser URLs.

Rebuilt React screens can use the existing Signals proxy API session. Their server adapters must enforce tenant and role checks and map access to the appropriate product instance/entity. A shared service-account token requires explicit per-user/tenant authorization and auditing. None of these product adapters is connected in this starter.

Reference: https://www.keycloak.org/securing-apps/oidc-layers
Administration: https://www.keycloak.org/docs/latest/server_admin/
OIDC client library: https://github.com/panva/openid-client
