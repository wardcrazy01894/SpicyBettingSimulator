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

import { CLIENT_KDF, SERVER_KDF_ITERATIONS, SERVER_SALT_BYTES } from '../shared/constants.js';

/**
 * Every `Uint8Array` here is pinned to a non-shared `ArrayBuffer`: since TS 5.7
 * the type is generic over its backing buffer and only that form satisfies
 * `BufferSource`, which is what `crypto.subtle` wants.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

/** 16 random bytes for a new user's `server_salt`. */
export function newServerSalt(): Bytes {
  return crypto.getRandomValues(new Uint8Array(SERVER_SALT_BYTES));
}

/**
 * Server-side hash of the browser-derived key.
 * `PBKDF2-SHA256(dk, serverSalt, iterations, 32 bytes)` — ~0.3 ms of CPU.
 *
 * The PBKDF2 *input* is the raw 32 bytes the `dk` hex decodes to, not the hex
 * text: that is what scripts/admin-hash.mjs does, and the two must agree or an
 * admin password reset would lock the user out.
 */
export async function hashDerivedKey(
  dkHex: string,
  serverSalt: Uint8Array,
  iterations: number,
): Promise<Bytes> {
  const material = await crypto.subtle.importKey('raw', hexToBytes(dkHex), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: CLIENT_KDF.hash, salt: toBytes(serverSalt), iterations },
    material,
    HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/** The server-side hash length, matching `users.password_hash` (32 bytes). */
const HASH_BYTES = 32;

/** Constant-time byte comparison. Never use `===` on a hash. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  // Length is not secret here (every hash is 32 bytes, every server salt 16),
  // and a differing length cannot be compared without leaking it anyway.
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

/**
 * A fixed decoy salt. It is a CONSTANT on purpose: its only job is to make the
 * unknown-user branch cost the same PBKDF2 as the known-user branch, and it
 * never protects anything, so there is nothing to keep secret.
 */
const DECOY_SALT: Bytes = new Uint8Array([
  0x53, 0x42, 0x53, 0x2d, 0x76, 0x31, 0x7c, 0x64, 0x65, 0x63, 0x6f, 0x79, 0x2d, 0x73, 0x61, 0x6c,
]);
/** A fixed 32-byte value to compare the decoy hash against, so the branches match. */
const DECOY_HASH: Bytes = new Uint8Array(HASH_BYTES);

/**
 * Burn a comparable amount of CPU for an unknown username, using a fixed decoy
 * salt, so "no such user" and "wrong password" are indistinguishable in both the
 * response and the timing. PLAN.md §10.2.
 */
export async function dummyVerify(dkHex: string): Promise<void> {
  // A caller may reach here with a `dk` that never passed validation (the login
  // route validates first, but this is also the last line of defence), so fall
  // back to a well-formed value rather than throwing a distinguishable error.
  const safe = /^[0-9a-f]{64}$/.test(dkHex) ? dkHex : '0'.repeat(64);
  const hash = await hashDerivedKey(safe, DECOY_SALT, SERVER_KDF_ITERATIONS);
  // The comparison is performed (and its result discarded) so this branch runs
  // exactly the same work as a real verification.
  if (timingSafeEqual(hash, DECOY_HASH)) {
    // Cryptographically unreachable: a 1,000-round PBKDF2 output is never 32
    // zero bytes. Present so the compare cannot be optimised away.
    console.warn('[auth] decoy hash collision');
  }
}

/** 32 random bytes, base64url — the raw session token handed to the browser. */
export function newSessionToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(SESSION_TOKEN_BYTES)));
}

const SESSION_TOKEN_BYTES = 32;

/** Unpadded base64url. `btoa` is available in workerd. */
function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** SHA-256 hex. Used for `sessions.id` and for the IP throttle key. */
export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : toBytes(input);
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', data)));
}

/** Constant-time string compare, for INVITE_CODE. */
export function timingSafeEqualString(a: string, b: string): boolean {
  const enc = new TextEncoder();
  return timingSafeEqual(enc.encode(a), enc.encode(b));
}

export function hexToBytes(hex: string): Bytes {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error('hexToBytes: not a hex string');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Copy any byte view into a fresh, non-shared `Uint8Array`. Needed because
 * `crypto.subtle` and `D1PreparedStatement.bind()` both want a plain
 * `ArrayBuffer`-backed view, and a value read back out of D1 is not one.
 */
function toBytes(view: Uint8Array): Bytes {
  const copy = new Uint8Array(view.length);
  copy.set(view);
  return copy;
}

/**
 * Bind a byte string as a D1 BLOB parameter. D1 accepts `ArrayBuffer` (and
 * views of one); this normalises whatever we hold into that.
 */
export function toBlobParam(bytes: Uint8Array): ArrayBuffer {
  return toBytes(bytes).buffer;
}

/**
 * Read a BLOB column back out of D1. Which JS shape arrives depends on the D1
 * version — `ArrayBuffer`, a typed-array view, or a plain `number[]` — so all
 * three are accepted rather than assuming one and failing obscurely later.
 */
export function blobToBytes(value: unknown): Bytes {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return toBytes(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  throw new Error('blobToBytes: unsupported BLOB representation');
}
