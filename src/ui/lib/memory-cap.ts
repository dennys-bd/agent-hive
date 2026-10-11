// A workspace's memory total limit in the settings form (#73): what the parser accepts, and what a full memory costs per run.
import { CHARS_PER_TOKEN } from '../../memory-stats.js';
import { MEMORY_CAP_MAX, MEMORY_CAP_MIN } from '../../types.js';
import { t } from '../i18n.js';
import type { SettingsProblem, WorkspaceDraft } from './settings-form.js';

// The rendered section's frame (title, intro, headings, [m-n] ids) rounded up: it is outside the cap but reaches every run
const FRAME_CHARS = 400;

/** The field as typed is a whole number from MEMORY_CAP_MIN to MEMORY_CAP_MAX, what the parser accepts (#73). */
export function isMemoryCap(text: string): boolean {
  const trimmed = text.trim();
  return /^\d+$/.test(trimmed) && Number(trimmed) >= MEMORY_CAP_MIN && Number(trimmed) <= MEMORY_CAP_MAX;
}

/** The tokens a run gets with the memory full at `cap` (#73), by telemetry's own heuristic: 4,000 -> 1,100. */
export const memoryCapTokens = (cap: number): number => Math.round((cap + FRAME_CHARS) / CHARS_PER_TOKEN);

/** The first workspace row whose memory total limit the parser would refuse (#73), named. */
export function memoryCapProblem(workspaces: readonly WorkspaceDraft[]): SettingsProblem | undefined {
  const bad = workspaces.find((w) => !isMemoryCap(w.memoryCap));
  return bad === undefined ? undefined : { section: 'workspaces', message: t('settings.error.memoryCap', { workspace: bad.name.trim() }) };
}
