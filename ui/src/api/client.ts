/// <reference types="vite/client" />
/**
 * T01 — BaseApiClient
 *
 * Fetch-based HTTP client for React CSR.
 * - Uses `import.meta.env.VITE_API_GATEWAY_URL` (Vite, not Next.js)
 * - In dev: empty string → Vite proxy handles /api/* → localhost:7456
 * - In prod: absolute URL → CORS credentials: 'include'
 */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`HTTP ${status}: ${body}`);
    this.name = 'ApiError';
  }

  get isNotFound() {
    return this.status === 404;
  }

  get isUnauthorized() {
    return this.status === 401;
  }
}

/** Base URL — empty string in dev (Vite proxy), absolute URL in prod */
const DEFAULT_BASE_URL = import.meta.env.VITE_API_GATEWAY_URL ?? '';

export class BaseApiClient {
  protected readonly baseUrl: string;

  constructor(baseUrl: string = DEFAULT_BASE_URL) {
    this.baseUrl = baseUrl;
  }

  protected buildUrl(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  protected async request<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const res = await fetch(this.buildUrl(path), {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...init.headers,
      },
      credentials: 'include',
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new ApiError(res.status, body);
    }

    // 204 No Content
    if (res.status === 204) return undefined as T;

    return res.json() as Promise<T>;
  }

  protected async get<T>(path: string, init?: RequestInit): Promise<T> {
    return this.request<T>(path, { ...init, method: 'GET' });
  }

  protected async post<T>(
    path: string,
    body?: unknown,
    init?: RequestInit,
  ): Promise<T> {
    return this.request<T>(path, {
      ...init,
      method: 'POST',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  protected async patch<T>(
    path: string,
    body?: unknown,
    init?: RequestInit,
  ): Promise<T> {
    return this.request<T>(path, {
      ...init,
      method: 'PATCH',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  protected async put<T>(
    path: string,
    body?: unknown,
    init?: RequestInit,
  ): Promise<T> {
    return this.request<T>(path, {
      ...init,
      method: 'PUT',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  protected async del<T>(path: string, init?: RequestInit): Promise<T> {
    return this.request<T>(path, { ...init, method: 'DELETE' });
  }

  /**
   * SSE streaming via fetch() — not EventSource (allows custom headers).
   * Yields raw SSE event lines. Caller parses `event:` and `data:` fields.
   */
  protected async *streamSSE(
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): AsyncGenerator<{ event: string; data: string }> {
    const res = await fetch(this.buildUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'include',
      signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ApiError(res.status, text);
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        let event = 'message';
        for (const line of lines) {
          if (line.startsWith('event:')) {
            event = line.slice('event:'.length).trim();
          } else if (line.startsWith('data:')) {
            const data = line.slice('data:'.length).trim();
            yield { event, data };
            event = 'message';
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
