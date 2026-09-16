import { afterEach, describe, expect, it } from 'vitest';

import { parseOddsApi } from '../../src/shared/odds-api.js';
import {
  ODDS_API_STUB_BASE,
  buildOddsApiPayload,
  draftKingsLine,
  stubOddsApi,
} from './fixtures.js';
import type { OddsApiStub } from './fixtures.js';

/**
 * The Odds API fixtures land in M9a so M9c's sweep tests have them. This file
 * only proves the builder and the stub speak the shape `parseOddsApi` reads —
 * a fixture nothing exercises is a fixture that drifts.
 */

let stub: OddsApiStub | null = null;
afterEach(() => {
  stub?.restore();
  stub = null;
});

describe('Odds API fixtures', () => {
  it('buildOddsApiPayload round-trips through parseOddsApi with a DraftKings line', () => {
    const payload = buildOddsApiPayload([
      {
        id: 'e1',
        commenceTime: '2026-09-20T17:00:00Z',
        homeTeam: 'Tampa Bay Buccaneers',
        awayTeam: 'Dallas Cowboys',
      },
    ]);
    const parsed = parseOddsApi(payload, 'nfl');
    expect(parsed.warnings).toEqual([]);
    expect(parsed.events[0]).toMatchObject({
      eventId: 'e1',
      commenceAt: Date.parse('2026-09-20T17:00:00Z'),
      homeTeam: 'Tampa Bay Buccaneers',
      awayTeam: 'Dallas Cowboys',
      markets: {
        spread: {
          homeTenths: -35,
          homePrice: -110,
          awayTenths: 35,
          awayPrice: -110,
          book: 'draftkings',
        },
        total: { tenths: 475, overPrice: -110, underPrice: -110, book: 'draftkings' },
        moneyline: { homePrice: -180, awayPrice: 155, book: 'draftkings' },
      },
    });
  });

  it('draftKingsLine honours overrides and keeps the spread mirrored', () => {
    const line = draftKingsLine({
      homeTeam: 'H',
      awayTeam: 'A',
      spreadHome: 7.5,
      total: 53,
      mlHome: 260,
      mlAway: -320,
    });
    expect(line.spreads?.map((o) => o.point)).toEqual([-7.5, 7.5]);
    expect(line.totals?.map((o) => o.point)).toEqual([53, 53]);
    expect(line.h2h?.map((o) => o.price)).toEqual([-320, 260]);
  });

  it('stubOddsApi serves the configured sport with credit headers, [] for others, and the free probe', async () => {
    stub = stubOddsApi();
    stub.set(
      'americanfootball_nfl',
      [{ id: 'e1', commenceTime: '2026-09-20T17:00:00Z', homeTeam: 'H', awayTeam: 'A' }],
      { remaining: 400 },
    );
    const res = await fetch(`${ODDS_API_STUB_BASE}/v4/sports/americanfootball_nfl/odds?apiKey=k`, {
      headers: { accept: 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-requests-last')).toBe('3');
    expect(res.headers.get('x-requests-remaining')).toBe('400');
    expect(parseOddsApi(await res.json(), 'nfl').events).toHaveLength(1);

    const empty = await fetch(
      `${ODDS_API_STUB_BASE}/v4/sports/americanfootball_ncaaf/odds?apiKey=k`,
    );
    expect(await empty.json()).toEqual([]);

    const probe = await fetch(`${ODDS_API_STUB_BASE}/v4/sports?apiKey=k`);
    expect(probe.status).toBe(200);
    expect(probe.headers.get('x-requests-last')).toBe('0');
    expect(probe.headers.get('x-requests-remaining')).toBe('400');

    expect(stub.callCount).toBe(3);
    expect(stub.urls[0]).toContain('apiKey=k');
    expect(stub.requestHeaders[0]?.['accept']).toBe('application/json');
  });

  it('setResponder can make a sport 429 or throw, and restore() puts fetch back', async () => {
    const before = globalThis.fetch;
    stub = stubOddsApi();
    stub.setResponder('americanfootball_nfl', () => new Response('slow down', { status: 429 }));
    const res = await fetch(`${ODDS_API_STUB_BASE}/v4/sports/americanfootball_nfl/odds`);
    expect(res.status).toBe(429);
    stub.setResponder('americanfootball_nfl', () => {
      throw new TypeError('network down');
    });
    await expect(
      fetch(`${ODDS_API_STUB_BASE}/v4/sports/americanfootball_nfl/odds`),
    ).rejects.toThrow('network down');
    stub.restore();
    expect(globalThis.fetch).toBe(before);
    stub = null;
  });
});
