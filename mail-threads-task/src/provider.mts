import type { ProviderPage } from './types.mts';

const LIMIT = 200;
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 12_000);
const MAX_BACKOFF_MS = 5_000;

let learnedSpacingMs = 0;
let nextRequestNotBefore = 0;

class RetryableProviderError extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const at = Date.parse(value);
  if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  return null;
}

function backoffMs(attempt: number): number {
  const base = Math.min(MAX_BACKOFF_MS, 250 * 2 ** Math.min(attempt, 5));
  return base + Math.floor(Math.random() * 200);
}

function validatePage(value: unknown): ProviderPage {
  if (!value || typeof value !== 'object') throw new RetryableProviderError('response is not an object');
  const page = value as Record<string, unknown>;
  if (!Array.isArray(page.items)) throw new RetryableProviderError('response.items is not an array');
  if (!(page.next_cursor === null || typeof page.next_cursor === 'string')) {
    throw new RetryableProviderError('response.next_cursor has invalid type');
  }
  return page as ProviderPage;
}

async function respectPacing(): Promise<void> {
  const wait = nextRequestNotBefore - Date.now();
  if (wait > 0) await sleep(wait);
}

export async function fetchPage(providerUrl: string, cursor: string | null): Promise<ProviderPage> {
  let attempt = 0;

  for (;;) {
    await respectPacing();
    const url = new URL('/v1/messages', providerUrl);
    url.searchParams.set('limit', String(LIMIT));
    if (cursor !== null) url.searchParams.set('cursor', cursor);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, { signal: controller.signal });
      if (response.status === 429) {
        const waitMs = retryAfterMs(response.headers.get('retry-after')) ?? backoffMs(attempt);
        learnedSpacingMs = Math.max(learnedSpacingMs, waitMs + 25);
        nextRequestNotBefore = Date.now() + learnedSpacingMs;
        await response.body?.cancel();
        console.warn(`[provider] 429, retrying in ${waitMs} ms`);
        attempt++;
        continue;
      }

      if (response.status === 500 || response.status === 503) {
        await response.body?.cancel();
        throw new RetryableProviderError(`HTTP ${response.status}`);
      }
      if (!response.ok) {
        throw new Error(`Provider returned non-retryable HTTP ${response.status}`);
      }

      const body = await response.json();
      const page = validatePage(body);
      if (learnedSpacingMs > 0) nextRequestNotBefore = Date.now() + learnedSpacingMs;
      return page;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Provider returned non-retryable')) {
        throw error;
      }
      const waitMs = backoffMs(attempt);
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[provider] ${reason}; retrying in ${waitMs} ms`);
      await sleep(waitMs);
      attempt++;
    } finally {
      clearTimeout(timer);
    }
  }
}
