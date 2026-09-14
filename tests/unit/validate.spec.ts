import { describe, expect, it } from 'vitest';
import {
  RESERVED_USERNAME_PREFIX,
  formatCents,
  formatLineTenths,
  isCoherentMarketSide,
  parseDollarsToCents,
  validateBugReport,
  validateDerivedKeyHex,
  validateLogin,
  validatePlaceBet,
  validateSignup,
  validateUsername,
} from '../../src/shared/validate.js';
import type { PlaceBetInput } from '../../src/shared/validate.js';
import type { PlaceBetRequest } from '../../src/shared/api-types.js';
import {
  BUG_REPORT_DESCRIPTION_MAX,
  BUG_REPORT_PAGE_MAX,
  BUG_REPORT_TITLE_MAX,
  MAX_ABS_LINE_TENTHS,
  MAX_PARLAY_LEGS,
  MIN_STAKE_CENTS,
  TEASER_POINTS_TENTHS,
} from '../../src/shared/constants.js';

// Compile-time pin: a validated bet IS a wire request (PLAN §11.4). If the two
// shapes ever drift this file stops typechecking.
const asWireRequest = (v: PlaceBetInput): PlaceBetRequest => v;

/** TDD contract for src/shared/validate.ts (M2d). */

const DK = 'a'.repeat(64);

function ok<T>(r: { ok: boolean; value?: T }): T {
  expect(r.ok).toBe(true);
  return r.value as T;
}
function fail(r: { ok: boolean; message?: string; field?: string }): {
  message: string;
  field: string | undefined;
} {
  expect(r.ok).toBe(false);
  return { message: r.message ?? '', field: r.field };
}

describe('validateUsername', () => {
  it('lowercases and trims', () => {
    expect(ok(validateUsername('  AlexL_01 '))).toBe('alexl_01');
  });
  it('rejects < 3 and > 24 characters', () => {
    expect(validateUsername('ab').ok).toBe(false);
    expect(ok(validateUsername('abc'))).toBe('abc');
    expect(ok(validateUsername('a'.repeat(24)))).toBe('a'.repeat(24));
    expect(validateUsername('a'.repeat(25)).ok).toBe(false);
  });
  it('rejects characters outside [a-z0-9_]', () => {
    for (const bad of ['al ex', 'alex-1', 'alex.1', 'al€x', 'al\nex', 'ALEX!']) {
      expect(validateUsername(bad).ok).toBe(false);
    }
  });
  it('rejects non-strings', () => {
    for (const bad of [undefined, null, 42, {}, [], true]) {
      expect(validateUsername(bad).ok).toBe(false);
    }
  });

  /**
   * THE TOMBSTONE PREFIX IS RESERVED (`auth.ts` `deleteUser`, PLAN §10.5).
   *
   * `deleted_<12 hex of the account's uuid>` passes every rule above — it is
   * lowercase a-z0-9_ and 20 characters — and every authenticated user can read
   * every other user's uuid off `GET /api/leaderboard`. So without this rule a
   * squatter registers the exact tombstone of an account they want to protect,
   * and `DELETE /api/admin/users/:id` then loses to `UNIQUE(users.username)` for
   * good. This is the half of that collision that is reachable ON PURPOSE; the
   * retry in `deleteUser` covers the accidental half.
   */
  it('rejects the reserved `deleted_` tombstone prefix', () => {
    for (const reserved of [
      `${RESERVED_USERNAME_PREFIX}0123456789ab`,
      `${RESERVED_USERNAME_PREFIX}0123456789abcdef`,
      'deleted_x',
      'deleted_',
      'DELETED_0123456789AB', // lowercased first, so the check still bites
      '  deleted_abc  ', // ...and trimmed first
    ]) {
      const r = fail(validateUsername(reserved));
      expect(r.field).toBe('username');
      expect(r.message).toContain('that prefix is reserved');
    }
  });

  it('still accepts names that merely CONTAIN or resemble the prefix', () => {
    // The rule is a prefix rule, not a substring ban: nothing about `undeleted`
    // or `deletedz` can ever collide with a tombstone.
    expect(ok(validateUsername('undeleted_1'))).toBe('undeleted_1');
    expect(ok(validateUsername('deletedbob'))).toBe('deletedbob');
    expect(ok(validateUsername('my_deleted_acct'))).toBe('my_deleted_acct');
  });

  it('refuses the reserved prefix on signup AND login, with the same field', () => {
    const name = `${RESERVED_USERNAME_PREFIX}0123456789ab`;
    expect(fail(validateSignup({ username: name, dk: DK })).field).toBe('username');
    // Login too. It is a purely syntactic refusal — the answer is identical for
    // a tombstone that exists and one that never will — so it is no enumeration
    // oracle, and it stops a deleted account being probed by its new name.
    expect(fail(validateLogin({ username: name, dk: DK })).field).toBe('username');
  });
});

