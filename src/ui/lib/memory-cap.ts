// A workspace's memory total limit in the UI (#73, #115): what the parser accepts, what a full memory costs per run, and the memory dialog's
// save carried into the Settings draft.
import { CHARS_PER_TOKEN } from '../../memory-stats.js';
import { MEMORY_CAP_MAX, MEMORY_CAP_MIN } from '../../types.js';
import type { SettingsDraft } from './settings-form.js';

// The rendered section's frame (title, intro, headings, [m-n] ids) rounded up: it is outside the cap but reaches every run
const FRAME_CHARS = 400;

/** The field as typed is a whole number from MEMORY_CAP_MIN to MEMORY_CAP_MAX, what the parser accepts (#73). */
export function isMemoryCap(text: string): boolean {
  const trimmed = text.trim();
  return /^\d+$/.test(trimmed) && Number(trimmed) >= MEMORY_CAP_MIN && Number(trimmed) <= MEMORY_CAP_MAX;
}

/** The tokens a run gets with the memory full at `cap` (#73), by telemetry's own heuristic: 4,000 -> 1,100. */
export const memoryCapTokens = (cap: number): number => Math.round((cap + FRAME_CHARS) / CHARS_PER_TOKEN);

/** The draft with the cap the memory dialog saved (#115) on the row the server names `workspace`: the dialog only opens for a saved name, so
 * that row is the one a later Settings save sends as that workspace. */
export const withMemoryCap = (draft: SettingsDraft, workspace: string, cap: number): SettingsDraft => ({
  ...draft, workspaces: draft.workspaces.map((w) => (w.name.trim() === workspace ? { ...w, memoryCap: String(cap) } : w)),
});
