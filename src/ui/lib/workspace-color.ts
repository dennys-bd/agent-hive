import { createContext, useContext } from 'react';
import { WORKSPACE_PRESET_COLORS } from '../../types.js';

// A workspace's colour (redesign 08, #78): the one exception to "colour only for status" (docs/agent/design-system.md). The config holds it;
// this file has the default for a new row and what the squares read.

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
