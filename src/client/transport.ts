import {
  TransportConfig,
  TransportRequest,
  TransportResponse,
  ErrorResponse,
} from "./types";

export interface Transport {
  request<T>(req: TransportRequest): Promise<TransportResponse<T>>;
  createEventSource(path: string, params?: Record<string, string>): EventSource;
  setHeader(name: string, value: string): void;
  removeHeader(name: string): void;
}

export class FetchTransport implements Transport {
  private config: TransportConfig;
  private headers: Record<string, string>;

  constructor(config: TransportConfig) {
    this.config = config;
    this.headers = { ...config.headers };
  }

  setHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  removeHeader(name: string): void {
    delete this.headers[name];
  }

  private buildUrl(path: string, params?: Record<string, string | number | boolean | string[]>): string {
    const url = new URL(path, this.config.baseUrl);

    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) continue;

        if (Array.isArray(value)) {
          url.searchParams.set(key, value.join(","));
        } else {
          url.searchParams.set(key, String(value));
        }
      }
    }

    return url.toString();
  }

  async request<T>(req: TransportRequest): Promise<TransportResponse<T>> {
    const url = this.buildUrl(req.path, req.params);

    const controller = new AbortController();
    const timeoutId = this.config.timeout
      ? setTimeout(() => controller.abort(), this.config.timeout)
      : null;

    try {
      const response = await fetch(url, {
        method: req.method,
        headers: {
          "Content-Type": "application/json",
          ...this.headers,
          ...req.headers,
        },
        body: req.body ? JSON.stringify(req.body) : undefined,
        credentials: this.config.credentials,
        signal: controller.signal,
      });

      const data = await this.parseResponse<T>(response);

      if (!response.ok) {
        const errorData = data as unknown as ErrorResponse;
        throw new TransportError(
          errorData?.error?.message ?? `HTTP ${response.status}`,
          response.status,
          errorData?.error?.code ?? "HTTP_ERROR",
          errorData?.error?.details
        );
      }

      return {
        data,
        status: response.status,
        headers: response.headers,
      };
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  private async parseResponse<T>(response: Response): Promise<T> {
    const contentType = response.headers.get("content-type");

    if (contentType?.includes("application/json")) {
      return response.json();
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      return text as unknown as T;
    }
  }

  createEventSource(path: string, params?: Record<string, string>): EventSource {
    const url = this.buildUrl(path, params);

    return new EventSource(url, {
      withCredentials: this.config.credentials === "include",
    });
  }
}

export class TransportError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string,
    public details?: unknown
  ) {
    super(message);
    this.name = "TransportError";
  }

  isNotFound(): boolean {
    return this.status === 404;
  }

  isUnauthorized(): boolean {
    return this.status === 401;
  }

  isForbidden(): boolean {
    return this.status === 403;
  }

  isValidationError(): boolean {
    return this.status === 400;
  }

  isRateLimited(): boolean {
    return this.status === 429;
  }

  isServerError(): boolean {
    return this.status >= 500;
  }
}

export const createTransport = (config: TransportConfig): Transport => {
  return new FetchTransport(config);
};