describe('validateDerivedKeyHex', () => {
  it('accepts exactly 64 lowercase hex characters', () => {
    expect(ok(validateDerivedKeyHex(DK))).toBe(DK);
    expect(ok(validateDerivedKeyHex('0123456789abcdef'.repeat(4)))).toHaveLength(64);
  });
  it('rejects uppercase, wrong length, and non-hex', () => {
    expect(validateDerivedKeyHex('A'.repeat(64)).ok).toBe(false);
    expect(validateDerivedKeyHex('a'.repeat(63)).ok).toBe(false);
    expect(validateDerivedKeyHex('a'.repeat(65)).ok).toBe(false);
    expect(validateDerivedKeyHex('g'.repeat(64)).ok).toBe(false);
    expect(validateDerivedKeyHex(` ${'a'.repeat(63)}`).ok).toBe(false);
    expect(validateDerivedKeyHex(123).ok).toBe(false);
  });
});

describe('validateSignup', () => {
  it('accepts a minimal body and defaults displayName to the username', () => {
    const v = ok(validateSignup({ username: 'Alex', dk: DK }));
    expect(v).toEqual({ username: 'alex', displayName: 'Alex', dk: DK, inviteCode: null });
  });
  it('trims displayName, caps it at 40 chars, and passes inviteCode through', () => {
    const v = ok(
      validateSignup({ username: 'alex', displayName: '  Big Al  ', dk: DK, inviteCode: 'x' }),
    );
    expect(v.displayName).toBe('Big Al');
    expect(v.inviteCode).toBe('x');
    expect(validateSignup({ username: 'alex', displayName: 'x'.repeat(41), dk: DK }).ok).toBe(
      false,
    );
  });
  it('treats an all-whitespace displayName as absent and an empty inviteCode as null', () => {
    const v = ok(
      validateSignup({ username: 'alex', displayName: '   ', dk: DK, inviteCode: '  ' }),
    );
    expect(v.displayName).toBe('alex');
    expect(v.inviteCode).toBeNull();
  });
  it('rejects control, bidi-override and zero-width characters in displayName', () => {
    for (const bad of ['a\u202eb', '\u0000bad', 'zero\u200bwidth', 'tab\tname', 'nl\nname']) {
      expect(fail(validateSignup({ username: 'alex', displayName: bad, dk: DK })).field).toBe(
        'displayName',
      );
    }
  });
  it('allows ZWJ-composed emoji and variation selectors, rejects line separators', () => {
    for (const good of ['👩‍💻 Alex', '👨‍👩‍👧 fam', '🏳️‍🌈', '❤️ Al']) {
      expect(validateSignup({ username: 'alex', displayName: good, dk: DK }).ok).toBe(true);
    }
    for (const bad of ['a\u2028b', 'a\u2029b']) {
      expect(fail(validateSignup({ username: 'alex', displayName: bad, dk: DK })).field).toBe(
        'displayName',
      );
    }
  });
  it('counts displayName length in code points, not UTF-16 units', () => {
    expect(validateSignup({ username: 'alex', displayName: '😀'.repeat(40), dk: DK }).ok).toBe(
      true,
    );
    expect(validateSignup({ username: 'alex', displayName: '😀'.repeat(41), dk: DK }).ok).toBe(
      false,
    );
  });
  it('rejects a non-object body and reports the offending field', () => {
    expect(validateSignup(null).ok).toBe(false);
    expect(validateSignup('x').ok).toBe(false);
    expect(fail(validateSignup({ username: 'a', dk: DK })).field).toBe('username');
    expect(fail(validateSignup({ username: 'alex', dk: 'nope' })).field).toBe('dk');
    expect(fail(validateSignup({ username: 'alex', dk: DK, inviteCode: 7 })).field).toBe(
      'inviteCode',
    );
  });
});

