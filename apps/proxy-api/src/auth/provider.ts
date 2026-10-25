export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  expiresAt: Date;
}

export interface IdClaims {
  sub: string;
  email?: string;
  name?: string;
  preferred_username?: string;
  [claim: string]: unknown;
}

export interface AuthorizationRequest {
  state: string;
  nonce: string;
  codeChallenge: string;
  redirectUri: string;
  scope: string;
}

export interface CallbackRequest {
  url: URL;
  codeVerifier: string;
  state: string;
  nonce: string;
}

export interface ExchangeResult {
  tokens: TokenSet;
  claims: IdClaims;
}

/**
 * Provider-agnostic OAuth 2.0 / OIDC boundary. Keycloak implements this today;
 * another OIDC provider can be swapped in without changing session, cookie,
 * token-encryption or proxy code.
 */
export interface AuthProvider {
  buildAuthorizationUrl(request: AuthorizationRequest): Promise<string>;
  exchangeCode(request: CallbackRequest): Promise<ExchangeResult>;
  refreshToken(refreshToken: string): Promise<TokenSet>;
  endSessionUrl(idToken: string | null): Promise<string>;
  ready(): Promise<void>;
}
