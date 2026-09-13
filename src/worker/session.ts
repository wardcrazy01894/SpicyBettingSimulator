/**
 * Session issuance, lookup and cookie handling. PLAN.md §10.5.
 *
 * `sessions.id` is sha256hex(token); the raw token exists only in the cookie, so
 * a database dump grants no live sessions.
 */

import type { Context } from 'hono';
import {
  SESSION_COOKIE_NAME,
  SESSION_TOUCH_INTERVAL_MS,
  SESSION_TTL_MS,
} from '../shared/constants.js';
import type { EpochMs, UserSummary } from '../shared/types.js';
import type { Env } from './env.js';
import { newSessionToken, sha256Hex } from './crypto.js';
import { queryOne, runBatch } from './db.js';

export interface SessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly createdAt: EpochMs;
  readonly expiresAt: EpochMs;
  readonly lastSeenAt: EpochMs;
}

/**
 * A fresh token plus the row that will represent it. Split out of
 * `createSession` so `signup()` can put the INSERT in the SAME batch as the
 * user INSERT — one batch is the only atomicity D1 offers (PLAN.md §16 / CLAUDE
 * rule 5), and a rolled-back signup must not leave an orphan session.
 */
export async function newSessionMaterial(
  userId: string,
  now: EpochMs,
): Promise<{ readonly token: string; readonly session: SessionRecord }> {
  const token = newSessionToken();
  return {
    token,
    session: {
      id: await sha256Hex(token),
      userId,
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
      lastSeenAt: now,
    },
  };
}

/** The INSERT for a session row. Callers decide which batch it joins. */
export function insertSessionStatement(env: Env, session: SessionRecord): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
  ).bind(session.id, session.userId, session.createdAt, session.expiresAt, session.lastSeenAt);
}

/** Create a session row and return the raw token to put in the cookie. */
export async function createSession(
  env: Env,
  userId: string,
  now: EpochMs,
): Promise<{ readonly token: string; readonly session: SessionRecord }> {
  const material = await newSessionMaterial(userId, now);
  await runBatch(env.DB, [insertSessionStatement(env, material.session)]);
  return material;
}

interface SessionJoinRow {
  readonly id: string;
  readonly user_id: string;
  readonly created_at: number;
  readonly expires_at: number;
  readonly last_seen_at: number;
  readonly username: string;
  readonly display_name: string;
  readonly is_admin: number;
  readonly user_created_at: number;
}

/**
 * Resolve a raw token to its user. Returns null when absent, unknown, expired or
 * the user is disabled.
 *
 * Rolling expiry: `expires_at`/`last_seen_at` are rewritten only when more than
 * SESSION_TOUCH_INTERVAL_MS has elapsed, so a normal page view costs zero D1
 * writes against the 100k/day budget.
 */
export async function resolveSession(
  env: Env,
  token: string,
  now: EpochMs,
): Promise<{ readonly session: SessionRecord; readonly user: UserSummary } | null> {
  if (token === '') return null;
  const id = await sha256Hex(token);
  // `is_disabled = 0` is part of the JOIN, which is what makes "disabling an
  // account kills its live sessions" true without deleting any rows (PLAN §10.5).
  const row = await queryOne<SessionJoinRow>(
    env.DB.prepare(
      `SELECT s.id, s.user_id, s.created_at, s.expires_at, s.last_seen_at,
              u.username, u.display_name, u.is_admin, u.created_at AS user_created_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.id = ?1 AND s.expires_at > ?2 AND u.is_disabled = 0`,
    ).bind(id, now),
  );
  if (row === null) return null;

  let expiresAt = row.expires_at;
  let lastSeenAt = row.last_seen_at;
  if (now - row.last_seen_at > SESSION_TOUCH_INTERVAL_MS) {
    expiresAt = now + SESSION_TTL_MS;
    lastSeenAt = now;
    await runBatch(env.DB, [
      env.DB.prepare('UPDATE sessions SET last_seen_at = ?2, expires_at = ?3 WHERE id = ?1').bind(
        id,
        lastSeenAt,
        expiresAt,
      ),
    ]);
  }

  return {
    session: {
      id: row.id,
      userId: row.user_id,
      createdAt: row.created_at,
      expiresAt,
      lastSeenAt,
    },
    user: {
      id: row.user_id,
      username: row.username,
      displayName: row.display_name,
      isAdmin: row.is_admin === 1,
      createdAt: row.user_created_at,
    },
  };
}

export async function deleteSession(env: Env, token: string): Promise<void> {
  if (token === '') return;
  const id = await sha256Hex(token);
  await runBatch(env.DB, [env.DB.prepare('DELETE FROM sessions WHERE id = ?1').bind(id)]);
}

export async function deleteAllSessionsForUser(env: Env, userId: string): Promise<void> {
  await runBatch(env.DB, [env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(userId)]);
}

/** SESSION_TTL_MS is a whole number of seconds, so this division is exact. */
const COOKIE_MAX_AGE_SECONDS = SESSION_TTL_MS / 1000;

function cookieAttributes(secure: boolean, maxAgeSeconds: number): string {
  const attrs = ['HttpOnly'];
  if (secure) attrs.push('Secure');
  attrs.push('SameSite=Lax', 'Path=/', `Max-Age=${String(maxAgeSeconds)}`);
  return attrs.join('; ');
}

/** `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=…` */
export function buildSessionCookie(token: string, secure: boolean): string {
  return `${SESSION_COOKIE_NAME}=${token}; ${cookieAttributes(secure, COOKIE_MAX_AGE_SECONDS)}`;
}

/** Same attributes with `Max-Age=0`, so the browser actually drops it. */
export function buildClearedSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE_NAME}=; ${cookieAttributes(secure, 0)}`;
}

export function readSessionCookie(c: Context<{ Bindings: Env }>): string | null {
  return readSessionCookieHeader(c.req.raw.headers.get('cookie'));
}

/**
 * Parse the session token out of a `Cookie` header. Hand-rolled rather than via
 * hono/cookie so `sessionMiddleware` can call it with the typed app context
 * without a structural cast.
 */
export function readSessionCookieHeader(header: string | null): string | null {
  return readSessionCookieHeaders(header)[0] ?? null;
}

/**
 * EVERY `sbs_session` value in the header, in order. A sibling-subdomain (or
 * plain-http MITM) can inject a same-named cookie ahead of the real one; trying
 * each candidate turns that from a silent logout into a no-op.
 */
export function readSessionCookieHeaders(header: string | null): readonly string[] {
  if (header === null) return [];
  const out: string[] = [];
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE_NAME) continue;
    const value = part.slice(eq + 1).trim();
    if (value !== '') out.push(value);
  }
  return out;
}
