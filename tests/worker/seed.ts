/**
 * Direct-to-D1 seed helpers for the `worker` project.
 *
 * M5 must be testable without M4: `tests/worker/fixtures.ts` synthesises ESPN
 * payloads and drives them through the (unimplemented) ingest path, which M5
 * does not own. These helpers instead INSERT `games` / `game_lines` rows
 * straight into the test D1, so a bet test can say "an NFL game kicking off in
 * two hours with a DraftKings line" in one line.
 *
 * Kept in its own file (rather than inside bets.spec.ts) so M6's settle.spec.ts
 * can reuse the same shapes — PLAN.md §13 needs "place a bet, then make its game
 * final 27-24" and that is exactly `seedGame` + `updateGame`.
 *
 * Everything here is epoch milliseconds, integer cents and integer tenths, like
 * the rest of the system.
 */

import type { BetLeague, GameStatus, League } from '../../src/shared/types.js';

/** How far ahead of `now` a seeded game kicks off unless the test says otherwise. */
export const DEFAULT_KICKOFF_OFFSET_MS = 2 * 60 * 60 * 1000;

export interface SeedGameSpec {
  readonly id: string;
  readonly league?: League;
  readonly season?: number;
  readonly seasonType?: number;
  readonly week?: number | null;
  readonly kickoffAt: number;
  /** Defaults to `kickoffAt`; set it apart to simulate an ESPN reschedule. */
  readonly originalKickoffAt?: number;
  readonly status?: GameStatus;
  readonly statusDetail?: string | null;
  readonly homeAbbr?: string;
  readonly awayAbbr?: string;
  readonly homeScore?: number | null;
  readonly awayScore?: number | null;
  readonly neutralSite?: boolean;
  readonly lastSeenAt?: number;
}

export interface SeedLineSpec {
  readonly gameId: string;
  readonly provider?: string;
  readonly spreadHomeTenths?: number | null;
  readonly spreadHomePrice?: number | null;
  readonly spreadAwayTenths?: number | null;
  readonly spreadAwayPrice?: number | null;
  readonly totalTenths?: number | null;
  readonly totalOverPrice?: number | null;
  readonly totalUnderPrice?: number | null;
  readonly mlHomePrice?: number | null;
  readonly mlAwayPrice?: number | null;
  /** When the BOOK's price last CHANGED. Defaults to `seenAt`. */
  readonly capturedAt?: number;
  /** When we last CONFIRMED the line. Staleness is measured against THIS. */
  readonly seenAt: number;
}

/** A `game_lines` row with every market populated at ordinary football prices. */
export function fullLine(gameId: string, seenAt: number): SeedLineSpec {
  return {
    gameId,
    spreadHomeTenths: -35,
    spreadHomePrice: -110,
    spreadAwayTenths: 35,
    spreadAwayPrice: -110,
    totalTenths: 455,
    totalOverPrice: -110,
    totalUnderPrice: -110,
    mlHomePrice: -198,
    mlAwayPrice: 164,
    seenAt,
  };
}

export async function seedGame(db: D1Database, spec: SeedGameSpec): Promise<void> {
  const league = spec.league ?? 'nfl';
  const home = spec.homeAbbr ?? 'SEA';
  const away = spec.awayAbbr ?? 'NE';
  await db
    .prepare(
      `INSERT INTO games (
         id, provider, provider_event_id, league, season, season_type, week,
         name, short_name, kickoff_at, original_kickoff_at, status, status_detail,
         period, display_clock, neutral_site,
         home_team_id, home_abbr, home_name, home_logo, home_rank, home_score,
         away_team_id, away_abbr, away_name, away_logo, away_rank, away_score,
         first_seen_at, last_seen_at, updated_at)
       VALUES (?1, 'espn', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
               NULL, NULL, ?13,
               ?14, ?15, ?15, NULL, NULL, ?16,
               ?17, ?18, ?18, NULL, NULL, ?19,
               ?20, ?20, ?20)`,
    )
    .bind(
      spec.id,
      spec.id.split(':')[1] ?? spec.id,
      league,
      spec.season ?? 2026,
      spec.seasonType ?? 2,
      spec.week ?? 1,
      `${away} at ${home}`,
      `${away} @ ${home}`,
      spec.kickoffAt,
      spec.originalKickoffAt ?? spec.kickoffAt,
      spec.status ?? 'scheduled',
      spec.statusDetail ?? null,
      spec.neutralSite === true ? 1 : 0,
      `t-${home}`,
      home,
      spec.homeScore ?? null,
      `t-${away}`,
      away,
      spec.awayScore ?? null,
      spec.lastSeenAt ?? spec.kickoffAt,
    )
    .run();
}

