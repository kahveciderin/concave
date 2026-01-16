import {
  OIDCClientConfig,
  OIDCDiscoveryResponse,
  PKCEChallenge,
  TokenResponse,
  AuthCallbackParams,
} from "./types";

const base64UrlEncode = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
};

const generateRandomString = (length: number = 32): string => {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return base64UrlEncode(array.buffer);
};

const sha256 = async (plain: string): Promise<ArrayBuffer> => {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  return await crypto.subtle.digest("SHA-256", data);
};

export class OIDCClient {
  private discovery: OIDCDiscoveryResponse | null = null;
  private discoveryPromise: Promise<OIDCDiscoveryResponse> | null = null;

  constructor(private config: OIDCClientConfig) {}

  async fetchDiscovery(): Promise<OIDCDiscoveryResponse> {
    if (this.discovery) {
      return this.discovery;
    }

    if (this.discoveryPromise) {
      return this.discoveryPromise;
    }

    this.discoveryPromise = (async () => {
      const url = this.config.issuer.endsWith("/")
        ? `${this.config.issuer}.well-known/openid-configuration`
        : `${this.config.issuer}/.well-known/openid-configuration`;

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch OIDC discovery: ${response.status}`);
      }

      this.discovery = await response.json();
      return this.discovery!;
    })();

    return this.discoveryPromise;
  }

  async generatePKCEChallenge(): Promise<PKCEChallenge> {
    const codeVerifier = generateRandomString(43);
    const challengeBuffer = await sha256(codeVerifier);
    const codeChallenge = base64UrlEncode(challengeBuffer);
    const state = generateRandomString(16);
    const nonce = generateRandomString(16);

    return {
      codeVerifier,
      codeChallenge,
      state,
      nonce,
    };
  }

  async buildAuthorizationUrl(challenge: PKCEChallenge): Promise<string> {
    const discovery = await this.fetchDiscovery();
    const scopes = this.config.scopes ?? ["openid", "profile", "email"];

    const params = new URLSearchParams({
      response_type: "code",
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      scope: scopes.join(" "),
      state: challenge.state,
      nonce: challenge.nonce,
      code_challenge: challenge.codeChallenge,
      code_challenge_method: "S256",
    });

    return `${discovery.authorization_endpoint}?${params.toString()}`;
  }

  async exchangeCodeForTokens(
    code: string,
    codeVerifier: string
  ): Promise<TokenResponse> {
    const discovery = await this.fetchDiscovery();

    const params = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.config.redirectUri,
      client_id: this.config.clientId,
      code_verifier: codeVerifier,
    });

    const response = await fetch(discovery.token_endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "token_error" }));
      throw new Error(error.error_description ?? error.error ?? "Token exchange failed");
    }

    return response.json();
  }

  async refreshTokens(refreshToken: string): Promise<TokenResponse> {
    const discovery = await this.fetchDiscovery();

    const params = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: this.config.clientId,
    });

    const response = await fetch(discovery.token_endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "refresh_error" }));
      throw new Error(error.error_description ?? error.error ?? "Token refresh failed");
    }

    return response.json();
  }

  async fetchUserInfo(accessToken: string): Promise<Record<string, unknown>> {
    const discovery = await this.fetchDiscovery();

    const response = await fetch(discovery.userinfo_endpoint, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch user info: ${response.status}`);
    }

    return response.json();
  }

  async buildLogoutUrl(idTokenHint?: string): Promise<string> {
    const discovery = await this.fetchDiscovery();

    if (!discovery.end_session_endpoint) {
      throw new Error("OIDC provider does not support end_session_endpoint");
    }

    const params = new URLSearchParams();

    if (idTokenHint) {
      params.set("id_token_hint", idTokenHint);
    }

    if (this.config.postLogoutRedirectUri) {
      params.set("post_logout_redirect_uri", this.config.postLogoutRedirectUri);
    }

    params.set("client_id", this.config.clientId);

    return `${discovery.end_session_endpoint}?${params.toString()}`;
  }

  parseCallbackParams(url: string): AuthCallbackParams {
    const urlObj = new URL(url);
    const params = urlObj.searchParams;

    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined,
      error: params.get("error") ?? undefined,
      errorDescription: params.get("error_description") ?? undefined,
    };
  }
}

export const createOIDCClient = (config: OIDCClientConfig): OIDCClient => {
  return new OIDCClient(config);
};
