import { describe, it } from 'vitest';

/** TDD contract for src/shared/espn.ts (PLAN.md §8.3, M2c). */

describe('parseScoreboard — real NFL sample', () => {
  it.todo('parses 16 events with no warnings');
  it.todo('14 are scheduled and ALL 14 carry a DraftKings line');
  it.todo('2 are final and NEITHER carries a line (odds vanish at kickoff)');
  it.todo('season 2026, week 2, seasonType 2');
  it.todo('maps home/away, abbreviations, logos and scores');
});

describe('parseScoreboard — real CFB sample', () => {
  it.todo('parses 86 events');
  it.todo('16 in progress + 3 halftime map to in_progress');
  it.todo('65 final map to final');
  it.todo('only the 2 scheduled events produce a lines row');
  it.todo('curatedRank 1-25 is kept, 99 becomes null');
  it.todo('an FBS-vs-FCS game is ingested normally');
});

describe('mapEspnStatus', () => {
  it.todo("state 'pre' -> scheduled");
  it.todo("state 'in' -> in_progress");
  it.todo('STATUS_HALFTIME -> in_progress');
  it.todo("state 'post' + completed -> final");
  it.todo('STATUS_POSTPONED -> postponed');
  it.todo('STATUS_CANCELED -> canceled');
  it.todo('STATUS_FORFEIT -> canceled');
  it.todo('an unrecognised name -> unknown (never bettable, never graded)');
});

describe('parseLineToTenths', () => {
  it.todo('"-3.5" -> -35');
  it.todo('"+3.5" -> 35');
  it.todo('"o50.5" -> 505');
  it.todo('"u50.5" -> 505');
  it.todo('"PK" / "pk" / "EVEN" -> 0');
  it.todo('numbers pass through');
  it.todo('rejects |tenths| > MAX_ABS_LINE_TENTHS');
  it.todo('returns null on garbage instead of throwing');
});

describe('parseAmericanPrice', () => {
  it.todo('"-110" -> -110, "+164" -> 164');
  it.todo('"EVEN" -> 100');
  it.todo('rejects |price| < 100 and > 100000');
  it.todo('returns null on garbage');
});

describe('defensive behaviour', () => {
  it.todo('an event missing competitions is skipped with a warning, not thrown');
  it.todo('an event with one competitor is skipped with a warning');
  it.todo('a totally unexpected payload shape returns empty games + a warning');
  it.todo('a game with a spread but no moneyline yields a lines row with moneyline: null');
  it.todo('falls back to .open when .close is missing');
  it.todo('never parses the `details` display string ("CIN -3.5")');
  it.todo('prefers provider id 100, else the lowest priority');
});
