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
  emptySlipState,
  legKey,
  parseStoredSlip,
  serialiseSlip,
  slipReducer,
  slipStorageKey,
} from './slip-reducer.js';
import { useSession } from './session.js';
import type { BetSlipApi } from './bet-slip.js';
import type { LeagueSlip, SlipLeg, SlipMode } from './slip-reducer.js';
import type { LineChangedDetails, PlaceBetRequest } from '../../shared/api-types.js';
import type { Cents, League, Market, Side } from '../../shared/types.js';
import { LEAGUES } from '../../shared/types.js';

const DEFAULT_LEAGUE: League = 'nfl';

/** localStorage throws in private-mode Safari and when storage is full; never fatal. */
function readStored(league: League): LeagueSlip | null {
  try {
    return parseStoredSlip(localStorage.getItem(slipStorageKey(league)), league);
  } catch {
    return null;
  }
}

function writeStored(league: League, slip: LeagueSlip): void {
  try {
    localStorage.setItem(slipStorageKey(league), serialiseSlip(slip));
  } catch {
    /* ignore — the slip is a convenience, not state of record */
  }
}

export function BetSlipProvider(props: { children: ReactNode }): ReactElement {
  const config = useConfig();
  const session = useSession();
  const [state, dispatch] = useReducer(slipReducer, DEFAULT_LEAGUE, emptySlipState);
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [lastError, setLastError] = useState<unknown>(null);
  const [lineChange, setLineChange] = useState<LineChangedDetails | null>(null);

  // Rehydrate every league's slip once, on mount.
  useEffect(() => {
    for (const league of LEAGUES) {
      const stored = readStored(league);
      if (stored !== null) dispatch({ type: 'HYDRATE', league, slip: stored });
    }
  }, []);

  const league = state.active;
  const slip = state.byLeague[league];
  const editingBetId = state.editingBetId;

  // Persist whatever the active league's slip currently is — EXCEPT while an
  // edit is borrowing the slot. Writing the edit's legs there would overwrite
  // the draft the edit displaced, which `END_EDIT` is about to restore.
  useEffect(() => {
    if (editingBetId === null) writeStored(league, slip);
  }, [league, slip, editingBetId]);

  // ONE account balance, whatever league tab is showing (M5b). Anonymous
  // visitors have none; asking on /login collects a 401 and fires the client's
  // SESSION_EXPIRED side-channel for no reason.
  const balances = useBalances(session.status === 'authed');
  const mainBalance = balances.data?.balances.find((b) => b.kind === 'main') ?? null;
  const availableCents = mainBalance?.balanceCents ?? null;

  const setLeague = useCallback((next: League) => {
    dispatch({ type: 'SET_LEAGUE', league: next });
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
    () => computePreview(league, slip, availableCents, teaserPayouts),
    [league, slip, availableCents, teaserPayouts],
  );

  const startEdit = useCallback(
    (
      betId: string,
      betLeague: League,
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
        league: betLeague,
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
        // An edit hands the league's slot back to the draft it displaced; a
        // plain placement just empties it.
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

  const submit = useCallback(
    () => send(buildPlaceBetRequest(league, slip, false)),
    [send, league, slip],
  );

  const acceptLineChange = useCallback(async (): Promise<void> => {
    if (lineChange === null) return;
    // Re-price the slip FIRST, so the legs (and therefore the preview the user
    // is looking at) carry the server's quoted values, then send those as
    // `expected`. Resubmitting the stale `expected` with acceptLineChange:true
    // booked a price the sheet had never shown.
    const repriced = applyLineChange(slip, lineChange);
    dispatch({ type: 'SET_LEGS', league, legs: repriced.legs });
    await send(buildPlaceBetRequest(league, repriced, true));
  }, [send, league, slip, lineChange]);

  const notice = state.notice;
  const canAcceptLineChange = lineChange !== null && lineChangeIsAcceptable(lineChange);

  const value = useMemo<BetSlipApi>(
    () => ({
      league,
      mode: slip.mode,
      legs: slip.legs,
      stakeCents: slip.stakeCents,
      teaserPointsTenths: slip.teaserPointsTenths,
      setLeague,
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
      league,
      slip,
      setLeague,
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
