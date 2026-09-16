import { afterEach, describe, expect, it } from 'vitest';

import { ODDS_API_BOOKMAKERS } from '../../src/shared/constants.js';
import {
  ODDS_API_SPORT_KEY,
  ODDS_API_USER_AGENT,
  TheOddsApiProvider,
  buildOddsUrl,
  fetchCredits,
  readCredits,
  redactUrl,
} from '../../src/worker/odds-api.js';
import type { OddsApiConfig } from '../../src/worker/odds-api.js';
import { ODDS_API_STUB_BASE, stubOddsApi } from './fixtures.js';
import type { OddsApiStub } from './fixtures.js';

/** TDD contract for src/worker/odds-api.ts (M9c). PLAN.md §21.5 / §21.6. */

const CONFIG: OddsApiConfig = { apiKey: 'sekrit-key-123', baseUrl: ODDS_API_STUB_BASE };
const NOW = Date.parse('2026-09-18T20:00:00Z');
const WINDOW = { fromAt: NOW, toAt: NOW + 3 * 24 * 60 * 60 * 1000 };

let stub: OddsApiStub | null = null;

/** Narrow a result to its failure half, failing the test if it succeeded. */
function failed<T extends { readonly ok: boolean }>(res: T): Exclude<T, { readonly ok: true }> {
  if (res.ok) throw new Error('expected a failure result');
  return res as Exclude<T, { readonly ok: true }>;
}
afterEach(() => {
  stub?.restore();
  stub = null;
});

describe('buildOddsUrl / redactUrl', () => {
  it('asks for exactly our markets, our five books, american odds, ISO dates and the window', () => {
    const url = new URL(buildOddsUrl(CONFIG, 'ncaaf', WINDOW));
    expect(url.origin).toBe(ODDS_API_STUB_BASE);
    expect(url.pathname).toBe(`/v4/sports/${ODDS_API_SPORT_KEY.ncaaf}/odds`);
    expect(url.searchParams.get('apiKey')).toBe('sekrit-key-123');
    expect(url.searchParams.get('bookmakers')).toBe(ODDS_API_BOOKMAKERS.join(','));
    expect(url.searchParams.get('markets')?.split(',').sort()).toEqual([
      'h2h',
      'spreads',
      'totals',
    ]);
    expect(url.searchParams.get('oddsFormat')).toBe('american');
    expect(url.searchParams.get('dateFormat')).toBe('iso');
    // ISO seconds, UTC, no milliseconds (the API rejects fractional seconds).
    expect(url.searchParams.get('commenceTimeFrom')).toBe('2026-09-18T20:00:00Z');
    expect(url.searchParams.get('commenceTimeTo')).toBe('2026-09-21T20:00:00Z');
    expect(url.searchParams.has('regions')).toBe(false);
  });

  it('never carries the key once redacted, and redacts only the key', () => {
    const url = buildOddsUrl(CONFIG, 'nfl', WINDOW);
    expect(url).toContain('sekrit-key-123');
    const safe = redactUrl(url);
    expect(safe).not.toContain('sekrit-key-123');
    expect(safe).toContain('apiKey=REDACTED');
    expect(safe).toContain('markets=');
    expect(redactUrl('https://x.test/v4/sports?apiKey=abc')).toBe(
      'https://x.test/v4/sports?apiKey=REDACTED',
    );
    expect(redactUrl('not a url')).toBe('not a url');
  });
});

describe('readCredits', () => {
  it('reads the three headers as integers', () => {
    const h = new Headers({
      'x-requests-remaining': '497',
      'x-requests-used': '3',
      'x-requests-last': '3',
    });
    expect(readCredits(h)).toEqual({ remaining: 497, used: 3, last: 3 });
  });

  it('a missing or non-integer header is null, NEVER 0', () => {
    expect(readCredits(new Headers())).toEqual({ remaining: null, used: null, last: null });
    expect(readCredits(new Headers({ 'x-requests-remaining': 'lots' })).remaining).toBeNull();
    expect(readCredits(new Headers({ 'x-requests-remaining': '0' })).remaining).toBe(0);
    expect(readCredits(new Headers({ 'x-requests-remaining': '12.5' })).remaining).toBeNull();
  });
});

