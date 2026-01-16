export interface OIDCClientConfig {
  issuer: string;
  clientId: string;
  redirectUri: string;
  postLogoutRedirectUri?: string;
  scopes?: string[];
  autoRefresh?: boolean;
  refreshBufferSeconds?: number;
  storage?: TokenStorage;
  flowType?: "redirect" | "popup";
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt: number;
  scope?: string;
}

export interface OIDCUserInfo {
  sub: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  givenName?: string;
  familyName?: string;
  picture?: string;
  locale?: string;
  [key: string]: unknown;
}

export type AuthStatus =
  | "initializing"
  | "unauthenticated"
  | "authenticating"
  | "authenticated"
  | "error";

export interface AuthState {
  status: AuthStatus;
  user: OIDCUserInfo | null;
  isAuthenticated: boolean;
  error: Error | null;
  accessToken: string | null;
}

export interface TokenStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  clear(): Promise<void>;
}

export interface OIDCDiscoveryResponse {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  end_session_endpoint?: string;
  jwks_uri: string;
  scopes_supported?: string[];
  response_types_supported: string[];
  code_challenge_methods_supported?: string[];
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
}

export interface PKCEChallenge {
  codeVerifier: string;
  codeChallenge: string;
  state: string;
  nonce: string;
}

export interface AuthCallbackParams {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
}

export interface AuthManagerEvents {
  stateChanged: (state: AuthState) => void;
  tokenRefreshed: (tokens: TokenSet) => void;
  error: (error: Error) => void;
  loggedOut: () => void;
}

export type AuthEventListener<K extends keyof AuthManagerEvents> = AuthManagerEvents[K];
