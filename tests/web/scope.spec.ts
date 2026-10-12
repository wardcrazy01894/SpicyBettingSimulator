import { describe, expect, it } from 'vitest';
import { betsEmptyTitle, scopeLabel, scopeLeague, scopeOptions } from '../../src/web/lib/scope.js';

describe('scopeOptions', () => {
  it('leads with All and then follows the config league order, labelled', () => {
    expect(scopeOptions(['nfl', 'ncaaf', 'mlb'])).toEqual([
      { value: 'all', label: 'All' },
      { value: 'nfl', label: 'NFL' },
      { value: 'ncaaf', label: 'NCAAF' },
      { value: 'mlb', label: 'MLB' },
    ]);
  });

  it('a league the server does not list is not offered', () => {
    expect(scopeOptions(['nfl']).map((o) => o.value)).toEqual(['all', 'nfl']);
  });
});

describe('scopeLeague', () => {
  it('is the ?league= value: absent for All, the league otherwise', () => {
    expect(scopeLeague('all')).toBeUndefined();
    expect(scopeLeague('mlb')).toBe('mlb');
  });
});

describe('scopeLabel', () => {
  it('names the sport, or "all sports"', () => {
    expect(scopeLabel('all')).toBe('all sports');
    expect(scopeLabel('ncaaf')).toBe('NCAAF');
  });
});

describe('betsEmptyTitle', () => {
  it('My Bets: names the sport only when one is selected', () => {
    expect(betsEmptyTitle('open', 'all', null)).toBe('No open bets.');
    expect(betsEmptyTitle('open', 'nfl', null)).toBe('No open NFL bets.');
    expect(betsEmptyTitle('settled', 'all', null)).toBe('Nothing settled yet.');
    expect(betsEmptyTitle('settled', 'mlb', null)).toBe('No settled MLB bets yet.');
  });

  it("a player's page says whose bets are missing", () => {
    expect(betsEmptyTitle('open', 'all', 'Tyler')).toBe('Tyler has no open bets.');
    expect(betsEmptyTitle('open', 'ncaaf', 'Tyler')).toBe('Tyler has no open NCAAF bets.');
    expect(betsEmptyTitle('settled', 'all', 'Tyler')).toBe('Tyler has nothing settled yet.');
    expect(betsEmptyTitle('settled', 'nfl', 'Tyler')).toBe('Tyler has no settled NFL bets yet.');
  });
});
