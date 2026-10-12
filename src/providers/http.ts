import { ProviderError } from './types.ts';

/** fetch wrapper: timeout, readable errors (never echoing the API key), retries on 429/5xx/network. */
export async function requestJson(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown; timeoutMs?: number; retries?: number },
): Promise<unknown> {
  const res = await request(url, init);
  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProviderError(`Expected JSON from ${redact(url)}, got: ${text.slice(0, 200)}`);
  }
}

export async function requestBytes(
  url: string,
  init: { headers?: Record<string, string>; timeoutMs?: number; retries?: number },
): Promise<Buffer> {
  const res = await request(url, init);
  return Buffer.from(await res.arrayBuffer());
}

async function request(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown; timeoutMs?: number; retries?: number },
): Promise<Response> {
  const retries = init.retries ?? 2;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, {
        method: init.method ?? 'GET',
        headers: { ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...init.headers },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(init.timeoutMs ?? 120_000),
      });
      if (res.ok) return res;
      const body = (await res.text()).slice(0, 800);
      const retryable = res.status === 429 || res.status >= 500;
      throw new ProviderError(`HTTP ${res.status} from ${redact(url)}: ${body}`, { retryable, status: res.status });
    } catch (err) {
      const providerErr =
        err instanceof ProviderError
          ? err
          : new ProviderError(`Request to ${redact(url)} failed: ${(err as Error).message}`, { retryable: true });
      if (!providerErr.retryable || attempt >= retries) throw providerErr;
      await sleep(1000 * 2 ** attempt + Math.random() * 500);
    }
  }
}

function redact(url: string): string {
  return url.replace(/([?&]key=)[^&]+/, '$1***');
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