export async function seedLine(db: D1Database, spec: SeedLineSpec): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO game_lines (
         game_id, provider, spread_home_tenths, spread_home_price,
         spread_away_tenths, spread_away_price, total_tenths, total_over_price,
         total_under_price, ml_home_price, ml_away_price, captured_at, seen_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
    )
    .bind(
      spec.gameId,
      spec.provider ?? 'draftkings',
      spec.spreadHomeTenths ?? null,
      spec.spreadHomePrice ?? null,
      spec.spreadAwayTenths ?? null,
      spec.spreadAwayPrice ?? null,
      spec.totalTenths ?? null,
      spec.totalOverPrice ?? null,
      spec.totalUnderPrice ?? null,
      spec.mlHomePrice ?? null,
      spec.mlAwayPrice ?? null,
      spec.capturedAt ?? spec.seenAt,
      spec.seenAt,
    )
    .run();
}

/** Seed a game AND a full line for it in one call. Returns the game id. */
export async function seedGameWithLine(
  db: D1Database,
  spec: SeedGameSpec,
  line?: Partial<SeedLineSpec>,
): Promise<string> {
  await seedGame(db, spec);
  await seedLine(db, { ...fullLine(spec.id, spec.lastSeenAt ?? Date.now()), ...line });
  return spec.id;
}

/**
 * Mutate a seeded game the way ingestion would — move the kickoff earlier, flip
 * it to `in_progress`, write a final score. `games.kickoff_at` is MUTABLE by
 * design (PLAN.md §14.1) and `bets.earliest_kickoff_at` deliberately is not
 * updated with it, which is the whole point of several cancel/edit tests.
 */
export async function updateGame(
  db: D1Database,
  id: string,
  patch: {
    readonly kickoffAt?: number;
    readonly status?: GameStatus;
    readonly homeScore?: number | null;
    readonly awayScore?: number | null;
    readonly lastSeenAt?: number;
  },
): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];
  const push = (column: string, value: unknown): void => {
    values.push(value);
    sets.push(`${column} = ?${String(values.length)}`);
  };
  if (patch.kickoffAt !== undefined) push('kickoff_at', patch.kickoffAt);
  if (patch.status !== undefined) push('status', patch.status);
  if (patch.homeScore !== undefined) push('home_score', patch.homeScore);
  if (patch.awayScore !== undefined) push('away_score', patch.awayScore);
  if (patch.lastSeenAt !== undefined) push('last_seen_at', patch.lastSeenAt);
  if (sets.length === 0) return;
  values.push(id);
  await db
    .prepare(`UPDATE games SET ${sets.join(', ')} WHERE id = ?${String(values.length)}`)
    .bind(...values)
    .run();
}

/**
 * Open a user's `main` ACCOUNT BALANCE exactly the way the signup batch does
 * (M5b): a guarded `INSERT … SELECT … WHERE NOT EXISTS` on `bankrolls` at a 0
 * balance, plus an explicit guarded insert for the opening deposit. Idempotent,
 * and NEVER `INSERT OR IGNORE` into `ledger` (CLAUDE.md rule 6), even in a test
 * helper.
 *
 * Most tests get this for free by signing up over HTTP; this is for the ones
 * that create a user row directly, or that want a non-default opening balance.
 */
