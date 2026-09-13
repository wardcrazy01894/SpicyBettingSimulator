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

import { CLIENT_KDF } from '../../shared/constants.js';

/**
 * The username exactly as the server will store it. `validateUsername()` in
 * src/shared/validate.ts trims and lowercases, so the salt must do the same or a
 * user who types " Alex " would derive a key against a salt the server never
 * sees again.
 */
function normaliseUsername(username: string): string {
  return username.trim().toLowerCase();
}

/**
 * `SHA-256(saltPrefix + username.toLowerCase())`.
 *
 * The `<ArrayBuffer>` argument is not decoration: since TS 5.7 `Uint8Array` is
 * generic over its backing buffer and only the non-shared form satisfies
 * `BufferSource`, which is what `crypto.subtle.deriveBits` wants for `salt`.
 */
export async function deriveClientSalt(username: string): Promise<Uint8Array<ArrayBuffer>> {
  const input = new TextEncoder().encode(CLIENT_KDF.saltPrefix + normaliseUsername(username));
  return new Uint8Array(await crypto.subtle.digest('SHA-256', input));
}

/** `PBKDF2-SHA256(password, clientSalt, iterations, 32B)` as 64 lowercase hex chars. */
export async function deriveKey(username: string, password: string): Promise<string> {
  const salt = await deriveClientSalt(username);
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: CLIENT_KDF.algorithm,
      hash: CLIENT_KDF.hash,
      salt,
      iterations: CLIENT_KDF.iterations,
    },
    material,
    CLIENT_KDF.keyLengthBytes * 8,
  );
  return Array.from(new Uint8Array(bits), (b) => b.toString(16).padStart(2, '0')).join('');
}