describe('validateLogin', () => {
  it('accepts username + dk', () => {
    expect(ok(validateLogin({ username: 'Alex', dk: DK }))).toEqual({ username: 'alex', dk: DK });
  });
  it('rejects a missing dk', () => {
    expect(fail(validateLogin({ username: 'alex' })).field).toBe('dk');
  });
});

describe('isCoherentMarketSide', () => {
  it('total <=> over/under; moneyline/spread <=> home/away', () => {
    expect(isCoherentMarketSide('total', 'over')).toBe(true);
    expect(isCoherentMarketSide('total', 'under')).toBe(true);
    expect(isCoherentMarketSide('total', 'home')).toBe(false);
    expect(isCoherentMarketSide('moneyline', 'home')).toBe(true);
    expect(isCoherentMarketSide('spread', 'away')).toBe(true);
    expect(isCoherentMarketSide('moneyline', 'over')).toBe(false);
    expect(isCoherentMarketSide('spread', 'under')).toBe(false);
  });
});

describe('validatePlaceBet', () => {
  const leg = (gameId: string, market = 'spread', side = 'home') => ({ gameId, market, side });
  const straight = (over: Record<string, unknown> = {}) => ({
    league: 'nfl',
    betType: 'straight',
    stakeCents: 2500,
    legs: [leg('g1')],
    ...over,
  });

  it('accepts a valid straight and defaults acceptLineChange to false', () => {
    const v = ok(validatePlaceBet(straight()));
    expect(asWireRequest(v)).toBe(v);
    expect(v).toEqual({
      league: 'nfl',
      betType: 'straight',
      stakeCents: 2500,
      acceptLineChange: false,
      legs: [{ gameId: 'g1', market: 'spread', side: 'home' }],
    });
  });
  it('rejects a stake below MIN_STAKE_CENTS', () => {
    expect(fail(validatePlaceBet(straight({ stakeCents: MIN_STAKE_CENTS - 1 }))).field).toBe(
      'stakeCents',
    );
    expect(validatePlaceBet(straight({ stakeCents: MIN_STAKE_CENTS })).ok).toBe(true);
  });
  it('rejects a non-integer or unsafe stake', () => {
    for (const bad of [25.5, -100, NaN, Infinity, '2500', 2 ** 53, null]) {
      expect(fail(validatePlaceBet(straight({ stakeCents: bad }))).field).toBe('stakeCents');
    }
  });
  it('rejects an unknown league or betType', () => {
    expect(fail(validatePlaceBet(straight({ league: 'nba' }))).field).toBe('league');
    expect(fail(validatePlaceBet(straight({ betType: 'round-robin' }))).field).toBe('betType');
  });
  it("accepts league 'mixed' on the wire (M5b: the server re-derives it anyway)", () => {
    expect(ok(validatePlaceBet(straight({ league: 'mixed' }))).league).toBe('mixed');
  });
  it('straight must have exactly 1 leg', () => {
    expect(fail(validatePlaceBet(straight({ legs: [] }))).field).toBe('legs');
    expect(fail(validatePlaceBet(straight({ legs: [leg('g1'), leg('g2')] }))).field).toBe('legs');
  });
  it('parlay must have 2..10 legs', () => {
    expect(fail(validatePlaceBet(straight({ betType: 'parlay', legs: [leg('g1')] }))).field).toBe(
      'legs',
    );
    const two = validatePlaceBet(straight({ betType: 'parlay', legs: [leg('g1'), leg('g2')] }));
    expect(two.ok).toBe(true);
    const ten = Array.from({ length: MAX_PARLAY_LEGS }, (_, i) => leg(`g${String(i)}`));
    expect(validatePlaceBet(straight({ betType: 'parlay', legs: ten })).ok).toBe(true);
  });
  it('rejects 11 legs', () => {
    const eleven = Array.from({ length: 11 }, (_, i) => leg(`g${String(i)}`));
    expect(fail(validatePlaceBet(straight({ betType: 'parlay', legs: eleven }))).field).toBe(
      'legs',
    );
  });
  it('rejects two legs on the same gameId (correlated parlay)', () => {
    const r = fail(
      validatePlaceBet(
        straight({ betType: 'parlay', legs: [leg('g1', 'spread'), leg('g1', 'total', 'over')] }),
      ),
    );
    expect(r.field).toBe('legs[1].gameId');
  });
  it('rejects market=total with side=home', () => {
    expect(fail(validatePlaceBet(straight({ legs: [leg('g1', 'total', 'home')] }))).field).toBe(
      'legs[0].side',
    );
  });
  it('rejects market=moneyline with side=over', () => {
    expect(fail(validatePlaceBet(straight({ legs: [leg('g1', 'moneyline', 'over')] }))).field).toBe(
      'legs[0].side',
    );
  });
  it('rejects an empty or non-string gameId and unknown market/side', () => {
    expect(fail(validatePlaceBet(straight({ legs: [leg('')] }))).field).toBe('legs[0].gameId');
    expect(
      fail(validatePlaceBet(straight({ legs: [{ gameId: 1, market: 'spread', side: 'home' }] })))
        .field,
    ).toBe('legs[0].gameId');
    expect(fail(validatePlaceBet(straight({ legs: [leg('g1', 'props')] }))).field).toBe(
      'legs[0].market',
    );
    expect(fail(validatePlaceBet(straight({ legs: [leg('g1', 'spread', 'left')] }))).field).toBe(
      'legs[0].side',
    );
  });
  it('rejects legs that are not an array, and legs that are not objects', () => {
    expect(fail(validatePlaceBet(straight({ betType: 'parlay', legs: {} }))).field).toBe('legs');
    expect(fail(validatePlaceBet(straight({ legs: 'g1' }))).field).toBe('legs');
    expect(fail(validatePlaceBet(straight({ legs: ['g1'] }))).field).toBe('legs[0]');
    expect(fail(validatePlaceBet(straight({ legs: [null] }))).field).toBe('legs[0]');
  });
  it('rejects a moneyline expected block that carries a line (mirrors the DB CHECK)', () => {
    expect(
      fail(
        validatePlaceBet(
          straight({
            legs: [
              { ...leg('g1', 'moneyline'), expected: { americanPrice: -150, lineTenths: -35 } },
            ],
          }),
        ),
      ).field,
    ).toBe('legs[0].expected.lineTenths');
  });
  it('bounds expected.lineTenths by MAX_ABS_LINE_TENTHS', () => {
    const at = validatePlaceBet(
      straight({
        legs: [
          { ...leg('g1'), expected: { americanPrice: -110, lineTenths: -MAX_ABS_LINE_TENTHS } },
        ],
      }),
    );
    expect(at.ok).toBe(true);
    expect(
      fail(
        validatePlaceBet(
          straight({
            legs: [
              {
                ...leg('g1'),
                expected: { americanPrice: -110, lineTenths: MAX_ABS_LINE_TENTHS + 1 },
              },
            ],
          }),
        ),
      ).field,
    ).toBe('legs[0].expected.lineTenths');
  });
  it('treats acceptLineChange: null like absent (consistent with inviteCode)', () => {
    expect(ok(validatePlaceBet(straight({ acceptLineChange: null }))).acceptLineChange).toBe(false);
  });
  it('validates the optional expected block per leg', () => {
    const good = validatePlaceBet(
      straight({ legs: [{ ...leg('g1'), expected: { americanPrice: -110, lineTenths: -35 } }] }),
    );
    expect(ok(good).legs[0]?.expected).toEqual({ americanPrice: -110, lineTenths: -35 });
    const ml = validatePlaceBet(
      straight({
        legs: [{ ...leg('g1', 'moneyline'), expected: { americanPrice: 164, lineTenths: null } }],
      }),
    );
    expect(ml.ok).toBe(true);
    expect(
      fail(
        validatePlaceBet(
          straight({ legs: [{ ...leg('g1'), expected: { americanPrice: -50, lineTenths: -35 } }] }),
        ),
      ).field,
    ).toBe('legs[0].expected.americanPrice');
    expect(
      fail(
        validatePlaceBet(
          straight({
            legs: [{ ...leg('g1'), expected: { americanPrice: -110, lineTenths: 3.5 } }],
          }),
        ),
      ).field,
    ).toBe('legs[0].expected.lineTenths');
    expect(
      fail(validatePlaceBet(straight({ legs: [{ ...leg('g1'), expected: 'x' }] }))).field,
    ).toBe('legs[0].expected');
  });
  it('accepts a valid 3-leg parlay', () => {
    const v = ok(
      validatePlaceBet({
        league: 'ncaaf',
        betType: 'parlay',
        stakeCents: 1000,
        acceptLineChange: true,
        legs: [
          leg('a', 'spread', 'away'),
          leg('b', 'total', 'under'),
          leg('c', 'moneyline', 'home'),
        ],
      }),
    );
    expect(v.legs).toHaveLength(3);
    expect(v.acceptLineChange).toBe(true);
  });
  it('ignores unknown top-level keys but rejects a non-boolean acceptLineChange', () => {
    expect(validatePlaceBet(straight({ extra: 1 })).ok).toBe(true);
    expect(fail(validatePlaceBet(straight({ acceptLineChange: 'yes' }))).field).toBe(
      'acceptLineChange',
    );
  });
  it('accepts an optional bankrollId and rejects an empty or non-string one', () => {
    expect(ok(validatePlaceBet(straight({ bankrollId: 'bk-1' }))).bankrollId).toBe('bk-1');
    // Absent means "my main balance"; the KEY is absent, not undefined-valued.
    expect('bankrollId' in ok(validatePlaceBet(straight()))).toBe(false);
    expect(fail(validatePlaceBet(straight({ bankrollId: '' }))).field).toBe('bankrollId');
    expect(fail(validatePlaceBet(straight({ bankrollId: 7 }))).field).toBe('bankrollId');
  });
});

