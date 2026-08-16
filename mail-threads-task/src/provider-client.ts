import type { ProviderPage } from "./types";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(ms: number): number {
  // +/- 20% jitter to avoid synchronized retry storms.
  const delta = ms * 0.2;
  return Math.max(0, ms - delta + Math.random() * delta * 2);
}

function parseRetryAfterMs(headerValue: string | null): number | null {
  if (!headerValue) return null;
  const asSeconds = Number(headerValue);
  if (Number.isFinite(asSeconds)) return Math.max(0, asSeconds * 1000);
  // Retry-After may also be an HTTP-date; fall back to that.
  const asDate = Date.parse(headerValue);
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
  return null;
}

export interface ProviderClientOptions {
  baseUrl: string;
  requestTimeoutMs?: number;
  maxBackoffMs?: number;
}

/**
 * Wraps GET /v1/messages with the resilience the feed explicitly requires:
 *  - 429 + Retry-After: wait exactly as told, then retry the same request.
 *  - 500 / 503: exponential backoff with jitter, retried indefinitely
 *    (the task requires the full feed to be drained no matter what).
 *  - hung connections: aborted via a timeout and treated like a transient error.
 *
 * A small adaptive delay is kept between requests: it grows whenever the
 * server pushes back (429) and slowly decays after a streak of clean
 * successes, so the crawl settles near the provider's real rate limit
 * instead of using either a fixed guess or no throttling at all.
 */
export class ProviderClient {
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly maxBackoffMs: number;

  // Adaptive pacing state.
  private minDelayMs = 0;
  private consecutiveSuccesses = 0;

  constructor(opts: ProviderClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 15_000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 30_000;
  }

  async fetchPage(cursor: string | null, limit: number): Promise<ProviderPage> {
    const url = new URL(`${this.baseUrl}/v1/messages`);
    if (cursor) url.searchParams.set("cursor", cursor);
    url.searchParams.set("limit", String(limit));

    let backoffMs = 500;

    for (;;) {
      if (this.minDelayMs > 0) await sleep(this.minDelayMs);

      let response: Response;
      try {
        response = await fetch(url, {
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });
      } catch (err) {
        // Network error, or the request timed out (hung connection).
        console.warn(`[provider] request failed (${(err as Error).message}), retrying in ${Math.round(backoffMs)}ms`);
        await sleep(jitter(backoffMs));
        backoffMs = Math.min(backoffMs * 2, this.maxBackoffMs);
        continue;
      }

      if (response.status === 429) {
        this.consecutiveSuccesses = 0;
        const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after")) ?? 2000;
        // Raise the floor so subsequent requests don't immediately re-trigger the limiter.
        this.minDelayMs = Math.max(this.minDelayMs, retryAfterMs);
        console.warn(`[provider] rate limited, waiting ${Math.round(retryAfterMs)}ms`);
        await sleep(retryAfterMs);
        continue; // retry the same page request
      }

      if (response.status === 500 || response.status === 503) {
        this.consecutiveSuccesses = 0;
        console.warn(`[provider] ${response.status}, retrying in ${Math.round(backoffMs)}ms`);
        await sleep(jitter(backoffMs));
        backoffMs = Math.min(backoffMs * 2, this.maxBackoffMs);
        continue;
      }

      if (!response.ok) {
        // Any other unexpected status: treat as transient too, since the spec
        // only promises well-behaved data once a 2xx is returned, and the
        // requirement is to keep going until the feed is fully drained.
        console.warn(`[provider] unexpected status ${response.status}, retrying in ${Math.round(backoffMs)}ms`);
        await sleep(jitter(backoffMs));
        backoffMs = Math.min(backoffMs * 2, this.maxBackoffMs);
        continue;
      }

      const page = (await response.json()) as ProviderPage;

      // Success: decay the adaptive delay slowly after a streak of clean calls.
      this.consecutiveSuccesses += 1;
      if (this.consecutiveSuccesses >= 5 && this.minDelayMs > 0) {
        this.minDelayMs = Math.max(0, this.minDelayMs * 0.7 - 5);
        this.consecutiveSuccesses = 0;
      }

      return page;
    }
  }
}
