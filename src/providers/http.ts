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
      // A 429 for "limit: 0" (free-tier key on a paid model) will never succeed, so don't retry it.
      const hardLimit = res.status === 429 && /limit: 0\b/.test(body);
      const retryable = (res.status === 429 && !hardLimit) || res.status >= 500;
      const hint = /free tier/i.test(body)
        ? ' (Your Gemini API key is on the free tier, which can\'t use this model. Turn on billing for the key in Google AI Studio.)'
        : '';
      throw new ProviderError(`${describe(url, res.status, body)}${hint}`, { retryable, status: res.status });
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

/**
 * A readable one-liner. Google errors are JSON ({ error: { message } }), so show just the message
 * plus which call failed, e.g. "Google rejected predictLongRunning (HTTP 400): …".
 */
function describe(url: string, status: number, body: string): string {
  const call = new URL(url).pathname.split('/').pop()?.split(':').pop() ?? 'request';
  try {
    const message = (JSON.parse(body) as { error?: { message?: unknown } }).error?.message;
    if (typeof message === 'string' && message) return `Google rejected ${call} (HTTP ${status}): ${message}`;
  } catch {
    // not JSON; fall through
  }
  return `HTTP ${status} from ${redact(url)}: ${body}`;
}

function redact(url: string): string {
  return url.replace(/([?&]key=)[^&]+/, '$1***');
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
