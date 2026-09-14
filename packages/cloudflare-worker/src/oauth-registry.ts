export interface OAuthProviderDef {
  name: string;

  tokenEndpoint: string;

  revokeEndpoint?: string | ((clientId: string) => string);

  revokeMethod?: 'post-body' | 'delete-basic';

  clientIdEnvKey: string;

  clientSecretEnvKey: string;
}

export const OAUTH_PROVIDERS: Record<string, OAuthProviderDef> = {
  github: {
    name: 'GitHub',
    tokenEndpoint: 'https://github.com/login/oauth/access_token',
    revokeEndpoint: (clientId) => `https://api.github.com/applications/${clientId}/token`,
    revokeMethod: 'delete-basic',
    clientIdEnvKey: 'GITHUB_CLIENT_ID',
    clientSecretEnvKey: 'GITHUB_CLIENT_SECRET',
  },
};
