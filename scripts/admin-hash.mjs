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
 * SECOND JOB: this script also prints the raw `dk` hex, which is what
 * tests/worker/setup.ts uses as its precomputed vectors — workerd caps PBKDF2 at
 * 100,000 iterations and will throw OperationError on our 210,000, so worker
 * tests can never derive a key themselves.
 *
 * Prints to stdout only; it never connects to anything.
 */

function main() {
  throw new Error('not implemented: M3');
}

main();
