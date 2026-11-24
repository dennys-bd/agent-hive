import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url)); // this file runs from dist/test/: the sources are two levels up
const read = (path: string): Promise<string> => readFile(join(ROOT, path), 'utf8');

// What can keep a key from the window's capture listeners (#906): a frame's own document, a window of its own, xterm's handler, a stop
// in a file that handles keys. A React handler or a listener below window runs after window's capture phase, so its stop cannot take a
// global key first; each entry says why it does not.
// ponytail: a stop counts per file that mentions keydown, so a click's stop there is listed too; a per-listener parse if that gets noisy
const SURFACES = [
  { kind: 'iframe', pattern: /<iframe\b|createElement\(\s*['"]iframe['"]/g },
  { kind: 'webview', pattern: /<webview\b/g },
  { kind: 'window', pattern: /new (?:BrowserWindow|BrowserView|WebContentsView)\(/g },
  { kind: 'xterm keys', pattern: /\.attachCustomKeyEventHandler\(/g },
  { kind: 'key stop', pattern: /\.stop(?:Immediate)?Propagation\(/g, within: /keydown|KeyboardEvent/i },
] as const;

const ALLOWED: Record<string, { count: number; reason: string }> = {
  'iframe src/ui/components/DiagramPane.tsx': { count: 1, reason: 'draw.io; its keys reach the page through forwardFrameKeys' },
  'iframe src/ui/components/design-frame.tsx': { count: 1, reason: 'the design; its keys reach the page through forwardFrameKeys' },
  'window src/main.ts': { count: 1, reason: 'the main window; calls forwardFrameKeys' },
  'window src/detached-window.ts': { count: 1, reason: 'a detached window; calls forwardFrameKeys' },
  'xterm keys src/ui/lib/xterm-setup.ts': { count: 1, reason: 'terminalKeys refuses only newline, clipboard, find and clear; window\'s capture listener ran first' },
  'key stop src/design-bridge.ts': { count: 1, reason: 'the comment mode\'s pointer, inside the design frame; no key' },
  'key stop src/ui/components/InfoTip.tsx': { count: 1, reason: 'a click, Enter or Space on a section\'s info button (the details panel, the variables form), so the summary does not toggle; no global shortcut' },
  'key stop src/ui/components/NewSessionDialog.tsx': { count: 1, reason: 'Enter, from React\'s capture on the dialog, below window' },
  'key stop src/ui/components/ProjectRow.tsx': { count: 1, reason: 'a click on the chevron; no key' },
  'key stop src/ui/components/TaskPicker.tsx': { count: 3, reason: 'Escape on window (stopPropagation leaves window\'s other listeners), a click, the chip\'s Enter' },
  'key stop src/ui/components/TerminalFind.tsx': { count: 1, reason: 'Enter, Escape and find on its own field, below window' },
  'key stop src/ui/components/search/SearchResults.tsx': { count: 1, reason: 'a click on a file row\'s replace button, so the row does not toggle; no global shortcut' },
  'key stop src/ui/components/settings/ShortcutsTab.tsx': { count: 1, reason: 'the recording field, which the global listeners skip through isRecording' },
  'key stop src/ui/hooks/use-flow-view.ts': { count: 1, reason: 'the flow\'s ⇧1 on window\'s capture phase, after acting; a bare Shift key, no global shortcut' },
  'key stop src/ui/lib/dock-layout.ts': { count: 2, reason: 'onShortcutKey and onFixedKey themselves, after acting' },
  'key stop src/ui/lib/monaco-keys.ts': { count: 1, reason: 'passHiveKeys on the editor host, below window, after its capture listeners took their keys' },
  'key stop src/ui/lib/xterm-setup.ts': { count: 1, reason: 'terminalPaste\'s paste listener; no key' },
};

// Every source under src/ (.ts, .tsx, .cts), so a window or a frame opened in any folder, the preload included, is found
async function scanned(): Promise<string[]> {
  const all = (await readdir(join(ROOT, 'src'), { recursive: true })).map((p) => `src/${p.split(sep).join('/')}`);
  return all.filter((p) => /\.(?:tsx?|cts)$/.test(p) && !p.endsWith('.d.ts')).sort();
}

async function found(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const path of await scanned()) {
    const text = await read(path);
    for (const surface of SURFACES) {
      if ('within' in surface && !surface.within.test(text)) continue;
      const count = [...text.matchAll(surface.pattern)].length;
      if (count > 0) counts[`${surface.kind} ${path}`] = count;
    }
  }
  return counts;
}

test('every frame, window, xterm key handler and key-handling stop in src/ is allowlisted with its count and why it keeps no global key (#906)', async () => {
  const expected = Object.fromEntries(Object.entries(ALLOWED).map(([key, { count }]) => [key, count]));
  assert.deepEqual(await found(), expected, 'a new one needs an ALLOWED entry and a reason, after checking it does not swallow a global shortcut');
});

test('every file that builds a BrowserWindow forwards its frames\' keys (#906)', async () => {
  const windows = Object.keys(await found()).filter((key) => key.startsWith('window ')).map((key) => key.slice('window '.length));
  assert.ok(windows.length > 0, 'the scan must find the windows');
  for (const path of windows) assert.ok((await read(path)).includes('forwardFrameKeys('), `${path}: no forwardFrameKeys`);
});