describe('TheOddsApiProvider.fetchOdds', () => {
  it('a 200 parses the events and reads the credits; sends our UA and accept header', async () => {
    stub = stubOddsApi();
    stub.set(
      'americanfootball_nfl',
      [{ id: 'e1', commenceTime: '2026-09-20T17:00:00Z', homeTeam: 'H', awayTeam: 'A' }],
      { last: 3, used: 9, remaining: 491 },
    );
    const res = await new TheOddsApiProvider(CONFIG).fetchOdds('nfl', WINDOW, NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.league).toBe('nfl');
    expect(res.events).toHaveLength(1);
    expect(res.events[0]?.markets.spread?.book).toBe('draftkings');
    expect(res.credits).toEqual({ remaining: 491, used: 9, last: 3 });
    expect(res.fetchedAt).toBe(NOW);
    expect(stub.requestHeaders[0]?.['user-agent']).toBe(ODDS_API_USER_AGENT);
    expect(stub.requestHeaders[0]?.['accept']).toBe('application/json');
    expect(stub.urls[0]).toContain('sekrit-key-123');
  });

  it('401 and 403 are `unauthorized`, with the credits still read and NO key in the error text', async () => {
    stub = stubOddsApi();
    for (const status of [401, 403]) {
      stub.setResponder(
        'americanfootball_nfl',
        () =>
          new Response('{"message":"Invalid api key"}', {
            status,
            headers: { 'x-requests-remaining': '400' },
          }),
      );
      const res = await new TheOddsApiProvider(CONFIG).fetchOdds('nfl', WINDOW, NOW);
      expect(res.ok).toBe(false);
      if (res.ok) continue;
      expect(res.kind).toBe('unauthorized');
      expect(res.status).toBe(status);
      expect(res.error).not.toContain('sekrit-key-123');
      expect(res.credits.remaining).toBe(400);
    }
  });

  it('429 is `rate_limited`; 5xx, a thrown fetch and a timeout are `unavailable`', async () => {
    stub = stubOddsApi();
    stub.setResponder('americanfootball_nfl', () => new Response('slow down', { status: 429 }));
    let res = await new TheOddsApiProvider(CONFIG).fetchOdds('nfl', WINDOW, NOW);
    expect(failed(res).kind).toBe('rate_limited');

    stub.setResponder('americanfootball_nfl', () => new Response('boom', { status: 503 }));
    res = await new TheOddsApiProvider(CONFIG).fetchOdds('nfl', WINDOW, NOW);
    expect(failed(res).kind).toBe('unavailable');
    expect(failed(res).status).toBe(503);

    stub.setResponder('americanfootball_nfl', () => {
      throw new TypeError(
        'fetch failed: getaddrinfo ENOTFOUND api.the-odds-api.com?apiKey=sekrit-key-123',
      );
    });
    res = await new TheOddsApiProvider(CONFIG).fetchOdds('nfl', WINDOW, NOW);
    expect(failed(res).kind).toBe('unavailable');
    expect(failed(res).status).toBeNull();
    expect(failed(res).error).not.toContain('sekrit-key-123');

    stub.setResponder('americanfootball_nfl', () => {
      const err = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      throw err;
    });
    res = await new TheOddsApiProvider(CONFIG).fetchOdds('nfl', WINDOW, NOW);
    expect(failed(res).kind).toBe('unavailable');
  });

  it('a 200 whose body is not JSON, or not an array, is `malformed`', async () => {
    stub = stubOddsApi();
    stub.setResponder(
      'americanfootball_nfl',
      () =>
        new Response('not json', {
          status: 200,
          headers: { 'content-type': 'application/json', 'x-requests-remaining': '9' },
        }),
    );
    let res = await new TheOddsApiProvider(CONFIG).fetchOdds('nfl', WINDOW, NOW);
    expect(failed(res).kind).toBe('malformed');
    expect(failed(res).credits.remaining).toBe(9);
    stub.setResponder(
      'americanfootball_nfl',
      () =>
        new Response('{"message":"x"}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    res = await new TheOddsApiProvider(CONFIG).fetchOdds('nfl', WINDOW, NOW);
    expect(failed(res).kind).toBe('malformed');
  });

  it('never throws out, whatever the stub does', async () => {
    stub = stubOddsApi();
    stub.setResponder('americanfootball_nfl', () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- the point is a non-Error throw
      throw 'a string, not an Error';
    });
    await expect(
      new TheOddsApiProvider(CONFIG).fetchOdds('nfl', WINDOW, NOW),
    ).resolves.toMatchObject({ ok: false });
  });
});

describe('fetchCredits — the FREE probe', () => {
  it('GET /v4/sports with the key only; reads the headers; costs 0', async () => {
    stub = stubOddsApi();
    stub.setCredits({ remaining: 123, used: 377 });
    const res = await fetchCredits(CONFIG, NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.credits).toEqual({ remaining: 123, used: 377, last: 0 });
    expect(res.fetchedAt).toBe(NOW);
    const url = new URL(stub.urls[0] ?? '');
    expect(url.pathname).toBe('/v4/sports');
    expect([...url.searchParams.keys()]).toEqual(['apiKey']);
  });

  it('a failing probe is a value: 401 → unauthorized, 503 → unavailable, thrown → unavailable', async () => {
    stub = stubOddsApi();
    stub.setProbe(() => new Response('nope', { status: 401 }));
    expect((await fetchCredits(CONFIG, NOW)).ok).toBe(false);
    const r1 = await fetchCredits(CONFIG, NOW);
    expect(failed(r1).kind).toBe('unauthorized');
    stub.setProbe(() => new Response('down', { status: 503 }));
    const r2 = await fetchCredits(CONFIG, NOW);
    expect(failed(r2).kind).toBe('unavailable');
    stub.setProbe(() => {
      throw new Error('network');
    });
    const r3 = await fetchCredits(CONFIG, NOW);
    expect(failed(r3).kind).toBe('unavailable');
  });
});
