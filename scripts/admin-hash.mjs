#!/usr/bin/env node
/**
 * Admin password tool. There is no self-service password reset (by design), so
 * this is how an account gets a new password.
 *
 *   node scripts/admin-hash.mjs <username> <password>
 *
 * Runs the IDENTICAL derivation the browser runs (src/web/api/kdf.ts):
 *   clientSalt = SHA-256("SBS-v1|" + username.toLowerCase())
 *   dk         = PBKDF2-SHA256(password, clientSalt, CLIENT_KDF.iterations, 32B)
 * then prints a ready-to-run `wrangler d1 execute` statement that sets
 * password_hash = PBKDF2-SHA256(dk, <new random server_salt>, SERVER_KDF_ITERATIONS).
 *
 * Parity with the browser is pinned by tests/unit/kdf-parity.spec.ts. The
 * parameters are imported from src/shared/constants.ts — never re-typed here.
 *
 * IMPORT NOTE: this .mjs file imports a .ts file directly. That works only
 * because (a) Node 24 strips types natively, and (b) constants.ts happens to have
 * NO imports of its own — type stripping does not perform path resolution, so a
 * `.js`-suffixed relative import inside it would fail at runtime. If constants.ts
 * ever grows an import, this script must switch to
 * `node --experimental-strip-types` with an explicit resolver, or the constants
 * must be duplicated here WITH a parity test. Do not let it silently drift.
 *
 * That is also why the KDF is re-implemented here rather than imported from
 * src/web/api/kdf.ts: THAT file imports constants.ts with a `.js` specifier,
 * which type stripping cannot resolve. The duplication is deliberate and is the
 * exact thing tests/unit/kdf-parity.spec.ts runs this script to check.
 *
 * SECOND JOB: this script also prints the raw `dk` hex, which is what
 * tests/worker/setup.ts uses as its precomputed vectors. The worker project must
 * never derive a key itself: the Workers free plan allows 10 ms of CPU per
 * invocation and a 210,000-round PBKDF2 costs 25-100 ms, so an in-pool
 * derivation would be exercising something the deployed Worker cannot do.
 * (The older "workerd throws OperationError above 100,000 iterations" claim no
 * longer holds on workerd 1.20260911.1 — measured; see tests/worker/setup.ts.)
 *
 * Prints to stdout only; it never connects to anything.
 */

import {
  CLIENT_KDF,
  KDF_VERSION,
  SERVER_KDF_ITERATIONS,
  SERVER_SALT_BYTES,
} from '../src/shared/constants.ts';

const USAGE = 'usage: node scripts/admin-hash.mjs <username> <password>';

/** Bytes -> lowercase hex. */
function toHex(bytes) {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** SHA-256("SBS-v1|" + normalised username). Mirrors src/web/api/kdf.ts. */
async function deriveClientSalt(username) {
  const input = new TextEncoder().encode(CLIENT_KDF.saltPrefix + username);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', input));
}

/** PBKDF2(secret, salt, iterations, 32B). Used for BOTH halves of the split KDF. */
async function pbkdf2(secret, salt, iterations, lengthBytes) {
  const material = await crypto.subtle.importKey('raw', secret, 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: CLIENT_KDF.algorithm, hash: CLIENT_KDF.hash, salt, iterations },
    material,
    lengthBytes * 8,
  );
  return new Uint8Array(bits);
}

async function main() {
  const [username, password] = process.argv.slice(2);
  if (typeof username !== 'string' || typeof password !== 'string' || password === '') {
    console.error(USAGE);
    process.exit(2);
  }
  const normalised = username.trim().toLowerCase();

  // --- client half (what the browser posts as `dk`) ------------------------
  const clientSalt = await deriveClientSalt(normalised);
  const dk = await pbkdf2(
    new TextEncoder().encode(password),
    clientSalt,
    CLIENT_KDF.iterations,
    CLIENT_KDF.keyLengthBytes,
  );
  const dkHex = toHex(dk);

  // --- server half (what the row stores) -----------------------------------
  const serverSalt = crypto.getRandomValues(new Uint8Array(SERVER_SALT_BYTES));
  const passwordHash = await pbkdf2(dk, serverSalt, SERVER_KDF_ITERATIONS, 32);

  const serverSaltHex = toHex(serverSalt);
  const passwordHashHex = toHex(passwordHash);
  const now = Date.now();

  console.log(`username:          ${normalised}`);
  console.log(`kdf_version:       ${KDF_VERSION}`);
  console.log(`client_iterations: ${CLIENT_KDF.iterations}`);
  console.log(`server_iterations: ${SERVER_KDF_ITERATIONS}`);
  console.log(`dk:                ${dkHex}`);
  console.log(`server_salt:       ${serverSaltHex}`);
  console.log(`password_hash:     ${passwordHashHex}`);
  console.log('');
  console.log('# `dk` is what the browser posts to /api/auth/login — it is also the');
  console.log('# value tests/worker/setup.ts pins as a DK_VECTORS entry.');
  console.log('# Apply the new password with (add --local to target the dev DB):');
  console.log('');
  console.log(
    `wrangler d1 execute spicybetting --remote --command "UPDATE users SET kdf_version = ${KDF_VERSION}, client_iterations = ${CLIENT_KDF.iterations}, server_salt = X'${serverSaltHex}', server_iterations = ${SERVER_KDF_ITERATIONS}, password_hash = X'${passwordHashHex}', updated_at = ${now} WHERE username = '${normalised}';"`,
  );
  console.log('');
  console.log('# Existing sessions are NOT revoked by that statement. To force a');
  console.log('# re-login, also run:');
  console.log('');
  console.log(
    `wrangler d1 execute spicybetting --remote --command "DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE username = '${normalised}');"`,
  );
}

await main();
