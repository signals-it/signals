import * as oidc from 'openid-client';
import { production } from '../config.js';
import type { AuthProvider, AuthorizationRequest, CallbackRequest, ExchangeResult, IdClaims, TokenSet } from './provider.js';

export const randomVerifier = () => oidc.randomPKCECodeVerifier();
export const randomState = () => oidc.randomState();
export const randomNonce = () => oidc.randomNonce();
export const calculateCodeChallenge = (verifier: string) => oidc.calculatePKCECodeChallenge(verifier);

function toTokenSet(tokens: oidc.TokenEndpointResponse): TokenSet {
  const expiresIn = Number(tokens.expires_in ?? 60);
  return {
    accessToken: tokens.access_token,
    refreshToken: t(tokens.refresh_token),
    idToken: t(tokens.id_token),
    expiresAt: new Date(Date.now() + expiresIn * 1000),
  };
}
const t = (value: string | undefined): string | null => (value === undefined ? null : value);

export class KeycloakAuthProvider implements AuthProvider {
  private configuration: Promise<oidc.Configuration> | undefined;
  constructor(private readonly options: {
    issuer: string;
    clientId: string;
    clientSecret: string;
    postLogoutRedirectUri: string;
  }) {}

  private config(): Promise<oidc.Configuration> {
    if (!this.configuration) {
      this.configuration = oidc.discovery(
        new URL(this.options.issuer),
        this.options.clientId,
        this.options.clientSecret,
        undefined,
        production ? undefined : { execute: [oidc.allowInsecureRequests] },
      ).catch((error: unknown) => { this.configuration = undefined; throw error; });
    }
    return this.configuration;
  }

  async ready(): Promise<void> { await this.config(); }

  async buildAuthorizationUrl(request: AuthorizationRequest): Promise<string> {
    const config = await this.config();
    return oidc.buildAuthorizationUrl(config, {
      redirect_uri: request.redirectUri,
      scope: request.scope,
      code_challenge: request.codeChallenge,
      code_challenge_method: 'S256',
      state: request.state,
      nonce: request.nonce,
    }).href;
  }

  async exchangeCode(request: CallbackRequest): Promise<ExchangeResult> {
    const config = await this.config();
    const tokens = await oidc.authorizationCodeGrant(config, request.url, {
      pkceCodeVerifier: request.codeVerifier,
      expectedState: request.state,
      expectedNonce: request.nonce,
      idTokenExpected: true,
    });
    const claims = tokens.claims() as IdClaims | undefined;
    if (!claims?.sub) throw new Error('Missing subject');
    return { tokens: toTokenSet(tokens), claims };
  }

  async refreshToken(refreshToken: string): Promise<TokenSet> {
    const config = await this.config();
    return toTokenSet(await oidc.refreshTokenGrant(config, refreshToken));
  }

  async endSessionUrl(idToken: string | null): Promise<string> {
    const config = await this.config();
    return oidc.buildEndSessionUrl(config, {
      id_token_hint: idToken ?? '',
      post_logout_redirect_uri: this.options.postLogoutRedirectUri,
      client_id: this.options.clientId,
    }).href;
  }
}
