/**
 * The join link an admin hands a friend: `/login?invite=<code>`. `AuthPage` reads
 * the param back, opens the "Create account" tab and prefills the invite field,
 * so joining is "tap the link, pick a name and password".
 *
 * Pure and DOM-free (tests/web). The origin is the caller's job — in the browser
 * it is `window.location.origin`, which is also where the SPA that will read
 * the link back lives.
 */

export const INVITE_PARAM = 'invite';

/**
 * `code` null = signup is open (no `INVITE_CODE` set). The param is still
 * present, valueless (`/login?invite`), because its PRESENCE is what tells
 * `AuthPage` to open on "Create account"; only its value is the prefill.
 */
export function inviteLink(origin: string, code: string | null): string {
  const base = `${origin.replace(/\/+$/, '')}/login?${INVITE_PARAM}`;
  if (code === null) return base;
  return `${base}=${encodeURIComponent(code)}`;
}

/** The raw `?invite=` value → a code, or null when absent or blank (the form's own rule). */
export function inviteCodeFromParam(raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}
