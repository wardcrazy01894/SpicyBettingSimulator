/**
 * Password and token cryptography. PLAN.md §10.
 *
 * THE CONSTRAINT: the Workers FREE plan allows 10 ms of CPU per invocation.
 * A server-side 100k-iteration PBKDF2 costs 25-100 ms, so it does not fit. We
 * therefore run the heavy stretching in the BROWSER (210k iterations, see
 * src/web/api/kdf.ts) and only a cheap 1k-iteration PBKDF2 here. The total work
 * factor an offline attacker faces is unchanged at 210k; what changes is WHERE
 * it is paid. The DB stores PBKDF2(dk, serverSalt, 1000), so a stolen database
 * still yields no replayable credential.
 */

/** 16 random bytes for a new user's `server_salt`. */
export function newServerSalt(): Uint8Array {
  throw new Error('not implemented: M3');
}

/**
 * Server-side hash of the browser-derived key.
 * `PBKDF2-SHA256(dk, serverSalt, iterations, 32 bytes)` — ~0.3 ms of CPU.
 */
export function hashDerivedKey(
  _dkHex: string,
  _serverSalt: Uint8Array,
  _iterations: number,
): Promise<Uint8Array> {
  throw new Error('not implemented: M3');
}

/** Constant-time byte comparison. Never use `===` on a hash. */
export function timingSafeEqual(_a: Uint8Array, _b: Uint8Array): boolean {
  throw new Error('not implemented: M3');
}

/**
 * Burn a comparable amount of CPU for an unknown username, using a fixed decoy
 * salt, so "no such user" and "wrong password" are indistinguishable in both the
 * response and the timing. PLAN.md §10.2.
 */
export function dummyVerify(_dkHex: string): Promise<void> {
  throw new Error('not implemented: M3');
}

/** 32 random bytes, base64url — the raw session token handed to the browser. */
export function newSessionToken(): string {
  throw new Error('not implemented: M3');
}

/** SHA-256 hex. Used for `sessions.id` and for the IP throttle key. */
export function sha256Hex(_input: string | Uint8Array): Promise<string> {
  throw new Error('not implemented: M3');
}

/** Constant-time string compare, for INVITE_CODE. */
export function timingSafeEqualString(_a: string, _b: string): boolean {
  throw new Error('not implemented: M3');
}

export function hexToBytes(_hex: string): Uint8Array {
  throw new Error('not implemented: M3');
}

export function bytesToHex(_bytes: Uint8Array): string {
  throw new Error('not implemented: M3');
}
