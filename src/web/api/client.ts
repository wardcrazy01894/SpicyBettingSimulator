/**
 * Typed fetch wrapper + one function per route in PLAN.md §11. §12.2.
 *
 * Every request gets `credentials: 'same-origin'`; every state-changing request
 * also gets `X-SBS-Client: 1` (the CSRF companion to `SameSite=Lax` — a header a
 * cross-origin form cannot set without a preflight we do not grant, PLAN.md
 * §10.5). Non-2xx responses are parsed from the `{ error: { code, message,
 * details } }` envelope into a typed `ApiError` so the UI switches on a stable
 * code instead of a message string.
 *
 * The request body NEVER carries a price, a timestamp or a `bettable` flag: the
 * server is the only authority (CLAUDE.md §8). `expected` is the one exception
 * and it is an optimistic-concurrency CHECK, not an instruction.
 */

import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../shared/constants.js';
import { ERROR_STATUS } from '../../shared/errors.js';
import type { ErrorCode } from '../../shared/errors.js';
import type {
  AdminSetDisabledRequest,
  AdminSetPasswordRequest,
  AdminUsersResponse,
  BankrollResponse,
  BetResponse,
  BetsResponse,
  ConfigResponse,
  GameCard,
  GamesResponse,
  HealthResponse,
  JobRunResponse,
  JobRunsResponse,
  KdfParamsResponse,
  LeaderboardResponse,
  LedgerResponse,
  LoginRequest,
  PlaceBetRequest,
  ReconcileResponse,
  SignupRequest,
  UserResponse,
} from '../../shared/api-types.js';
import type { League } from '../../shared/types.js';

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

// ---------------------------------------------------------------------------
// 401 hook
// ---------------------------------------------------------------------------

type UnauthenticatedHandler = () => void;
let onUnauthenticated: UnauthenticatedHandler | null = null;

/**
 * Registered once by `SessionProvider`. Any 401 from any route dispatches
 * SESSION_EXPIRED, which flips the session to `anon`; `AppShell` then renders a
 * redirect to `/login`. Deliberately a side-channel: the call still rejects with
 * the ApiError so the caller's own error handling is unaffected.
 */
export function setUnauthenticatedHandler(handler: UnauthenticatedHandler | null): void {
  onUnauthenticated = handler;
}

// ---------------------------------------------------------------------------
// core
// ---------------------------------------------------------------------------

const NO_CONTENT = 204;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Pull `{ error: { code, message, details } }` out of a parsed body, if present. */
function parseErrorEnvelope(body: unknown, status: number): ApiError {
  if (isRecord(body) && isRecord(body['error'])) {
    const envelope = body['error'];
    const code = envelope['code'];
    const message = envelope['message'];
    if (typeof code === 'string' && code in ERROR_STATUS) {
      return new ApiError(
        code as ErrorCode,
        status,
        typeof message === 'string' ? message : '',
        isRecord(envelope['details']) ? envelope['details'] : undefined,
      );
    }
  }
  // A non-enveloped body: an unrouted path served index.html, a proxy 502, or a
  // milestone whose routes do not exist on this branch yet.
  return new ApiError(status === 404 ? 'NOT_FOUND' : 'INTERNAL', status, `HTTP ${String(status)}`);
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') headers[CSRF_HEADER] = CSRF_HEADER_VALUE;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (cause) {
    throw new ApiError('UPSTREAM_UNAVAILABLE', 0, 'Network request failed', {
      cause: String(cause),
    });
  }

  if (response.status === NO_CONTENT) {
    if (!response.ok) throw parseErrorEnvelope(null, response.status);
    return undefined as T;
  }

  const text = await response.text();
  let parsed: unknown = null;
  if (text !== '') {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    const error = parseErrorEnvelope(parsed, response.status);
    if (response.status === 401) onUnauthenticated?.();
    throw error;
  }
  return parsed as T;
}

export function apiGet<T>(path: string): Promise<T> {
  return request<T>('GET', path);
}

export function apiSend<T>(
  method: 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  return request<T>(method, path, body);
}

/**
 * A state-changing route whose response body we do not read (204, or a body the
 * caller re-reads via a fresh GET anyway). Separate from `apiSend<void>` because
 * `void` is not a legal generic argument under our lint config.
 */
async function apiVoid(
  method: 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<void> {
  await request<unknown>(method, path, body);
}

/** `?a=1&b=2`, skipping null/undefined. Returns '' when nothing is set. */
function query(params: Readonly<Record<string, string | number | null | undefined>>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue;
    search.set(key, typeof value === 'number' ? String(value) : value);
  }
  const encoded = search.toString();
  return encoded === '' ? '' : `?${encoded}`;
}

// ---------------------------------------------------------------------------
// §11.1 public
// ---------------------------------------------------------------------------

export function getHealth(): Promise<HealthResponse> {
  return apiGet<HealthResponse>('/api/health');
}

export function getConfig(): Promise<ConfigResponse> {
  return apiGet<ConfigResponse>('/api/config');
}

export function getKdfParams(): Promise<KdfParamsResponse> {
  return apiGet<KdfParamsResponse>('/api/auth/kdf');
}

// ---------------------------------------------------------------------------
// §11.2 auth
// ---------------------------------------------------------------------------

export function postSignup(body: SignupRequest): Promise<UserResponse> {
  return apiSend<UserResponse>('POST', '/api/auth/signup', body);
}