// ---------------------------------------------------------------------------
// Teasers (M5b). PLAN.md §5.8.
// ---------------------------------------------------------------------------

describe('validatePlaceBet — teasers', () => {
  const leg = (gameId: string, market = 'spread', side = 'home') => ({ gameId, market, side });
  const teaser = (over: Record<string, unknown> = {}) => ({
    league: 'nfl',
    betType: 'teaser',
    teaserPoints: 60,
    stakeCents: 1000,
    legs: [leg('g1'), leg('g2', 'total', 'over')],
    ...over,
  });

  it('accepts a 2-leg 6-point teaser mixing a spread and a total', () => {
    const v = ok(validatePlaceBet(teaser()));
    expect(v.betType).toBe('teaser');
    expect(v.teaserPoints).toBe(60);
    expect(v.legs).toHaveLength(2);
  });

  it('accepts every tier on the card and nothing else', () => {
    for (const points of TEASER_POINTS_TENTHS) {
      expect(ok(validatePlaceBet(teaser({ teaserPoints: points }))).teaserPoints).toBe(points);
    }
    // 6 points expressed as POINTS rather than tenths is the obvious client bug,
    // and it must be refused rather than silently teasing by 0.6 of a point.
    for (const bad of [6, 6.5, 7, 0, 55, 75, '60', null, true]) {
      expect(fail(validatePlaceBet(teaser({ teaserPoints: bad }))).field).toBe('teaserPoints');
    }
  });

  it('requires teaserPoints on a teaser and forbids it on anything else', () => {
    expect(fail(validatePlaceBet(teaser({ teaserPoints: undefined }))).field).toBe('teaserPoints');
    expect(
      fail(
        validatePlaceBet({
          league: 'nfl',
          betType: 'parlay',
          teaserPoints: 60,
          stakeCents: 1000,
          legs: [leg('g1'), leg('g2')],
        }),
      ).field,
    ).toBe('teaserPoints');
    expect(fail(validatePlaceBet(straightWithPoints())).field).toBe('teaserPoints');
  });

  function straightWithPoints(): Record<string, unknown> {
    return {
      league: 'nfl',
      betType: 'straight',
      teaserPoints: 70,
      stakeCents: 1000,
      legs: [leg('g1')],
    };
  }

  it('rejects a moneyline leg, naming the offending leg’s market', () => {
    const r = fail(validatePlaceBet(teaser({ legs: [leg('g1'), leg('g2', 'moneyline', 'away')] })));
    expect(r.field).toBe('legs[1].market');
    expect(r.message).toMatch(/spread or a total/);
  });

  it('requires 2..10 legs, like a parlay', () => {
    expect(fail(validatePlaceBet(teaser({ legs: [leg('g1')] }))).field).toBe('legs');
    expect(fail(validatePlaceBet(teaser({ legs: [] }))).field).toBe('legs');
    const ten = Array.from({ length: MAX_PARLAY_LEGS }, (_, i) => leg(`g${String(i)}`));
    expect(validatePlaceBet(teaser({ legs: ten })).ok).toBe(true);
    expect(fail(validatePlaceBet(teaser({ legs: [...ten, leg('g-extra')] }))).field).toBe('legs');
  });

  it('still refuses two legs from the same game', () => {
    expect(
      fail(validatePlaceBet(teaser({ legs: [leg('g1'), leg('g1', 'total', 'over')] }))).field,
    ).toBe('legs[1].gameId');
  });

  it('does NOT care which league the legs are in — cross-league teasers are legal', () => {
    // The wire `league` is advisory; the server labels the bet from the games.
    expect(validatePlaceBet(teaser({ league: 'mixed' })).ok).toBe(true);
    expect(validatePlaceBet(teaser({ league: 'ncaaf' })).ok).toBe(true);
  });
});

