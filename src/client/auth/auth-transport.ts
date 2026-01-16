import { TokenManager } from "./token-manager";

export interface RequestConfig {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  skipAuth?: boolean;
}

export interface AuthTransportConfig {
  retryOn401?: boolean;
  maxRetries?: number;
  onUnauthorized?: () => void;
}

export class AuthTransport {
  private config: AuthTransportConfig;

  constructor(
    private tokenManager: TokenManager,
    config: AuthTransportConfig = {}
  ) {
    this.config = {
      retryOn401: true,
      maxRetries: 1,
      ...config,
    };
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === "string" ? input : input.toString();
    return this.request({
      url,
      method: init?.method,
      headers: init?.headers as Record<string, string>,
      body: init?.body,
    });
  }

  async request(config: RequestConfig, retryCount = 0): Promise<Response> {
    const headers = new Headers(config.headers);

    if (!config.skipAuth) {
      const accessToken = this.tokenManager.getAccessToken();
      if (accessToken) {
        headers.set("Authorization", `Bearer ${accessToken}`);
      }
    }

    const response = await fetch(config.url, {
      method: config.method ?? "GET",
      headers,
      body: config.body ? JSON.stringify(config.body) : undefined,
    });

    if (
      response.status === 401 &&
      this.config.retryOn401 &&
      retryCount < (this.config.maxRetries ?? 1)
    ) {
      const tokens = this.tokenManager.getTokens();
      if (tokens?.refreshToken) {
        try {
          await this.tokenManager.refreshTokens();
          return this.request(config, retryCount + 1);
        } catch {
          this.config.onUnauthorized?.();
        }
      } else {
        this.config.onUnauthorized?.();
      }
    }

    return response;
  }

  async json<T>(config: RequestConfig): Promise<T> {
    const response = await this.request({
      ...config,
      headers: {
        ...config.headers,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.message ?? `Request failed: ${response.status}`);
    }

    return response.json();
  }

  createEventSource(url: string): EventSource {
    const tokens = this.tokenManager.getTokens();
    const separator = url.includes("?") ? "&" : "?";
    const authUrl = tokens?.accessToken
      ? `${url}${separator}access_token=${encodeURIComponent(tokens.accessToken)}`
      : url;

    return new EventSource(authUrl);
  }
}

export const createAuthTransport = (
  tokenManager: TokenManager,
  config?: AuthTransportConfig
): AuthTransport => {
  return new AuthTransport(tokenManager, config);
};
