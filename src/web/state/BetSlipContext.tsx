/**
 * Bet slip state. Persisted to localStorage per league so a refresh does not
 * lose the slip.
 *
 * Validation reuses the SAME pure functions as the Worker
 * (src/shared/validate.ts) — the client copy exists only to grey out an invalid
 * slip; the server always re-validates and is the only authority.
 */

import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';

import { ApiError, postBet, putBet } from '../api/client.js';
import { useBalances } from '../hooks/useApi.js';
import { invalidate } from '../hooks/useResource.js';
import { BetSlipContext } from './bet-slip.js';
import { useConfig } from './config.js';
import {
  applyLineChange,
  asLineChangedDetails,
  buildPlaceBetRequest,
  computePreview,
  lineChangeIsAcceptable,
} from './slip-preview.js';
import {
  SLIP_STORAGE_KEY,
  emptySlipState,
  legKey,
  parseStoredSlip,
  serialiseSlip,
  slipReducer,
  staleSlipKeys,
} from './slip-reducer.js';
import { useSession } from './session.js';
import type { BetSlipApi } from './bet-slip.js';
import type { Slip, SlipLeg, SlipMode } from './slip-reducer.js';
import type { LineChangedDetails, PlaceBetRequest } from '../../shared/api-types.js';
import type { Cents, League, Market, Side } from '../../shared/types.js';

/** Which league TAB the board opens on. Never a property of the slip. */
const DEFAULT_BOARD_LEAGUE: League = 'nfl';

/** localStorage throws in private-mode Safari and when storage is full; never fatal. */
function readStored(): Slip | null {
  try {
    return parseStoredSlip(localStorage.getItem(SLIP_STORAGE_KEY));
  } catch {
    return null;
  }
}

function writeStored(slip: Slip): void {
  try {
    localStorage.setItem(SLIP_STORAGE_KEY, serialiseSlip(slip));
  } catch {
    /* ignore — the slip is a convenience, not state of record */
  }
}

/**
 * Delete the abandoned per-league entries. The v2 schema kept TWO slips and the
 * v3 model has one, so there is no honest migration — two drafts can disagree
 * about mode, stake and even hold the same game twice. Dropping them beats
 * leaving dead JSON in every user's browser for good.
 */