export async function seedBankroll(
  db: D1Database,
  userId: string,
  now: number,
  initialCents = 100_000,
): Promise<string> {
  const id = crypto.randomUUID();
  await db.batch([
    db
      .prepare(
        `INSERT INTO bankrolls (id, user_id, name, kind, balance_cents, created_at, updated_at)
         SELECT ?1, ?2, 'Main', 'main', 0, ?3, ?3
          WHERE NOT EXISTS (SELECT 1 FROM bankrolls WHERE user_id = ?2 AND kind = 'main')`,
      )
      .bind(id, userId, now),
    db
      .prepare(
        `INSERT INTO ledger (id, bankroll_id, kind, ref_id, bet_id, amount_cents, created_at, memo)
         SELECT ?2, ?1, 'deposit_initial', 'init', NULL, ?4, ?3, 'opening balance'
          WHERE EXISTS (SELECT 1 FROM bankrolls WHERE id = ?1)
            AND NOT EXISTS (SELECT 1 FROM ledger
                             WHERE bankroll_id = ?1 AND kind = 'deposit_initial' AND ref_id = 'init')`,
      )
      .bind(id, crypto.randomUUID(), now, initialCents),
  ]);
  return mainBankrollId(db, userId);
}

/** The user's one `main` balance id. Throws rather than returning a bad bind. */
export async function mainBankrollId(db: D1Database, userId: string): Promise<string> {
  const row = await db
    .prepare(`SELECT id FROM bankrolls WHERE user_id = ?1 AND kind = 'main'`)
    .bind(userId)
    .first<{ id: string }>();
  if (row === null) throw new Error(`user ${userId} has no main balance`);
  return row.id;
}

export interface SeedBetSpec {
  readonly id: string;
  readonly userId: string;
  /** `bets.league` — may be `'mixed'` since M5b. Informational. */
  readonly league?: BetLeague;
  readonly season?: number;
  readonly status: 'pending' | 'won' | 'lost' | 'push' | 'void' | 'cancelled';
  readonly stakeCents: number;
  /** Total return. Required for every status except `pending`. */
  readonly payoutCents?: number;
  readonly americanPrice?: number;
  readonly placedAt?: number;
}

/**
 * Insert a bet in a TERMINAL state plus the ledger rows settlement would have
 * written — M6 owns `settle.ts`, so leaderboard/bankroll statistics have to be
 * given a finished history to read. The money rows go through the real triggers,
 * so `SUM(ledger) === balance_cents` still holds afterwards.
 */
