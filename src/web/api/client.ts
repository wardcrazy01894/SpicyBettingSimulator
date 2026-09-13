/**
 * Typed fetch wrapper. PLAN.md §12.2.
 *
 * Every request gets `X-SBS-Client: 1` (the CSRF companion to SameSite=Lax) and
 * `credentials: 'same-origin'`. Non-2xx responses are parsed from the
 * `{ error: { code, message, details } }` envelope into a typed ApiError so the
 * UI can switch on a stable code instead of a message string.
 */

import type { ErrorCode } from '../../shared/errors.js';

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: ErrorCode,
    status: number,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function apiGet<T>(_path: string): Promise<T> {
  throw new Error('not implemented: M7a');
}

export function apiSend<T>(
  _method: 'POST' | 'PUT' | 'DELETE',
  _path: string,
  _body?: unknown,
): Promise<T> {
  throw new Error('not implemented: M7a');
}

/** Human copy for each ErrorCode, rendered by the toast/banner components. */
export function messageForCode(_code: ErrorCode): string {
  throw new Error('not implemented: M7a');
}