function dropStaleStored(): void {
  try {
    for (const key of staleSlipKeys()) localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export function BetSlipProvider(props: { children: ReactNode }): ReactElement {
  const config = useConfig();
  const session = useSession();
  const [state, dispatch] = useReducer(slipReducer, DEFAULT_BOARD_LEAGUE, emptySlipState);
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [lastError, setLastError] = useState<unknown>(null);
  const [lineChange, setLineChange] = useState<LineChangedDetails | null>(null);

  // Rehydrate the one slip on mount, and sweep away the old per-league entries.
  useEffect(() => {
    const stored = readStored();
    if (stored !== null) dispatch({ type: 'HYDRATE', slip: stored });
    dropStaleStored();
  }, []);

  const boardLeague = state.board;
  const slip = state.slip;
  const editingBetId = state.editingBetId;

  // Persist the slip — EXCEPT while an edit has taken it over. Writing the
  // edit's legs there would overwrite the draft the edit displaced, which
  // `END_EDIT` is about to restore.
  useEffect(() => {
    if (editingBetId === null) writeStored(slip);
  }, [slip, editingBetId]);

  // ONE account balance, whatever league tab is showing (M5b). Anonymous
  // visitors have none; asking on /login collects a 401 and fires the client's
  // SESSION_EXPIRED side-channel for no reason.
  const balances = useBalances(session.status === 'authed');
  const mainBalance = balances.data?.balances.find((b) => b.kind === 'main') ?? null;
  const availableCents = mainBalance?.balanceCents ?? null;

  const setBoardLeague = useCallback((next: League) => {
    dispatch({ type: 'SET_BOARD', league: next });
  }, []);

  const maxLegs = config.maxParlayLegs;
  const toggleLeg = useCallback(
    (leg: SlipLeg) => {
      setLineChange(null);
      setLastError(null);
      dispatch({ type: 'TOGGLE_LEG', leg, maxLegs });
    },
    [maxLegs],
  );

  const removeLeg = useCallback((gameId: string, market: Market, side: Side) => {
    dispatch({ type: 'REMOVE_LEG', gameId, market, side });
  }, []);

  const clear = useCallback(() => {
    setLineChange(null);
    setLastError(null);
    dispatch({ type: 'CLEAR' });
  }, []);

  const setMode = useCallback((mode: SlipMode) => {
    dispatch({ type: 'SET_MODE', mode });
  }, []);

  const setTeaserPoints = useCallback((pointsTenths: number) => {
    dispatch({ type: 'SET_TEASER_POINTS', pointsTenths });
  }, []);

  const setStakeCents = useCallback((cents: Cents) => {
    setLastError(null);
    dispatch({ type: 'SET_STAKE', stakeCents: cents });
  }, []);

  const dismissNotice = useCallback(() => {
    dispatch({ type: 'DISMISS_NOTICE' });
  }, []);

  const selected = useMemo(() => new Set(slip.legs.map(legKey)), [slip.legs]);
  const isSelected = useCallback(
    (gameId: string, market: Market, side: Side) => selected.has(legKey({ gameId, market, side })),
    [selected],
  );

  const teaserPayouts = config.teaserPayouts;
  const preview = useMemo(
    () => computePreview(slip, availableCents, teaserPayouts),
    [slip, availableCents, teaserPayouts],
  );

  const startEdit = useCallback(
    (
      betId: string,
      mode: SlipMode,
      legs: readonly SlipLeg[],
      stakeCents: Cents,
      teaserPointsTenths?: number,
    ) => {
      setLineChange(null);
      setLastError(null);
      dispatch({
        type: 'START_EDIT',
        betId,
        mode,
        legs,
        stakeCents,
        ...(teaserPointsTenths === undefined ? {} : { teaserPointsTenths }),
      });
      setOpen(true);
    },
    [],
  );

  const cancelEdit = useCallback(() => {
    setLineChange(null);
    setLastError(null);
    dispatch({ type: 'END_EDIT' });
    setOpen(false);
  }, []);

  /** The one place a slip is sent. `body` is always built from what is ON SCREEN. */
  const send = useCallback(
    async (body: PlaceBetRequest): Promise<void> => {
      setSubmitting(true);
      setLastError(null);
      try {
        if (editingBetId === null) await postBet(body);
        else await putBet(editingBetId, body);
        setLineChange(null);
        // An edit hands the slip back to the draft it displaced; a plain
        // placement just empties it.
        dispatch(editingBetId === null ? { type: 'CLEAR' } : { type: 'END_EDIT' });
        setOpen(false);
        // A placement moves money and creates a bet; the board's `bettable`
        // flags may also have changed while the sheet was open.
        invalidate('bets');
        invalidate('bankroll');
        invalidate('leaderboard');
        invalidate('games');
      } catch (error) {
        setLastError(error);
        if (error instanceof ApiError && error.code === 'LINE_CHANGED') {
          setLineChange(asLineChangedDetails(error.details));
        }
      } finally {
        setSubmitting(false);
      }
    },
    [editingBetId],
  );

  const submit = useCallback(() => send(buildPlaceBetRequest(slip, false)), [send, slip]);

  const acceptLineChange = useCallback(async (): Promise<void> => {
    if (lineChange === null) return;
    // Re-price the slip FIRST, so the legs (and therefore the preview the user
    // is looking at) carry the server's quoted values, then send those as
    // `expected`. Resubmitting the stale `expected` with acceptLineChange:true
    // booked a price the sheet had never shown.
    const repriced = applyLineChange(slip, lineChange);
    dispatch({ type: 'SET_LEGS', legs: repriced.legs });
    await send(buildPlaceBetRequest(repriced, true));
  }, [send, slip, lineChange]);

  const notice = state.notice;
  const canAcceptLineChange = lineChange !== null && lineChangeIsAcceptable(lineChange);

  const value = useMemo<BetSlipApi>(
    () => ({
      boardLeague,
      mode: slip.mode,
      legs: slip.legs,
      stakeCents: slip.stakeCents,
      teaserPointsTenths: slip.teaserPointsTenths,
      setBoardLeague,
      toggleLeg,
      removeLeg,
      clear,
      setMode,
      setTeaserPoints,
      setStakeCents,
      isSelected,
      preview,
      notice,
      dismissNotice,
      open,
      setOpen,
      availableCents,
      submitting,
      lastError,
      lineChange,
      canAcceptLineChange,
      editingBetId,
      startEdit,
      cancelEdit,
      submit,
      acceptLineChange,
    }),
    [
      boardLeague,
      slip,
      setBoardLeague,
      toggleLeg,
      removeLeg,
      clear,
      setMode,
      setTeaserPoints,
      setStakeCents,
      isSelected,
      preview,
      notice,
      dismissNotice,
      open,
      availableCents,
      submitting,
      lastError,
      lineChange,
      canAcceptLineChange,
      editingBetId,
      startEdit,
      cancelEdit,
      submit,
      acceptLineChange,
    ],
  );

  return <BetSlipContext value={value}>{props.children}</BetSlipContext>;
}
