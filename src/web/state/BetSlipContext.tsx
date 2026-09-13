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
import { useBankroll } from '../hooks/useApi.js';
import { invalidate } from '../hooks/useResource.js';
import { BetSlipContext } from './bet-slip.js';
import { useConfig } from './config.js';
import { asLineChangedDetails, buildPlaceBetRequest, computePreview } from './slip-preview.js';
import {
  emptySlipState,
  legKey,
  parseStoredSlip,
  serialiseSlip,
  slipReducer,
  slipStorageKey,
} from './slip-reducer.js';
import type { BetSlipApi } from './bet-slip.js';
import type { LeagueSlip, SlipLeg, SlipMode } from './slip-reducer.js';
import type { LineChangedDetails } from '../../shared/api-types.js';
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

  // Persist whatever the active league's slip currently is.
  useEffect(() => {
    writeStored(league, slip);
  }, [league, slip]);

  const season = config.currentSeason[league];
  const bankroll = useBankroll(league, season);
  const availableCents = bankroll.data?.balanceCents ?? null;

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

  const setStakeCents = useCallback((cents: Cents) => {
    setLastError(null);
    dispatch({ type: 'SET_STAKE', stakeCents: cents });
  }, []);

  const selected = useMemo(() => new Set(slip.legs.map(legKey)), [slip.legs]);
  const isSelected = useCallback(
    (gameId: string, market: Market, side: Side) => selected.has(legKey({ gameId, market, side })),
    [selected],
  );

  const preview = useMemo(
    () => computePreview(league, slip, availableCents),
    [league, slip, availableCents],
  );

  const startEdit = useCallback(
    (
      betId: string,
      betLeague: League,
      mode: SlipMode,
      legs: readonly SlipLeg[],
      stakeCents: Cents,
    ) => {
      setLineChange(null);
      setLastError(null);
      dispatch({ type: 'START_EDIT', betId, league: betLeague, mode, legs, stakeCents });
      setOpen(true);
    },
    [],
  );

  const cancelEdit = useCallback(() => {
    dispatch({ type: 'CLEAR' });
    setOpen(false);
  }, []);

  const editingBetId = state.editingBetId;
  const submit = useCallback(
    async (acceptLineChange: boolean): Promise<void> => {
      setSubmitting(true);
      setLastError(null);
      try {
        const body = buildPlaceBetRequest(league, slip, acceptLineChange);
        if (editingBetId === null) await postBet(body);
        else await putBet(editingBetId, body);
        setLineChange(null);
        dispatch({ type: 'CLEAR' });
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
    [league, slip, editingBetId],
  );

  const value = useMemo<BetSlipApi>(
    () => ({
      league,
      mode: slip.mode,
      legs: slip.legs,
      stakeCents: slip.stakeCents,
      setLeague,
      toggleLeg,
      removeLeg,
      clear,
      setMode,
      setStakeCents,
      isSelected,
      preview,
      open,
      setOpen,
      availableCents,
      submitting,
      lastError,
      lineChange,
      editingBetId,
      startEdit,
      cancelEdit,
      submit,
    }),
    [
      league,
      slip,
      setLeague,
      toggleLeg,
      removeLeg,
      clear,
      setMode,
      setStakeCents,
      isSelected,
      preview,
      open,
      availableCents,
      submitting,
      lastError,
      lineChange,
      editingBetId,
      startEdit,
      cancelEdit,
      submit,
    ],
  );

  return <BetSlipContext value={value}>{props.children}</BetSlipContext>;
}
