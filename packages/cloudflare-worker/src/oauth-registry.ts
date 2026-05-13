/**
 * Generic OAuth provider registry for server-side authorization code exchange.
 *
 * Each entry describes how to exchange an authorization code for tokens and
 * optionally how to revoke a token. Adding a new provider is just a new entry
 * here plus the corresponding Wrangler secrets — no new routes or handlers.
 *
 * Implicit-grant providers (e.g. Adobe IMS) do not appear here because they
 * never need a server-side exchange.
 */

export interface OAuthProviderDef {
  /** Human-readable name (used in error messages). */
  name: string;

  /** URL to POST the authorization code exchange to. */
  tokenEndpoint: string;

  /**
   * Optional revocation endpoint. Either a static string or a function
   * that receives the resolved clientId (needed when the URL includes it,
   * e.g. GitHub's `/applications/{client_id}/token`).
   *
   * Omit if the provider does not support token revocation.
   */
  revokeEndpoint?: string | ((clientId: string) => string);

  /**
   * How to call the revocation endpoint. Defaults to `'post-body'`.
   *
   * - `'post-body'`: RFC 7009 style — POST with `token` + `client_id` +
   *   `client_secret` as form-encoded body. Used by Google and most providers.
   * - `'delete-basic'`: GitHub style — DELETE with Basic auth
   *   (`base64(clientId:clientSecret)`) and JSON body `{ access_token }`.
   */
  revokeMethod?: 'post-body' | 'delete-basic';

  /** Environment variable name that holds the OAuth client ID. */
  clientIdEnvKey: string;

  /** Environment variable name that holds the OAuth client secret. */
  clientSecretEnvKey: string;
}

/**
 * Registry of OAuth providers that support authorization code exchange.
 *
 * To add a provider:
 *   1. Add an entry here
 *   2. Set the client ID in wrangler.jsonc vars
 *   3. Set the client secret via `npx wrangler secret put <SECRET_KEY>`
 */
export const OAUTH_PROVIDERS: Record<string, OAuthProviderDef> = {
  github: {
    name: 'GitHub',
    tokenEndpoint: 'https://github.com/login/oauth/access_token',
    revokeEndpoint: (clientId) => `https://api.github.com/applications/${clientId}/token`,
    revokeMethod: 'delete-basic',
    clientIdEnvKey: 'GITHUB_CLIENT_ID',
    clientSecretEnvKey: 'GITHUB_CLIENT_SECRET',
  },
  google: {
    name: 'Google',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
    revokeEndpoint: 'https://oauth2.googleapis.com/revoke',
    revokeMethod: 'post-body',
    clientIdEnvKey: 'GOOGLE_CLIENT_ID',
    clientSecretEnvKey: 'GOOGLE_CLIENT_SECRET',
  },
};
