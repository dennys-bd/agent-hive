// Codex's models for the new session dialog (#257), kept by the server (#694): `codex debug models` runs at boot, then in the background
// when a dialog opens on a list older than CODEX_MODELS_MAX_AGE_MS, never on a request's path, so a slow or missing CLI never delays the dialog.
import { AGENTS } from './agents.js';
import { isLaunchModel } from './launch-pick.js';
import type { Logger } from './log.js';
import { isRecord } from './rate-limits.js';
import type { Exec, LaunchOption } from './types.js';

export const CODEX_MODELS_TIMEOUT_MS = 10_000; // a hung CLI ends as a failed read: the last good list stays
export const CODEX_MODELS_MAX_AGE_MS = 5 * 60_000; // a model Codex adds shows up within one stale open, without a restart

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// One entry of `codex debug models`, narrowed from unknown: a slug the routes would admit as a model, its display name as the hint when it adds one
function codexModel(value: unknown): { option: LaunchOption; isHidden: boolean }[] {
  if (!isRecord(value)) return [];
  const { slug, display_name: name, visibility } = value;
  if (!isLaunchModel(slug)) return [];
  const hint = typeof name === 'string' && name !== '' && name !== slug ? { hint: name } : {};
  return [{ option: { id: slug, ...hint }, isHidden: visibility === 'hide' }];
}

/** Codex's models as `codex debug models` prints them (#257): visible first, hidden after, each group in the CLI's order. Throws on bad JSON. */
export function parseCodexModels(stdout: string): LaunchOption[] {
  const parsed: unknown = JSON.parse(stdout);
  const list: unknown[] = Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed.models) ? parsed.models : [];
  const models = list.flatMap(codexModel);
  return [...models.filter((m) => !m.isHidden), ...models.filter((m) => m.isHidden)].map((m) => m.option);
}

type Outcome = 'listed' | 'failed';
interface CacheState { models: readonly LaunchOption[]; readAt?: number; isRefreshing: boolean; lastOutcome?: Outcome }

/** Codex's list as the server keeps it (#694). */
export interface CodexModelsCache { list(): readonly LaunchOption[] }

/** The cache GET /launch-options reads (#694). Creating it starts the first read; list() answers at once and, when no read is running and the
 * last good one is missing or older than CODEX_MODELS_MAX_AGE_MS, starts one in the background. A failed read keeps the last list and its age,
 * so the next stale open tries again. Never rejects. */
export function codexModelsCache(exec: Exec, log: Pick<Logger, 'info'>, now: () => number = Date.now): CodexModelsCache {
  let state: CacheState = { models: [], isRefreshing: false };
  // One line per change of outcome, not per attempt: without Codex installed every stale open would log the same failure
  const settle = (outcome: Outcome, line: string, read: Pick<CacheState, 'models' | 'readAt'> | Record<string, never> = {}): void => {
    const isChange = outcome === 'failed' ? state.lastOutcome !== 'failed' : state.lastOutcome === 'failed';
    if (isChange) log.info(line);
    state = { ...state, ...read, isRefreshing: false, lastOutcome: outcome };
  };
  const refresh = async (): Promise<void> => {
    state = { ...state, isRefreshing: true }; // before the first await: a list() in the same tick starts no second read
    try {
      const { stdout } = await exec(AGENTS.codex.command, ['debug', 'models'], { timeout: CODEX_MODELS_TIMEOUT_MS });
      settle('listed', 'launch options: codex debug models lists Codex\'s models again', { models: parseCodexModels(stdout), readAt: now() });
    } catch (err) {
      settle('failed', `launch options: codex debug models gave no list: ${errorMessage(err).split('\n')[0]}`);
    }
  };
  const isStale = (): boolean => state.readAt === undefined || now() - state.readAt > CODEX_MODELS_MAX_AGE_MS;
  void refresh();
  return {
    list: () => {
      if (!state.isRefreshing && isStale()) void refresh();
      return state.models;
    },
  };
}
