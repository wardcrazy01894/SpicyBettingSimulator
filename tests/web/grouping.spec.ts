import { describe, expect, it } from 'vitest';

import {
  groupBetsByWeek,
  groupGamesByLocalDate,
  weeksFromGames,
} from '../../src/web/lib/grouping.js';
import { betView, gameCard, localMs } from './factories.js';

describe('groupGamesByLocalDate', () => {
  it('returns one group per local calendar day, ascending', () => {
    const groups = groupGamesByLocalDate([
      gameCard({ id: 'sun', kickoffAt: localMs(2026, 9, 13, 13) }),
      gameCard({ id: 'thu', kickoffAt: localMs(2026, 9, 10, 20) }),
      gameCard({ id: 'sun2', kickoffAt: localMs(2026, 9, 13, 16, 25) }),
    ]);
    expect(groups.map((g) => g.dateKey)).toEqual(['2026-09-10', '2026-09-13']);
    expect(groups[1]?.games.map((g) => g.id)).toEqual(['sun', 'sun2']);
  });

  it('sorts games inside a day by kickoff', () => {
    const groups = groupGamesByLocalDate([
      gameCard({ id: 'late', kickoffAt: localMs(2026, 9, 13, 20, 20) }),
      gameCard({ id: 'early', kickoffAt: localMs(2026, 9, 13, 13) }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.games.map((g) => g.id)).toEqual(['early', 'late']);
  });

  it('returns nothing for an empty slate rather than a phantom group', () => {
    expect(groupGamesByLocalDate([])).toEqual([]);
  });

  it('does not mutate the input array order', () => {
    const games = [
      gameCard({ id: 'b', kickoffAt: localMs(2026, 9, 13, 13) }),
      gameCard({ id: 'a', kickoffAt: localMs(2026, 9, 10, 20) }),
    ];
    groupGamesByLocalDate(games);
    expect(games.map((g) => g.id)).toEqual(['b', 'a']);
  });
});

describe('weeksFromGames', () => {
  it('is the distinct weeks present, ascending, plus anything asked for', () => {
    const games = [
      gameCard({ id: '1', week: 3 }),
      gameCard({ id: '2', week: 2 }),
      gameCard({ id: '3', week: 3 }),
      gameCard({ id: '4', week: null }),
    ];
    expect(weeksFromGames(games, 5, null)).toEqual([2, 3, 5]);
  });

  it('is empty when nothing carries a week', () => {
    expect(weeksFromGames([gameCard({ id: '1', week: null })], null)).toEqual([]);
  });
});

describe('groupBetsByWeek', () => {
  it('puts Thursday, Sunday and Monday bets of one week in one group', () => {
    const groups = groupBetsByWeek([
      betView({ id: 'thu', legs: [{ gameId: 'g1', kickoffAt: localMs(2026, 9, 10, 20) }] }),
      betView({ id: 'sun', legs: [{ gameId: 'g2', kickoffAt: localMs(2026, 9, 13, 13) }] }),
      betView({ id: 'mon', legs: [{ gameId: 'g3', kickoffAt: localMs(2026, 9, 14, 20) }] }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.bets).toHaveLength(3);
  });

  it('splits the next week into its own group, newest first', () => {
    const groups = groupBetsByWeek([
      betView({ id: 'w2', legs: [{ gameId: 'g1', kickoffAt: localMs(2026, 9, 13, 13) }] }),
      betView({ id: 'w3', legs: [{ gameId: 'g2', kickoffAt: localMs(2026, 9, 20, 13) }] }),
    ]);
    expect(groups.map((g) => g.bets[0]?.id)).toEqual(['w3', 'w2']);
  });

  it('never mixes leagues or seasons even inside the same week', () => {
    const kickoff = localMs(2026, 9, 12, 15);
    const groups = groupBetsByWeek([
      betView({ id: 'nfl', league: 'nfl', legs: [{ gameId: 'g1', kickoffAt: kickoff }] }),
      betView({ id: 'ncaaf', league: 'ncaaf', legs: [{ gameId: 'g2', kickoffAt: kickoff }] }),
      betView({ id: 'old', season: 2025, legs: [{ gameId: 'g3', kickoffAt: kickoff }] }),
    ]);
    expect(groups).toHaveLength(3);
    expect(new Set(groups.map((g) => g.key)).size).toBe(3);
  });

  it('buckets a parlay by its EARLIEST leg', () => {
    const groups = groupBetsByWeek([
      betView({
        id: 'parlay',
        legs: [
          { gameId: 'late', kickoffAt: localMs(2026, 9, 14, 20) },
          { gameId: 'early', kickoffAt: localMs(2026, 9, 10, 20) },
        ],
      }),
      betView({ id: 'thu', legs: [{ gameId: 'g1', kickoffAt: localMs(2026, 9, 10, 20) }] }),
    ]);
    expect(groups).toHaveLength(1);
  });

  it('labels the group with the league, season and the local date span', () => {
    const groups = groupBetsByWeek([
      betView({ id: 'a', legs: [{ gameId: 'g1', kickoffAt: localMs(2026, 9, 10, 20) }] }),
      betView({ id: 'b', legs: [{ gameId: 'g2', kickoffAt: localMs(2026, 9, 14, 20) }] }),
    ]);
    expect(groups[0]?.label).toContain('NFL 2026');
    expect(groups[0]?.label).toContain('–');
  });

  it('returns nothing for no bets', () => {
    expect(groupBetsByWeek([])).toEqual([]);
  });
});
