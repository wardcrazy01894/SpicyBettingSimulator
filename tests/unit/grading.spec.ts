import { describe, it } from 'vitest';

/** TDD contract for src/shared/grading.ts (PLAN.md §7.3, M2b). */

describe('gradeSpread', () => {
  it.todo('home -3.5 wins when the home team wins by 4');
  it.todo('home -3.5 loses when the home team wins by 3');
  it.todo('away +3.5 wins when the away team loses by 3');
  it.todo('home -3 PUSHES on an exact 3-point win (integer tenths, exact === 0)');
  it.todo('PK (line 0) pushes on a tie');
  it.todo('works for a 30.5-point CFB spread');
});

describe('gradeTotal', () => {
  it.todo('over 50.5 wins at 28-24 (52)');
  it.todo('under 50.5 wins at 24-24 (48)');
  it.todo('over 48 PUSHES at 24-24');
  it.todo('under 48 PUSHES at 24-24');
});

describe('gradeMoneyline', () => {
  it.todo('higher score wins');
  it.todo('lower score loses');
  it.todo('equal scores PUSH (NFL games can tie)');
});

describe('gradeLeg', () => {
  it.todo("game 'canceled' -> 'void' regardless of score");
  it.todo("game 'postponed' -> 'pending' (it may still be played)");
  it.todo("game 'in_progress' -> 'pending'");
  it.todo("game 'unknown' -> 'pending' (never guess)");
  it.todo("final with a null score -> 'pending' and does not throw");
  it.todo("final with a non-integer score -> 'pending'");
});

describe('gradeBet', () => {
  it.todo('straight win pays floor(stake * price)');
  it.todo('straight loss pays 0');
  it.todo('straight push returns the stake exactly');
  it.todo('parlay with ANY pending leg stays pending and returns no leg results');
  it.todo('parlay with a loss AND pushes LOSES (loss is evaluated before push removal)');
  it.todo('parlay with one pushed leg re-prices from the remaining legs');
  it.todo('parlay where every leg pushes returns the stake and status push');
  it.todo('parlay where every leg voids returns the stake and status void');
  it.todo('mixed push + void with no winners -> push (void only when ALL legs voided)');
  it.todo('effectivePrice excludes pushed and voided legs');
});
