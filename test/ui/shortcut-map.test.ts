import { expect, test } from 'vitest';
import type { MessageKey } from '@/i18n';
import { type MapSection, shortcutMapSections } from '@/lib/shortcut-map';
import { SHORTCUT_SCOPES, SHORTCUTS } from '../../src/shortcut-registry';
import type { Shortcuts } from '../../src/types';

const MAC = true;
const OTHER = false; // Linux and Windows share one table (#585)
const labels = (sections: MapSection[]): MessageKey[] => sections.flatMap((s) => s.rows.map((row) => row.label));
const keysOf = (sections: MapSection[], label: MessageKey): string | undefined => sections.flatMap((s) => s.rows).find((row) => row.label === label)?.keys;

test('the four scopes come in Settings\' order; the global one lists its live shortcuts and fixed keys in the map\'s order (#639)', () => {
  const sections = shortcutMapSections({}, MAC);
  expect(sections.map((s) => s.scope)).toEqual([...SHORTCUT_SCOPES]);
  expect(labels(sections.slice(0, 1))).toEqual([
    'shortcuts.viewActivities', 'shortcuts.viewFlow', 'shortcuts.viewPlugins', 'shortcuts.search', 'shortcuts.searchOperations', 'shortcuts.newActivity', 'shortcuts.runCommand',
    'shortcuts.toggleConsole', 'shortcuts.problems', 'shortcuts.fixed.signal', 'shortcuts.toggleLeft', 'shortcuts.toggleRight', 'shortcuts.fixed.settings',
    'shortcuts.shortcutMap', 'shortcuts.fullScreen', 'shortcuts.closeWindow', 'shortcuts.fixed.quit',
  ]);
  expect(sections[0].rows[0]).toEqual({ label: 'shortcuts.viewActivities', keys: '⌘1' });
});

test('a changed binding shows its new key in this platform\'s symbols (#639)', () => {
  expect(keysOf(shortcutMapSections({ toggleConsole: 'CmdOrCtrl+Shift+Y' }, MAC), 'shortcuts.toggleConsole')).toBe('⌘⇧Y');
  expect(keysOf(shortcutMapSections({ toggleConsole: 'CmdOrCtrl+Shift+Y' }, OTHER), 'shortcuts.toggleConsole')).toBe('Ctrl+Shift+Y');
  expect(keysOf(shortcutMapSections({}, OTHER), 'shortcuts.shortcutMap')).toBe('Ctrl+/');
});

test('a shortcut turned off, a soon shortcut and the soon go-to-tab range are left out (#639)', () => {
  const shown = labels(shortcutMapSections({ clear: null }, OTHER));
  for (const absent of ['shortcuts.clear', 'shortcuts.nextTab', 'shortcuts.fixed.goToTab'] as const) expect(shown).not.toContain(absent);
  expect(shown).toContain('shortcuts.splitSame');
});

test('the signal range reads as one key, as in Settings (#639)', () => {
  expect(keysOf(shortcutMapSections({}, MAC), 'shortcuts.fixed.signal')).toBe('⌘⌥1–3');
  expect(keysOf(shortcutMapSections({}, OTHER), 'shortcuts.fixed.signal')).toBe('Ctrl+Shift+1–3');
});

test('with every activity shortcut off, the activities scope keeps the terminal\'s copy, paste and select all, in this platform\'s keys (#639, #644)', () => {
  const off = Object.fromEntries(SHORTCUTS.filter((s) => s.scope === 'activities' && s.soon !== true).map((s) => [s.id, null])) as Shortcuts;
  const activities = (mac: boolean) => shortcutMapSections(off, mac).find((s) => s.scope === 'activities')?.rows;
  expect(activities(OTHER)).toEqual([
    { label: 'shortcuts.fixed.copy', keys: 'Ctrl+Shift+C Ctrl+Insert' },
    { label: 'shortcuts.fixed.paste', keys: 'Ctrl+Shift+V Shift+Insert' },
    { label: 'shortcuts.fixed.selectAll', keys: 'Ctrl+Shift+A' },
  ]);
  expect(activities(MAC)?.map((row) => row.keys)).toEqual(['⌘C', '⌘V', '⌘A']);
});

test('the flow scope lists the zoom keys after atualizar, then the fixed ⇧1, in this platform\'s symbols (#910)', () => {
  const zoomRows = (mac: boolean) => shortcutMapSections({}, mac).find((s) => s.scope === 'flow')?.rows.slice(-4);
  expect(zoomRows(MAC)).toEqual([
    { label: 'shortcuts.zoomOut', keys: '⌘-' }, { label: 'shortcuts.zoomIn', keys: '⌘=' },
    { label: 'shortcuts.zoomReset', keys: '⌘0' }, { label: 'shortcuts.fixed.zoomFit', keys: '⇧1' },
  ]);
  expect(zoomRows(OTHER)?.map((row) => row.keys)).toEqual(['Ctrl+-', 'Ctrl+=', 'Ctrl+0', 'Shift+1']);
});
