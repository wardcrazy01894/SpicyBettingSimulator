import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { CLIENT_KDF, KDF_VERSION, SERVER_KDF_ITERATIONS } from '../../src/shared/constants.js';
import { deriveClientSalt, deriveKey } from '../../src/web/api/kdf.js';

/**
 * The browser (src/web/api/kdf.ts), the Node admin script
 * (scripts/admin-hash.mjs) and this test must all derive the SAME key, or an
 * admin password reset would lock the user out. (M3)
 *
 * The vectors below were produced by an INDEPENDENT reference implementation of
 * PLAN.md §10.2 (plain WebCrypto, no import of the code under test), so this is
 * a real pin and not a tautology. They are the same values `tests/worker/setup.ts`
 * exports as `DK_VECTORS`: the worker project must never derive a `dk` in-pool,
 * because the Workers free plan allows 10 ms of CPU per invocation and a 210k
 * PBKDF2 costs 25-100 ms. (CLAUDE.md's "workerd caps PBKDF2 at 100,000
 * iterations" is stale for workerd 1.20260911.1 — measured, see
 * tests/worker/setup.ts — but the CPU budget makes the rule right anyway.)
 * Here in the node project 210k is cheap, so this is where the pin lives.
 */

const PASSWORDS = {
  alex: 'correct-horse-battery-staple',
  bob: 'bobs-very-long-password',
  carol: 'carols-reset-password-9',
  dave: 'daves-long-password-11',
} as const;

const VECTORS = {
  alex: '18b3bfaa9da6d403de76795e3096767721acfeacdbbe0f0fc69e9d460ad8f346',
  bob: 'c9d3c7d22fc7fe8f6cfde0ae0019c80be141e27611e1a0817c1d16f15e834253',
  carol: 'f36aebc96da7999f209d7c52102da3f784338098f8764607e251febb2091a701',
  dave: '0fa83955ee57563cae104768538f2565edf08c95d798977a47c657d63dd03850',
} as const;

/** SHA-256("SBS-v1|alex"), computed independently. */
const ALEX_SALT_HEX = 'fc2b8877fa8f946d9498da5aea8323c78133e6feeec2da12d0f7a91b49035f33';

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

describe('client KDF parity', () => {
  it('deriveClientSalt is SHA-256("SBS-v1|" + lowercased username)', async () => {
    expect(CLIENT_KDF.saltPrefix).toBe('SBS-v1|');
    const salt = await deriveClientSalt('alex');
    expect(salt).toBeInstanceOf(Uint8Array);
    expect(salt.length).toBe(32);
    expect(toHex(salt)).toBe(ALEX_SALT_HEX);
    // Same salt regardless of the casing (and surrounding whitespace) typed.
    expect(toHex(await deriveClientSalt('ALeX'))).toBe(ALEX_SALT_HEX);
    expect(toHex(await deriveClientSalt('  alex  '))).toBe(ALEX_SALT_HEX);
    // A different username is a different salt.
    expect(toHex(await deriveClientSalt('bob'))).not.toBe(ALEX_SALT_HEX);
  });

  it('deriveKey matches a hard-coded 64-hex vector for a fixed username/password', async () => {
    const dk = await deriveKey('alex', PASSWORDS.alex);
    expect(dk).toMatch(/^[0-9a-f]{64}$/);
    expect(dk).toBe(VECTORS.alex);
  });

  it('matches the hard-coded vector for every DK_VECTORS entry', async () => {
    for (const name of ['alex', 'bob', 'carol', 'dave'] as const) {
      expect(await deriveKey(name, PASSWORDS[name])).toBe(VECTORS[name]);
    }
  }, 30_000);

  it('is case-insensitive in the username and case-SENSITIVE in the password', async () => {
    expect(await deriveKey('ALEX', PASSWORDS.alex)).toBe(VECTORS.alex);
    expect(await deriveKey('alex', 'Correct-horse-battery-staple')).not.toBe(VECTORS.alex);
    expect(await deriveKey('alex', 'Correct-horse-battery-staple')).toBe(
      '10290684da42e23a6f56a63c1a2caba7cef40dd59be2f35303c6b3f43305bdd1',
    );
  }, 20_000);

  it('uses exactly CLIENT_KDF.iterations rounds', async () => {
    expect(CLIENT_KDF.iterations).toBe(210_000);
    expect(CLIENT_KDF.keyLengthBytes).toBe(32);
    // Derived with one fewer round: proves the count is not merely "large".
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(PASSWORDS.alex), 'PBKDF2', false, [
      'deriveBits',
    ]);
    const offByOne = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        hash: CLIENT_KDF.hash,
        salt: await deriveClientSalt('alex'),
        iterations: CLIENT_KDF.iterations - 1,
      },
      key,
      CLIENT_KDF.keyLengthBytes * 8,
    );
    expect(toHex(new Uint8Array(offByOne))).not.toBe(VECTORS.alex);
  }, 30_000);
});

/**
 * scripts/admin-hash.mjs is the ONLY way an account gets a new password, and it
 * is also the generator for tests/worker/setup.ts's DK_VECTORS. Run for real as
 * a subprocess: it must print the same `dk` the browser derives, plus a
 * ready-to-run `wrangler d1 execute` statement.
 */
describe('scripts/admin-hash.mjs', () => {
  const run = (...args: string[]): string =>
    execFileSync(process.execPath, ['scripts/admin-hash.mjs', ...args], {
      encoding: 'utf8',
      cwd: new URL('../..', import.meta.url).pathname,
    });

  it('prints a dk identical to the browser derivation', () => {
    const out = run('alex', PASSWORDS.alex);
    const dk = /^dk:\s+([0-9a-f]{64})$/m.exec(out)?.[1];
    expect(dk).toBe(VECTORS.alex);
  }, 30_000);

  it('prints the documented output shape: params, salt, hash and a wrangler command', () => {
    const out = run('Alex', PASSWORDS.alex);
    expect(out).toMatch(/^username:\s+alex$/m);
    expect(out).toMatch(new RegExp(`^kdf_version:\\s+${String(KDF_VERSION)}$`, 'm'));
    expect(out).toMatch(
      new RegExp(`^client_iterations:\\s+${String(CLIENT_KDF.iterations)}$`, 'm'),
    );
    expect(out).toMatch(
      new RegExp(`^server_iterations:\\s+${String(SERVER_KDF_ITERATIONS)}$`, 'm'),
    );
    // 16-byte server salt and 32-byte hash, as SQLite blob literals.
    expect(out).toMatch(/^server_salt:\s+[0-9a-f]{32}$/m);
    expect(out).toMatch(/^password_hash:\s+[0-9a-f]{64}$/m);
    expect(out).toContain('wrangler d1 execute spicybetting');
    expect(out).toContain('UPDATE users SET');
    expect(out).toMatch(/server_salt\s*=\s*X'[0-9a-f]{32}'/);
    expect(out).toMatch(/password_hash\s*=\s*X'[0-9a-f]{64}'/);
    expect(out).toMatch(/WHERE username\s*=\s*'alex'/);
    // The plaintext password must never be echoed.
    expect(out).not.toContain(PASSWORDS.alex);
  }, 30_000);

  it('uses a fresh random server_salt on every run', () => {
    const saltOf = (s: string): string | undefined =>
      /^server_salt:\s+([0-9a-f]{32})$/m.exec(s)?.[1];
    const a = saltOf(run('alex', PASSWORDS.alex));
    const b = saltOf(run('alex', PASSWORDS.alex));
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  }, 60_000);

  it('exits non-zero with usage when called without both arguments', () => {
    expect(() => run('alex')).toThrow();
  });
});
