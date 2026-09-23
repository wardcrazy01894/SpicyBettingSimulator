import { describe, expect, it } from 'vitest';
import { INVITE_PARAM, inviteCodeFromParam, inviteLink } from '../../src/web/lib/invite.js';

describe('inviteLink', () => {
  it('points at /login with the code in the query, URL-encoded', () => {
    expect(inviteLink('https://spicy.example', 'sun & moon')).toBe(
      `https://spicy.example/login?${INVITE_PARAM}=sun%20%26%20moon`,
    );
  });

  it('keeps a valueless ?invite when signup is open, so the page still opens on signup', () => {
    const link = inviteLink('https://spicy.example', null);
    expect(link).toBe(`https://spicy.example/login?${INVITE_PARAM}`);
    const params = new URL(link).searchParams;
    expect(params.has(INVITE_PARAM)).toBe(true);
    expect(inviteCodeFromParam(params.get(INVITE_PARAM))).toBeNull();
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
