/**
 * Migration 0009 widens `CHECK (league IN (...))` on `games`, `bets`,
 * `bet_legs` and `ingest_targets` to admit `'mlb'` (PLAN.md §23.3). D1 cannot
 * alter a CHECK, so it is a CHILDREN-FIRST rebuild of six tables in the style
 * of 0005: ledger → bet_legs → bets → game_lines → games, plus ingest_targets.
 *
 * THE FILE DOES NOT EXIST YET and must not until M12a: the Deploy workflow
 * applies whatever is under `migrations/` on merge, so a file landing ahead of
 * the code that writes `'mlb'` rows is an untested production schema change
 * (CLAUDE.md rule 9). These are its contracts, written first. When M12a lands
 * the file, this spec follows migration-0005.spec.ts: seed through the real
 * triggers and HTTP, RE-RUN 0009's statements as one batch, compare.
 */
import { describe, it } from 'vitest';

describe('migration 0009 (league CHECK rebuild) — M12a', () => {
  describe('lossless on a populated database', () => {
    it.todo(
      'seeds: NFL + CFB games with DraftKings AND odds-api line rows, a won and a lost bet, a ' +
        'pending teaser and a same-game parlay placed over HTTP, and ingest_targets rows with ' +
        'non-zero consecutive_failures / next_run_at / last_run_at',
    );
    it.todo('every row of games, game_lines, bets, bet_legs, ledger, ingest_targets is deep-equal');
    it.todo(
      'row COUNTS of game_lines and bet_legs are equal before and after — the proof that ' +
        'dropping games fired no ON DELETE CASCADE into game_lines (it was dropped first)',
    );
    it.todo(
      'every bankroll balance_cents is unchanged — the assertion that FAILS if the ledger copy ' +
        'ran with ledger_ai_apply live (it would double every balance)',
    );
    it.todo('SUM(ledger.amount_cents) = balance_cents for every bankroll');
    it.todo('PRAGMA foreign_key_check returns no rows');
    it.todo(
      'pragma_table_info (name, type, notnull, dflt_value, pk) is identical for all six tables, ' +
        'including the ALTERed columns (0004 conference ids, 0007 *_book and secondary_tried_at) ' +
        'in their original physical order',
    );
  });

  describe('schema objects come back byte-identical', () => {
    it.todo(
      'every trigger by name AND sqlite_master.sql text: ledger_bi_bankroll_exists, ' +
        'ledger_bi_sufficient_funds, ledger_ai_apply, ledger_bu_block, ledger_bd_block, ' +
        'bet_legs_bi_one_side_per_game, bankrolls_bu_balance_guard, bankrolls_bi_balance_guard',
    );
    it.todo(
      'every index by name AND sql text: idx_games_board/status/week, idx_bets_user/bankroll/' +
        'pending, idx_bet_legs_bet/game, idx_ledger_bankroll/sum/bet, idx_ingest_targets_due',
    );
    it.todo('the table list is unchanged and no *_copy table survives');
  });

  describe('the recreated triggers still guard money', () => {
    it.todo('an admin_adjust insert moves the balance (ledger_ai_apply)');
    it.todo('an overdraft insert aborts with "insufficient funds"');
    it.todo('UPDATE and DELETE on ledger abort with "append-only"');
    it.todo('an orphan bankroll_id aborts with "unknown bankroll_id"');
    it.todo('a spread beside a moneyline on one game in one bet aborts (one side pick per game)');
  });

  describe('the widened CHECKs', () => {
    it.todo("league = 'mlb' INSERTs succeed on games, bets, bet_legs and ingest_targets");
    it.todo("league = 'nba' fails CHECK on all four");
    it.todo("bets still accepts 'mixed'; bet_legs, games and ingest_targets still refuse it");
    it.todo('every other CHECK on the six tables still refuses what it refused before');
  });

  describe('composition', () => {
    it.todo(
      'migration-0005.spec.ts re-runs 0005 + 0008 + 0009 and migration-0008.spec.ts re-runs ' +
        '0008 + 0009 — a rebuild is only ever composed forward, or the older DDL is put back',
    );
    it.todo('re-running 0009 twice in a row is a no-op on every row and object');
  });
});
