import { createContext, useContext } from 'react';
import { WORKSPACE_PRESET_COLORS } from '../../types.js';

// A workspace's colour (redesign 08): the one exception to "colour only for status" (docs/agent/design-system.md). Derived from the name, so
// nothing is stored and every screen agrees. One lightness and chroma for every hue, which reads on both themes.

// Hues away from the status colours: working ~150, waiting ~95, approval ~235, review ~260, destructive ~25
const HUES = [295, 350, 320, 190] as const;
const HASH_BASE = 31;

// ponytail: two workspaces may share a hue; a colour picked in Settings replaces the hash if that ever matters
export function workspaceColor(name: string): string {
  const hash = [...name].reduce((sum, char) => (sum * HASH_BASE + (char.codePointAt(0) ?? 0)) % HUES.length, 0);
  return `oklch(0.72 0.12 ${HUES[hash]})`;
}

/** A new Settings row's colour (#78): the first preset no row of the draft uses; once all 7 are taken the list restarts, by row count. */
export function nextWorkspaceColor(rows: readonly { color: string }[]): string {
  const used = new Set(rows.map((row) => row.color));
  return WORKSPACE_PRESET_COLORS.find((color) => !used.has(color)) ?? WORKSPACE_PRESET_COLORS[rows.length % WORKSPACE_PRESET_COLORS.length];
}

/** The Comb's workspace colours by name (#78): the dashboard provides state.workspaceColors, Settings its draft rows. */
export const WorkspaceColorsContext = createContext<Readonly<Record<string, string>>>({});

// hasOwn: a workspace may be called "constructor", which a plain lookup would read off Object.prototype
export function useWorkspaceColor(name: string | undefined): string | undefined {
  const colors = useContext(WorkspaceColorsContext);
  return name !== undefined && Object.hasOwn(colors, name) ? colors[name] : undefined;
}