export function postLogin(body: LoginRequest): Promise<UserResponse> {
  return apiSend<UserResponse>('POST', '/api/auth/login', body);
}

export function postLogout(): Promise<void> {
  return apiVoid('POST', '/api/auth/logout');
}

export function postLogoutAll(): Promise<void> {
  return apiVoid('POST', '/api/auth/logout-all');
}

export function getMe(): Promise<UserResponse> {
  return apiGet<UserResponse>('/api/auth/me');
}

// ---------------------------------------------------------------------------
// §11.3 games
// ---------------------------------------------------------------------------

export interface GamesQuery {
  readonly league: League;
  readonly season?: number | null;
  readonly week?: number | null;
  readonly from?: number | null;
  readonly to?: number | null;
  readonly status?: string | null;
}

export function getGames(params: GamesQuery): Promise<GamesResponse> {
  return apiGet<GamesResponse>(`/api/games${query({ ...params })}`);
}

/**
 * `200 {game: GameCard}`. §11.3 names the envelope but `api-types.ts` has no
 * `GameResponse` interface for it, so the shape is spelled out here rather than
 * added to the frozen contract.
 */
export interface SingleGameResponse {
  readonly game: GameCard;
}

export function getGame(id: string): Promise<SingleGameResponse> {
  return apiGet<SingleGameResponse>(`/api/games/${encodeURIComponent(id)}`);
}

// ---------------------------------------------------------------------------
// §11.4 bets
// ---------------------------------------------------------------------------

export interface BetsQuery {
  readonly status?: 'open' | 'settled' | 'all' | null;
  readonly league?: League | null;
  readonly season?: number | null;
  readonly limit?: number | null;
  readonly cursor?: string | null;
}

export function getBets(params: BetsQuery = {}): Promise<BetsResponse> {
  return apiGet<BetsResponse>(`/api/bets${query({ ...params })}`);
}

export function getBet(id: string): Promise<BetResponse> {
  return apiGet<BetResponse>(`/api/bets/${encodeURIComponent(id)}`);
}

export function postBet(body: PlaceBetRequest): Promise<BetResponse> {
  return apiSend<BetResponse>('POST', '/api/bets', body);
}

/** Edit = atomic cancel + place. `200 {bet, replacedBetId}`. */
export function putBet(id: string, body: PlaceBetRequest): Promise<BetResponse> {
  return apiSend<BetResponse>('PUT', `/api/bets/${encodeURIComponent(id)}`, body);
}

/**
 * Cancel + full refund. §11.4 does not specify a response body, so the result is
 * discarded and callers re-read `/api/bets` — which they must do anyway, because
 * the cancellation also moves the bankroll.
 */
export function deleteBet(id: string): Promise<void> {
  return apiVoid('DELETE', `/api/bets/${encodeURIComponent(id)}`);
}

// ---------------------------------------------------------------------------
// §11.5 bankroll / ledger / leaderboard
// ---------------------------------------------------------------------------

export function getBankroll(league: League, season: number | null): Promise<BankrollResponse> {
  return apiGet<BankrollResponse>(`/api/bankroll${query({ league, season })}`);
}

export interface LedgerQuery {
  readonly league?: League | null;
  readonly season?: number | null;
  readonly limit?: number | null;
  readonly cursor?: string | null;
}

export function getLedger(params: LedgerQuery = {}): Promise<LedgerResponse> {
  return apiGet<LedgerResponse>(`/api/ledger${query({ ...params })}`);
}

export function getLeaderboard(
  league: League,
  season: number | null,
): Promise<LeaderboardResponse> {
  return apiGet<LeaderboardResponse>(`/api/leaderboard${query({ league, season })}`);
}

export function getAllTimeLeaderboard(): Promise<LeaderboardResponse> {
  return apiGet<LeaderboardResponse>('/api/leaderboard/all-time');
}

// ---------------------------------------------------------------------------
// §11.6 admin
// ---------------------------------------------------------------------------

export type AdminJob = 'refresh' | 'settle' | 'maintenance';

export function postAdminJob(job: AdminJob): Promise<JobRunResponse> {
  return apiSend<JobRunResponse>('POST', `/api/admin/jobs/${job}`);
}

export function getAdminJobs(): Promise<JobRunsResponse> {
  return apiGet<JobRunsResponse>('/api/admin/jobs');
}

export function getAdminUsers(): Promise<AdminUsersResponse> {
  return apiGet<AdminUsersResponse>('/api/admin/users');
}

export function postAdminUserPassword(userId: string, dk: string): Promise<void> {
  const body: AdminSetPasswordRequest = { dk };
  return apiVoid('POST', `/api/admin/users/${encodeURIComponent(userId)}/password`, body);
}

export function postAdminUserDisabled(userId: string, disabled: boolean): Promise<void> {
  const body: AdminSetDisabledRequest = { disabled };
  return apiVoid('POST', `/api/admin/users/${encodeURIComponent(userId)}/disabled`, body);
}

export function postAdminRetrySettlement(betId: string): Promise<void> {
  return apiVoid('POST', `/api/admin/bets/${encodeURIComponent(betId)}/retry-settlement`);
}

export function postAdminReconcile(): Promise<ReconcileResponse> {
  return apiSend<ReconcileResponse>('POST', '/api/admin/reconcile');
}