export async function seedSettledBet(db: D1Database, spec: SeedBetSpec): Promise<void> {
  const league = spec.league ?? 'nfl';
  const season = spec.season ?? 2026;
  const placedAt = spec.placedAt ?? Date.now();
  // Idempotent: a user who signed up over HTTP already has their main balance,
  // and this returns the existing id rather than opening a second one.
  const bkId = await seedBankroll(db, spec.userId, placedAt);
  const american = spec.americanPrice ?? -110;
  const payout = spec.payoutCents ?? 0;
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO bets (id, user_id, bankroll_id, league, season, bet_type, leg_count,
                           stake_cents, american_price, potential_payout_cents, status,
                           payout_cents, placed_at, earliest_kickoff_at, settled_at,
                           cancelled_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'straight', 1, ?6, ?7, ?8, ?9, ?10, ?11, ?11, ?12, ?13, ?11, ?11)`,
      )
      .bind(
        spec.id,
        spec.userId,
        bkId,
        league,
        season,
        spec.stakeCents,
        american,
        Math.max(payout, spec.stakeCents),
        spec.status,
        spec.status === 'pending' ? null : payout,
        placedAt,
        spec.status === 'pending' || spec.status === 'cancelled' ? null : placedAt,
        spec.status === 'cancelled' ? placedAt : null,
      ),
    db
      .prepare(
        `INSERT INTO ledger (id, bankroll_id, kind, ref_id, bet_id, amount_cents, created_at, memo)
         VALUES (?1, ?2, 'bet_stake', ?3, ?3, ?4, ?5, 'seeded stake')`,
      )
      .bind(crypto.randomUUID(), bkId, spec.id, -spec.stakeCents, placedAt),
  ];
  if (spec.status === 'cancelled') {
    statements.push(
      db
        .prepare(
          `INSERT INTO ledger (id, bankroll_id, kind, ref_id, bet_id, amount_cents, created_at, memo)
           VALUES (?1, ?2, 'bet_refund', ?3, ?3, ?4, ?5, 'seeded refund')`,
        )
        .bind(crypto.randomUUID(), bkId, spec.id, spec.stakeCents, placedAt),
    );
  } else if (payout > 0) {
    statements.push(
      db
        .prepare(
          `INSERT INTO ledger (id, bankroll_id, kind, ref_id, bet_id, amount_cents, created_at, memo)
           VALUES (?1, ?2, 'bet_payout', ?3, ?3, ?4, ?5, 'seeded payout')`,
        )
        .bind(crypto.randomUUID(), bkId, spec.id, payout, placedAt),
    );
  }
  await db.batch(statements);
}

/**
 * TEST-ONLY: empty `users` and everything that hangs off them.
 *
 * Signup now opens an account balance and writes its opening deposit in the SAME
 * batch (M5b), and the schema deliberately makes both of those permanent:
 * `bankrolls.user_id` is `ON DELETE RESTRICT`, `ledger.bankroll_id` is `ON
 * DELETE RESTRICT`, and `ledger_bd_block` refuses `DELETE FROM ledger` outright.
 * There is therefore NO ordering of DELETEs that can empty `users` — which is
 * exactly right in production (money does not evaporate) and leaves a test file
 * whose premise is "an empty users table" with nothing to stand on.
 *
 * So this takes the two append-only block triggers down for the duration of the
 * wipe and puts them back, in a `finally`. It is confined to this helper, the
 * DDL is copied VERBATIM from migrations/0001_init.sql, and the recreate is
 * asserted so a file can never continue with the guards missing. Production code
 * must never do anything remotely like this.
 */
export async function wipeAccounts(db: D1Database): Promise<void> {
  try {
    await db.batch([
      db.prepare('DROP TRIGGER IF EXISTS ledger_bd_block'),
      db.prepare('DROP TRIGGER IF EXISTS ledger_bu_block'),
    ]);
    await db.batch([
      db.prepare('DELETE FROM ledger'),
      db.prepare('DELETE FROM bet_legs'),
      db.prepare('DELETE FROM bets'),
      db.prepare('DELETE FROM bankrolls'),
      db.prepare('DELETE FROM auth_throttle'),
      db.prepare('DELETE FROM sessions'),
      db.prepare('DELETE FROM users'),
    ]);
  } finally {
    await db.batch([
      db.prepare(
        `CREATE TRIGGER IF NOT EXISTS ledger_bu_block BEFORE UPDATE ON ledger BEGIN
           SELECT RAISE(ABORT, 'ledger is append-only');
         END`,
      ),
      db.prepare(
        `CREATE TRIGGER IF NOT EXISTS ledger_bd_block BEFORE DELETE ON ledger BEGIN
           SELECT RAISE(ABORT, 'ledger is append-only');
         END`,
      ),
    ]);
  }
  const guards = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM sqlite_master
        WHERE type = 'trigger' AND name IN ('ledger_bu_block', 'ledger_bd_block')`,
    )
    .first<{ n: number }>();
  if (guards?.n !== 2) throw new Error('wipeAccounts failed to restore the ledger guards');
}

/** `SUM(ledger.amount_cents)` for one bankroll — the money invariant's left side. */
export async function ledgerSum(db: D1Database, bankrollId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS total FROM ledger WHERE bankroll_id = ?1`)
    .bind(bankrollId)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

/** `bankrolls.balance_cents` — the money invariant's right side. */
export async function balanceOf(db: D1Database, bankrollId: string): Promise<number | null> {
  const row = await db
    .prepare(`SELECT balance_cents FROM bankrolls WHERE id = ?1`)
    .bind(bankrollId)
    .first<{ balance_cents: number }>();
  return row?.balance_cents ?? null;
}

/**
 * Assert PLAN.md §4.1's headline invariant for EVERY bankroll in the database.
 * Returns the offending rows so the caller can put them in the failure message.
 */
export async function bankrollDrift(
  db: D1Database,
): Promise<readonly { id: string; balance: number; sum: number }[]> {
  const res = await db
    .prepare(
      `SELECT b.id AS id, b.balance_cents AS balance,
              COALESCE((SELECT SUM(amount_cents) FROM ledger WHERE bankroll_id = b.id), 0) AS sum
         FROM bankrolls b`,
    )
    .all<{ id: string; balance: number; sum: number }>();
  return res.results.filter((r) => r.balance !== r.sum);
}