describe('parseDollarsToCents', () => {
  it('"12.34" -> 1234', () => {
    expect(ok(parseDollarsToCents('12.34'))).toBe(1234);
  });
  it('"12" -> 1200', () => {
    expect(ok(parseDollarsToCents('12'))).toBe(1200);
  });
  it('".5" -> 50', () => {
    expect(ok(parseDollarsToCents('.5'))).toBe(50);
  });
  it('"12." -> 1200', () => {
    expect(ok(parseDollarsToCents('12.'))).toBe(1200);
  });
  it('"1,000" -> 100000', () => {
    expect(ok(parseDollarsToCents('1,000'))).toBe(100000);
  });
  it('"$5" -> 500', () => {
    expect(ok(parseDollarsToCents('$5'))).toBe(500);
  });
  it('"0.07" -> 7 and "1.1" -> 110 (no float rounding)', () => {
    expect(ok(parseDollarsToCents('0.07'))).toBe(7);
    expect(ok(parseDollarsToCents('1.1'))).toBe(110);
    expect(ok(parseDollarsToCents('19.99'))).toBe(1999);
    expect(ok(parseDollarsToCents(' $ 1,234.56 '))).toBe(123456);
  });
  it('rejects "12.345" (three decimal places)', () => {
    expect(parseDollarsToCents('12.345').ok).toBe(false);
  });
  it('rejects negatives and NaN', () => {
    for (const bad of ['-5', 'abc', '', '.', '$', '1e3', '1.2.3', '1,00', '--1', '5-']) {
      expect(parseDollarsToCents(bad).ok).toBe(false);
    }
  });
  it('rejects amounts beyond MAX_SAFE_INTEGER cents', () => {
    expect(parseDollarsToCents('90071992547409.92').ok).toBe(false);
    expect(parseDollarsToCents('90071992547409.91').ok).toBe(true);
  });
});

