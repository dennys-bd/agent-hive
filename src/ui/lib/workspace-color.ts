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
