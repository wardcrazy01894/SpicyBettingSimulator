/**
 * Config context object + consumer hook. Split from `ConfigContext.tsx` so that
 * file exports only a component (`react-refresh/only-export-components`).
 */

import { createContext, useContext } from 'react';

import type { ConfigResponse } from '../../shared/api-types.js';

export const ConfigContext = createContext<ConfigResponse | null>(null);

/**
 * Non-nullable by construction: `ConfigProvider` renders a spinner (or an error
 * with a retry) until `/api/config` has answered, so every consumer below it can
 * rely on real server values instead of guessing from `constants.ts`.
 */
export function useConfig(): ConfigResponse {
  const value = useContext(ConfigContext);
  if (value === null) throw new Error('useConfig must be used inside <ConfigProvider>');
  return value;
}
