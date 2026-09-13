/**
 * Browser-side password stretching. PLAN.md §10.2.
 *
 * The Workers free plan gives 10 ms of CPU per invocation, which cannot fit a
 * 100k-iteration PBKDF2, so the stretching happens HERE (210k iterations, ~300 ms)
 * and the server only applies a cheap 1k-iteration hash to what we send. The
 * total work factor against an offline attacker is unchanged.
 *
 * The salt is derived deterministically from the username, so there is no
 * "fetch my salt" round trip and therefore no user-enumeration oracle.
 *
 * `scripts/admin-hash.mjs` MUST produce identical output for the same inputs;
 * `tests/unit/kdf-parity.spec.ts` pins that with a fixed vector.
 */

/** `SHA-256(saltPrefix + username.toLowerCase())`. */
export function deriveClientSalt(_username: string): Promise<Uint8Array> {
  throw new Error('not implemented: M3');
}

/** `PBKDF2-SHA256(password, clientSalt, iterations, 32B)` as 64 lowercase hex chars. */
export function deriveKey(_username: string, _password: string): Promise<string> {
  throw new Error('not implemented: M3');
}
