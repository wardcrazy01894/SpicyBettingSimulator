import { describe, expect, it } from 'vitest';
import { INVITE_PARAM, inviteCodeFromParam, inviteLink } from '../../src/web/lib/invite.js';

describe('inviteLink', () => {
  it('points at /login with the code in the query, URL-encoded', () => {
    expect(inviteLink('https://spicy.example', 'sun & moon')).toBe(
      `https://spicy.example/login?${INVITE_PARAM}=sun%20%26%20moon`,
    );
  });

  it('is a bare /login when signup is open (no code set)', () => {
    expect(inviteLink('https://spicy.example', null)).toBe('https://spicy.example/login');
  });

  it('never doubles a slash when the origin carries one', () => {
    expect(inviteLink('https://spicy.example/', 'abc')).toBe(
      `https://spicy.example/login?${INVITE_PARAM}=abc`,
    );
  });
});

describe('inviteCodeFromParam', () => {
  it('round-trips what inviteLink wrote', () => {
    const url = new URL(inviteLink('https://spicy.example', 'sun & moon'));
    expect(inviteCodeFromParam(url.searchParams.get(INVITE_PARAM))).toBe('sun & moon');
  });

  it('treats a missing or blank param as no code', () => {
    expect(inviteCodeFromParam(null)).toBeNull();
    expect(inviteCodeFromParam('')).toBeNull();
    expect(inviteCodeFromParam('   ')).toBeNull();
  });

  it('trims surrounding whitespace, as the signup form does', () => {
    expect(inviteCodeFromParam('  abc ')).toBe('abc');
  });
});