describe('formatters', () => {
  it('formatCents(123456) -> "$1,234.56"', () => {
    expect(formatCents(123456)).toBe('$1,234.56');
  });
  it('formats zero, small, and negative amounts', () => {
    expect(formatCents(0)).toBe('$0.00');
    expect(formatCents(7)).toBe('$0.07');
    expect(formatCents(100000)).toBe('$1,000.00');
    expect(formatCents(-2500)).toBe('-$25.00');
    expect(formatCents(100000000)).toBe('$1,000,000.00');
  });
  it('formatLineTenths(-35, true) -> "-3.5"', () => {
    expect(formatLineTenths(-35, true)).toBe('-3.5');
  });
  it('formatLineTenths(35, true) -> "+3.5"', () => {
    expect(formatLineTenths(35, true)).toBe('+3.5');
  });
  it('formatLineTenths(505, false) -> "50.5"', () => {
    expect(formatLineTenths(505, false)).toBe('50.5');
  });
  it('whole numbers and pick-em', () => {
    expect(formatLineTenths(-70, true)).toBe('-7');
    expect(formatLineTenths(0, true)).toBe('PK');
    expect(formatLineTenths(0, false)).toBe('0');
    expect(formatLineTenths(440, false)).toBe('44');
  });
});

describe('validateBugReport', () => {
  const ok = { title: 'Slip stuck open', description: 'Tapped close and it stayed put.' };

  it('accepts a title + description and normalises a missing page to null', () => {
    const r = validateBugReport(ok);
    expect(r).toEqual({ ok: true, value: { ...ok, page: null } });
  });

  it('trims and keeps a path-shaped page', () => {
    const r = validateBugReport({
      title: '  t i t l e  ',
      description: `  ${ok.description}  `,
      page: ' /bets ',
    });
    expect(r).toEqual({
      ok: true,
      value: { title: 't i t l e', description: ok.description, page: '/bets' },
    });
  });

  it('treats an empty or null page as absent', () => {
    expect(validateBugReport({ ...ok, page: '' })).toMatchObject({
      ok: true,
      value: { page: null },
    });
    expect(validateBugReport({ ...ok, page: null })).toMatchObject({
      ok: true,
      value: { page: null },
    });
  });

  it.each([
    ['non-object', 'nope', undefined],
    ['missing title', { description: ok.description }, 'title'],
    ['title of spaces', { ...ok, title: '    ' }, 'title'],
    ['title too short', { ...ok, title: 'ab' }, 'title'],
    ['title too long', { ...ok, title: 'x'.repeat(BUG_REPORT_TITLE_MAX + 1) }, 'title'],
    ['title with a newline', { ...ok, title: 'one\ntwo' }, 'title'],
    ['missing description', { title: ok.title }, 'description'],
    ['description too short', { ...ok, description: 'short' }, 'description'],
    [
      'description too long',
      { ...ok, description: 'x'.repeat(BUG_REPORT_DESCRIPTION_MAX + 1) },
      'description',
    ],
    ['page not a string', { ...ok, page: 3 }, 'page'],
    ['page is a URL', { ...ok, page: 'https://evil.example/x' }, 'page'],
    ['page is protocol-relative', { ...ok, page: '//evil.example' }, 'page'],
    ['page with whitespace', { ...ok, page: '/bets and stuff' }, 'page'],
    ['page with a backtick', { ...ok, page: '/bets`@x' }, 'page'],
    ['page too long', { ...ok, page: `/${'p'.repeat(BUG_REPORT_PAGE_MAX)}` }, 'page'],
  ])('rejects %s', (_label, body, field) => {
    const r = validateBugReport(body);
    expect(r.ok).toBe(false);
    if (!r.ok && field !== undefined) expect(r.field).toBe(field);
  });

  it('accepts the exact maximum lengths', () => {
    const r = validateBugReport({
      title: 't'.repeat(BUG_REPORT_TITLE_MAX),
      description: 'd'.repeat(BUG_REPORT_DESCRIPTION_MAX),
      page: `/${'p'.repeat(BUG_REPORT_PAGE_MAX - 1)}`,
    });
    expect(r.ok).toBe(true);
  });
});
