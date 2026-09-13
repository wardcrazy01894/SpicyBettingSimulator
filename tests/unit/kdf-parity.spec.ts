import { describe, it } from 'vitest';

/**
 * The browser (src/web/api/kdf.ts), the Node admin script
 * (scripts/admin-hash.mjs) and this test must all derive the SAME key, or an
 * admin password reset would lock the user out. (M3)
 */
describe('client KDF parity', () => {
  it.todo('deriveClientSalt is SHA-256("SBS-v1|" + lowercased username)');
  it.todo('deriveKey matches a hard-coded 64-hex vector for a fixed username/password');
  it.todo('is case-insensitive in the username and case-SENSITIVE in the password');
  it.todo('uses exactly CLIENT_KDF.iterations rounds');
});
