import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIXED_SHORTCUTS, fixedShortcut, SHORTCUT_MAP, SHORTCUT_SCOPES, SHORTCUTS, type ShortcutScope, shortcutDef } from '../src/shortcut-registry.js';
import { bindingFromEvent, canonicalBinding, collisions, defaultBinding, displayBinding, displayKeys, effectiveBindings, FIXED_BINDINGS, type KeyLike, matches, normalizeBinding, parseShortcuts, takesTerminalKey } from '../src/shortcuts.js';
import type { OperationId } from '../src/types.js';

// A keydown as the page sees it: no modifier and no code unless given.
const key = (init: Partial<KeyLike> & { key: string }): KeyLike => ({ code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...init });
const MAC = true;
const OTHER = false; // Linux and Windows share one table (#585)
const IDS = SHORTCUTS.map((s) => s.id).join(', ');
const pair = (id: OperationId): [string | null, string | null] => [shortcutDef(id).defaults.mac, shortcutDef(id).defaults.other];

test('normalizeBinding orders the modifiers and uppercases a letter; it refuses a lone letter, Shift on a letter, a lone modifier, an unknown key, a repeated modifier, and Escape, which is no binding (#481)', () => {
  assert.equal(normalizeBinding('Shift+CmdOrCtrl+j'), 'CmdOrCtrl+Shift+J');
  assert.equal(normalizeBinding('Alt+Ctrl+1'), 'Ctrl+Alt+1');
  for (const ok of ['Shift+Enter', 'F5', 'CmdOrCtrl+,', 'Alt+`', 'CmdOrCtrl+Shift+Z', 'CmdOrCtrl+Shift+PageDown', 'CmdOrCtrl+PageUp']) assert.equal(normalizeBinding(ok), ok, ok);
  const refused = ['J', 'Shift+J', 'Shift+,', 'Shift', 'CmdOrCtrl', 'Cmd+J', 'CmdOrCtrl+CmdOrCtrl+J', '', 'CmdOrCtrl+', 'Escape', 'Shift+Escape', 'CmdOrCtrl+Escape'];
  for (const bad of refused) assert.equal(normalizeBinding(bad), undefined, bad);
});

test('bindingFromEvent maps Cmd to CmdOrCtrl on macOS and Ctrl to CmdOrCtrl elsewhere, and takes letters, digits and punctuation from code (#449)', () => {
  assert.equal(bindingFromEvent(key({ key: 'j', code: 'KeyJ', metaKey: true }), true), 'CmdOrCtrl+J');
  assert.equal(bindingFromEvent(key({ key: 'j', code: 'KeyJ', ctrlKey: true }), true), 'Ctrl+J', 'Ctrl is its own modifier on macOS');
  assert.equal(bindingFromEvent(key({ key: 'j', code: 'KeyJ', ctrlKey: true }), false), 'CmdOrCtrl+J');
  assert.equal(bindingFromEvent(key({ key: '∆', code: 'KeyJ', altKey: true }), true), 'Alt+J', 'Alt on macOS types a symbol; code keeps the key');
  assert.equal(bindingFromEvent(key({ key: '¡', code: 'Digit1', altKey: true }), true), 'Alt+1');
  assert.equal(bindingFromEvent(key({ key: '≤', code: 'Comma', altKey: true }), true), 'Alt+,');
  assert.equal(bindingFromEvent(key({ key: '\\', code: 'Backslash', metaKey: true }), true), 'CmdOrCtrl+\\');
  assert.equal(bindingFromEvent(key({ key: '>', code: 'Period', metaKey: true, shiftKey: true }), true), 'CmdOrCtrl+Shift+.', 'Shift turns . into >; code keeps the key');
  assert.equal(bindingFromEvent(key({ key: 'Escape', code: 'Escape' }), true), undefined, 'Escape is no binding (#481)');
  assert.equal(bindingFromEvent(key({ key: 'Escape', code: 'Escape', shiftKey: true }), true), undefined);
  assert.equal(bindingFromEvent(key({ key: 'ArrowUp', code: 'ArrowUp', shiftKey: true }), true), 'Shift+Up');
  assert.equal(bindingFromEvent(key({ key: 'j', ctrlKey: true }), false), 'CmdOrCtrl+J', 'no code (a synthetic event): the key');
  assert.equal(bindingFromEvent(key({ key: 'j', code: 'KeyJ' }), true), undefined, 'a lone letter would eat typing');
  assert.equal(bindingFromEvent(key({ key: 'Meta', code: 'MetaLeft', metaKey: true }), true), undefined, 'a lone modifier');
  assert.equal(bindingFromEvent(key({ key: 'j', code: 'KeyJ', ctrlKey: true, metaKey: true }), false), undefined, 'off macOS the Windows key binds nothing');
});

test('matches needs the exact modifiers: Cmd+Shift+J is not Cmd+J (#449)', () => {
  const cmdJ = key({ key: 'j', code: 'KeyJ', metaKey: true });
  assert.equal(matches(cmdJ, 'CmdOrCtrl+J', true), true);
  assert.equal(matches({ ...cmdJ, shiftKey: true }, 'CmdOrCtrl+J', true), false);
  assert.equal(matches(cmdJ, 'CmdOrCtrl+Shift+J', true), false);
  assert.equal(matches(key({ key: 'j', code: 'KeyJ', ctrlKey: true }), 'CmdOrCtrl+J', true), false, 'Ctrl is not Cmd on macOS');
  assert.equal(matches(key({ key: 'Enter', code: 'Enter', shiftKey: true }), 'Shift+Enter', true), true);
});

test('every shortcut has a macOS and a Linux / Windows default, each stored normalized or unbound (null, #818); off macOS a key the terminal reads moves to Ctrl+Shift (#585)', () => {
  for (const def of SHORTCUTS) {
    for (const binding of [def.defaults.mac, def.defaults.other]) if (binding !== null) assert.equal(normalizeBinding(binding), binding, `${def.id}: ${binding}`);
  }
  assert.deepEqual(pair('toggleLeft'), ['CmdOrCtrl+B', 'CmdOrCtrl+Shift+B']);
  assert.deepEqual(pair('toggleRight'), ['CmdOrCtrl+Shift+B', 'CmdOrCtrl+Alt+Shift+B']);
  assert.deepEqual(pair('searchOperations'), ['CmdOrCtrl+Shift+P', 'F1']);
  assert.deepEqual(pair('openDiff'), ['CmdOrCtrl+Alt+C', 'CmdOrCtrl+Shift+G'], 'Ctrl+Alt is AltGr on Windows: VS Code\'s source control key instead');
  assert.deepEqual(pair('viewActivities'), ['CmdOrCtrl+1', 'CmdOrCtrl+1'], 'activities first (#746)');
  assert.deepEqual(pair('viewFlow'), ['CmdOrCtrl+2', 'CmdOrCtrl+2']);
  assert.deepEqual(pair('searchTasks'), ['CmdOrCtrl+F', 'CmdOrCtrl+F']);
});

test('effectiveBindings puts a change and a null over this platform\'s defaults: the macOS table on macOS, the other one elsewhere (#449, #585)', () => {
  const mac = effectiveBindings({}, MAC);
  const other = effectiveBindings({}, OTHER);
  for (const def of SHORTCUTS) assert.deepEqual([mac[def.id], other[def.id]], [def.defaults.mac, def.defaults.other], def.id);
  assert.deepEqual(effectiveBindings({ toggleRight: 'CmdOrCtrl+Shift+T', clear: null }, OTHER), { ...other, toggleRight: 'CmdOrCtrl+Shift+T', clear: null });
  assert.deepEqual([defaultBinding(shortcutDef('clear'), MAC), defaultBinding(shortcutDef('clear'), OTHER)], ['CmdOrCtrl+K', 'CmdOrCtrl+Shift+K']);
});

test('neither platform\'s defaults collide with each other or with a key the menus keep (#591, #585)', () => {
  assert.deepEqual(collisions({}, MAC), []);
  assert.deepEqual(collisions({}, OTHER), []);
});

test('collisions finds two enabled shortcuts on one binding of this platform and one on a reserved binding, and ignores one turned off (#449, #585)', () => {
  assert.deepEqual(collisions({ close: 'CmdOrCtrl+1' }, MAC), [['viewActivities', 'close']]);
  assert.deepEqual(collisions({ toggleConsole: 'CmdOrCtrl+K' }, MAC), [['toggleConsole', 'clear']]);
  assert.deepEqual(collisions({ toggleConsole: 'CmdOrCtrl+K' }, OTHER), [], 'off macOS clear is Ctrl+Shift+K');
  assert.deepEqual(collisions({ toggleConsole: 'CmdOrCtrl+Shift+K' }, OTHER), [['toggleConsole', 'clear']]);
  assert.deepEqual(collisions({ toggleLeft: 'CmdOrCtrl+C' }, OTHER), [['toggleLeft', 'reserved']]);
  assert.deepEqual(collisions({ close: 'CmdOrCtrl+1', viewActivities: null }, MAC), [], 'off frees its key');
});

test('takesTerminalKey: Ctrl+letter or Ctrl+punctuation without Shift, F1–F12, and the editing and moving keys, alone or with Shift; Ctrl is literal on macOS and CmdOrCtrl off it (#585)', () => {
  for (const isMac of [MAC, OTHER]) {
    for (const taken of ['Ctrl+W', 'Ctrl+\\', 'F1', 'F12', 'Shift+Tab', 'Enter', 'Backspace', 'Up', 'Shift+Left']) assert.equal(takesTerminalKey(taken, isMac), true, `${taken} ${isMac}`);
    for (const free of ['Ctrl+Shift+W', 'Ctrl+1', 'Alt+Enter', 'Ctrl+Alt+C', 'CmdOrCtrl+Shift+J', 'Shift+F1']) assert.equal(takesTerminalKey(free, isMac), false, `${free} ${isMac}`);
  }
  assert.equal(takesTerminalKey('CmdOrCtrl+W', MAC), false, 'Cmd+W reaches no program on macOS');
  assert.equal(takesTerminalKey('CmdOrCtrl+W', OTHER), true, 'off macOS CmdOrCtrl+W is Ctrl+W');
  assert.equal(takesTerminalKey('CmdOrCtrl+/', OTHER), true, 'Ctrl+/ off macOS: kept, with the warning');
});

test('off macOS Ctrl is CmdOrCtrl before any compare: Ctrl+X matches and collides as CmdOrCtrl+X there, not on macOS (#585)', () => {
  assert.equal(canonicalBinding('Ctrl+Shift+X', OTHER), 'CmdOrCtrl+Shift+X');
  assert.equal(canonicalBinding('CmdOrCtrl+Ctrl+F', OTHER), 'CmdOrCtrl+F', 'one physical key there');
  assert.equal(canonicalBinding('Ctrl+Shift+X', MAC), 'Ctrl+Shift+X');
  const ctrlX = key({ key: 'x', code: 'KeyX', ctrlKey: true });
  assert.equal(matches(ctrlX, 'Ctrl+X', OTHER), true, 'no longer a binding that never matches off macOS');
  assert.equal(matches(ctrlX, 'Ctrl+X', MAC), true);
  assert.equal(matches(key({ key: 'x', code: 'KeyX', metaKey: true }), 'Ctrl+X', MAC), false, 'Cmd is not Ctrl on macOS');
  assert.deepEqual(collisions({ toggleConsole: 'Ctrl+Shift+K' }, OTHER), [['toggleConsole', 'clear']]);
  assert.deepEqual(collisions({ toggleConsole: 'Ctrl+K' }, MAC), []);
  assert.deepEqual(collisions({ toggleLeft: 'Ctrl+C' }, OTHER), [['toggleLeft', 'reserved']], 'Ctrl+C off macOS is the Edit menu\'s copy');
  assert.deepEqual(collisions({ toggleLeft: 'Ctrl+C' }, MAC), []);
});

test('displayBinding writes the macOS symbols, or the modifiers\' names elsewhere (#449)', () => {
  assert.equal(displayBinding('CmdOrCtrl+Shift+J', true), '⌘⇧J');
  assert.equal(displayBinding('Ctrl+Alt+1', true), '⌃⌥1');
  assert.equal(displayBinding('CmdOrCtrl+Shift+J', false), 'Ctrl+Shift+J');
  assert.equal(displayBinding('F5', true), 'F5');
});

test('confirm and feedbackQueue keep one default on every platform, never in a terminal, and rebind, turn off and collide like any other; feedbackStart is no shortcut any more (#446, #585)', () => {
  for (const id of ['confirm', 'feedbackQueue'] as const) assert.equal(shortcutDef(id).inTerminal, false, id);
  assert.deepEqual([pair('confirm'), pair('feedbackQueue')], [['CmdOrCtrl+Enter', 'CmdOrCtrl+Enter'], ['CmdOrCtrl+Shift+Enter', 'CmdOrCtrl+Shift+Enter']]);
  assert.deepEqual(parseShortcuts({ confirm: 'Alt+Enter', feedbackQueue: null }, OTHER), { confirm: 'Alt+Enter', feedbackQueue: null });
  assert.throws(() => parseShortcuts({ confirm: 'CmdOrCtrl+1' }, MAC), { message: 'hive.config.json: "shortcuts.viewActivities" and "shortcuts.confirm" are both CmdOrCtrl+1' });
  assert.throws(() => parseShortcuts({ feedbackStart: 'Alt+Enter' }, MAC), { message: `hive.config.json: "shortcuts" names "feedbackStart", which is no shortcut (${IDS})` });
});

test('the registry is the map: the five scopes in order, every row in its scope, the soon ones marked, and inTerminal for the global and activity keys (#585)', () => {
  assert.deepEqual([...new Set(SHORTCUT_MAP.map((row) => row.scope))], [...SHORTCUT_SCOPES], 'contiguous, in scope order');
  const rows = (scope: ShortcutScope): string[] => SHORTCUT_MAP.filter((row) => row.scope === scope).map((row) => ('keys' in row ? `fixed:${row.id}` : row.id));
  assert.deepEqual(rows('global'), ['viewActivities', 'viewFlow', 'search', 'searchOperations', 'newActivity', 'runCommand', 'toggleConsole', 'fixed:signal', 'toggleLeft', 'toggleRight', 'fixed:settings', 'shortcutMap', 'fullScreen', 'closeWindow', 'fixed:quit']);
  assert.deepEqual(rows('activities'), ['newTerminal', 'newSession', 'openDiff', 'close', 'nextTab', 'prevTab', 'fixed:goToTab', 'fixed:copy', 'fixed:paste', 'fixed:selectAll', 'splitSame', 'splitTerminalVertical', 'splitTerminalHorizontal', 'clear', 'findInTerminal', 'nextPane', 'prevPane', 'nextActivity', 'prevActivity', 'toggleSideTab', 'sleepSession', 'sleepAll']);
  assert.deepEqual(rows('files'), ['treeNewFile', 'treeNewFolder', 'treeRename', 'treeDelete', 'treeReveal', 'treeOpenTerminal', 'treeCopyPath', 'treeCopyRelativePath', 'treeCopyCheckoutPath', 'fixed:treeCut', 'fixed:treeCopy', 'fixed:treePaste']);
  assert.deepEqual(rows('flow'), ['searchTasks', 'fixed:moveFocus', 'fixed:openDetails', 'fixed:closeDetails', 'fixed:runStages', 'fixed:freeSession', 'fixed:approve', 'fixed:feedback', 'fixed:openActivity', 'fixed:autoTask', 'fixed:taskMenu', 'fixed:pickSource', 'refreshFlow', 'goBack', 'zoomOut', 'zoomIn', 'zoomReset', 'fixed:zoomFit']);
  assert.deepEqual(rows('dialogs'), ['confirm', 'feedbackQueue', 'switchStartMode', 'fixed:cancel']);
  assert.deepEqual(SHORTCUTS.filter((s) => s.soon).map((s) => s.id), ['nextTab', 'prevTab', 'nextPane', 'prevPane', 'nextActivity', 'prevActivity']);
  assert.deepEqual(FIXED_SHORTCUTS.filter((f) => f.soon).map((f) => f.id), ['goToTab']);
  for (const def of SHORTCUTS) assert.equal(def.inTerminal, def.scope === 'global' || def.scope === 'activities', def.id);
  assert.deepEqual([pair('fullScreen'), pair('closeWindow'), pair('refreshFlow'), pair('nextActivity')], [['CmdOrCtrl+Shift+F', 'F11'], ['CmdOrCtrl+Shift+W', 'CmdOrCtrl+Alt+Shift+W'], ['CmdOrCtrl+Alt+R', 'F5'], ['CmdOrCtrl+Alt+Down', 'CmdOrCtrl+Shift+PageDown']]);
  assert.deepEqual([fixedShortcut('signal').keys, fixedShortcut('taskMenu').keys], [{ mac: ['CmdOrCtrl+Alt+1', 'CmdOrCtrl+Alt+2', 'CmdOrCtrl+Alt+3'], other: ['CmdOrCtrl+Shift+1', 'CmdOrCtrl+Shift+2', 'CmdOrCtrl+Shift+3'] }, { mac: ['M'], other: ['M', 'Shift+F10'] }]);
});

test('findInTerminal is Cmd+F on macOS and Ctrl+Shift+F elsewhere, an activity key that acts in the terminal, and meets neither searchTasks nor fullScreen (#12)', () => {
  assert.deepEqual(pair('findInTerminal'), ['CmdOrCtrl+F', 'CmdOrCtrl+Shift+F']);
  assert.equal(shortcutDef('findInTerminal').scope, 'activities');
  assert.equal(shortcutDef('findInTerminal').inTerminal, true);
  assert.equal(takesTerminalKey('CmdOrCtrl+Shift+F', OTHER), false, "Ctrl+F stays readline's forward-char off macOS");
  assert.deepEqual(collisions({ searchTasks: 'CmdOrCtrl+Shift+F' }, OTHER), [], 'the flow and the activities never meet');
  assert.deepEqual(collisions({ findInTerminal: 'CmdOrCtrl+K' }, MAC), [['clear', 'findInTerminal']]);
});

test('sleepSession and sleepAll keep stopSession\'s and stopAll\'s keys; the old ids are no shortcut any more (#672)', () => {
  assert.deepEqual([pair('sleepSession'), pair('sleepAll')], [['CmdOrCtrl+.', 'CmdOrCtrl+Shift+.'], ['CmdOrCtrl+Shift+.', 'CmdOrCtrl+Alt+Shift+.']]);
  assert.throws(() => parseShortcuts({ stopSession: null }, MAC), { message: `hive.config.json: "shortcuts" names "stopSession", which is no shortcut (${IDS})` });
});

test('two keys collide only when both act in one scope or one of them is global, a fixed key of a scope included (#585)', () => {
  assert.deepEqual(collisions({ searchTasks: 'CmdOrCtrl+K' }, MAC), [], 'the flow\'s key and an activity\'s: never both live');
  assert.deepEqual(collisions({ confirm: 'CmdOrCtrl+Shift+K' }, OTHER), [], 'a dialog\'s key and an activity\'s');
  assert.deepEqual(collisions({ toggleConsole: 'CmdOrCtrl+F' }, MAC), [['toggleConsole', 'findInTerminal'], ['toggleConsole', 'searchTasks']], 'a global key meets the flow and the activities');
  assert.deepEqual(collisions({ refreshFlow: 'Alt+3' }, OTHER), [['refreshFlow', fixedShortcut('pickSource')]], 'a fixed key of the flow');
  assert.deepEqual(collisions({ clear: 'Alt+3' }, MAC), [], 'go to tab is Ctrl+1–9 on macOS');
});

test('a soon shortcut\'s default blocks a change onto its key, and a soon fixed range does too; a soon id always resolves to its default (#585)', () => {
  assert.deepEqual(collisions({ toggleConsole: 'Ctrl+Tab' }, MAC), [['toggleConsole', 'nextTab']]);
  assert.deepEqual(collisions({ clear: 'Alt+3' }, OTHER), [['clear', fixedShortcut('goToTab')]], 'Alt+1–9 off macOS, reserved for the tabs');
  assert.equal(effectiveBindings({ nextTab: null }, MAC).nextTab, 'Ctrl+Tab');
});

test('the shortcut map is live with the key #585 reserved: CmdOrCtrl+/ on both tables, nameable in the config, and neither platform\'s defaults collide (#639)', () => {
  assert.equal(shortcutDef('shortcutMap').soon, undefined);
  assert.deepEqual(pair('shortcutMap'), ['CmdOrCtrl+/', 'CmdOrCtrl+/']);
  assert.deepEqual([collisions({}, MAC), collisions({}, OTHER)], [[], []]);
  assert.deepEqual(parseShortcuts({ shortcutMap: 'CmdOrCtrl+Shift+/' }, OTHER), { shortcutMap: 'CmdOrCtrl+Shift+/' });
  assert.deepEqual(parseShortcuts({ shortcutMap: null }, MAC), { shortcutMap: null });
  assert.equal(effectiveBindings({ shortcutMap: null }, MAC).shortcutMap, null, 'off, as any live shortcut');
});

test('copy, paste and select all are live fixed rows of the activities scope: ⌘C, ⌘V, ⌘A on macOS; Ctrl+Shift+C or Ctrl+Insert, Ctrl+Shift+V or Shift+Insert, Ctrl+Shift+A elsewhere (#644)', () => {
  const ids = ['copy', 'paste', 'selectAll'] as const;
  assert.deepEqual(ids.map((id) => [fixedShortcut(id).scope, fixedShortcut(id).soon, fixedShortcut(id).keys]), [
    ['activities', undefined, { mac: ['CmdOrCtrl+C'], other: ['CmdOrCtrl+Shift+C', 'CmdOrCtrl+Insert'] }],
    ['activities', undefined, { mac: ['CmdOrCtrl+V'], other: ['CmdOrCtrl+Shift+V', 'Shift+Insert'] }],
    ['activities', undefined, { mac: ['CmdOrCtrl+A'], other: ['CmdOrCtrl+Shift+A'] }],
  ]);
  assert.deepEqual([collisions({}, MAC), collisions({}, OTHER)], [[], []], 'neither platform\'s defaults collide with them');
  assert.deepEqual(collisions({ toggleConsole: 'CmdOrCtrl+Shift+C' }, OTHER), [['toggleConsole', fixedShortcut('copy')]], 'a global key meets the activities');
  assert.deepEqual(collisions({ clear: 'Ctrl+Shift+V' }, OTHER), [['clear', fixedShortcut('paste')]], 'an activity key; Ctrl is CmdOrCtrl off macOS');
  assert.deepEqual(collisions({ toggleLeft: 'CmdOrCtrl+Shift+A' }, OTHER), [['toggleLeft', fixedShortcut('selectAll')]]);
  assert.deepEqual(collisions({ newTerminal: 'CmdOrCtrl+Insert' }, OTHER), [['newTerminal', fixedShortcut('copy')]]);
  assert.deepEqual(collisions({ searchTasks: 'CmdOrCtrl+Shift+C' }, OTHER), [], 'the flow\'s key never acts in a terminal');
  assert.deepEqual(collisions({ toggleLeft: 'CmdOrCtrl+C' }, MAC), [['toggleLeft', 'reserved']], 'on macOS the rows\' keys are the menus\' already');
  assert.throws(() => parseShortcuts({ toggleConsole: 'CmdOrCtrl+Shift+V' }, OTHER), { message: 'hive.config.json: "shortcuts.toggleConsole" is CmdOrCtrl+Shift+V, which the fixed key "paste" holds' });
});

test('Insert is a named key: Ctrl+Insert and Shift+Insert normalize, and a keydown of them matches with exactly its modifiers (#644)', () => {
  for (const ok of ['Shift+Insert', 'Ctrl+Insert', 'CmdOrCtrl+Insert']) assert.equal(normalizeBinding(ok), ok, ok);
  const insert = (init: Partial<KeyLike>): KeyLike => key({ key: 'Insert', code: 'Insert', ...init });
  assert.equal(bindingFromEvent(insert({ shiftKey: true }), OTHER), 'Shift+Insert');
  assert.equal(matches(insert({ shiftKey: true }), 'Shift+Insert', OTHER), true);
  assert.equal(matches(insert({ ctrlKey: true }), 'CmdOrCtrl+Insert', OTHER), true);
  assert.equal(matches(insert({ ctrlKey: true, shiftKey: true }), 'CmdOrCtrl+Insert', OTHER), false);
  assert.equal(matches(insert({}), 'Shift+Insert', OTHER), false);
});

test('a fixed range blocks a change onto one of its digits, and the parser names the fixed key (#585)', () => {
  assert.deepEqual(collisions({ toggleConsole: 'CmdOrCtrl+Alt+2' }, MAC), [['toggleConsole', fixedShortcut('signal')]]);
  assert.deepEqual(collisions({ toggleConsole: 'Ctrl+Shift+2' }, OTHER), [['toggleConsole', fixedShortcut('signal')]], 'Ctrl is CmdOrCtrl off macOS');
  assert.throws(() => parseShortcuts({ toggleConsole: 'CmdOrCtrl+Alt+2' }, MAC), { message: 'hive.config.json: "shortcuts.toggleConsole" is CmdOrCtrl+Alt+2, which the fixed key "signal" holds' });
});

test('naming a soon id or feedbackStart is a parse error (#585)', () => {
  assert.throws(() => parseShortcuts({ nextTab: null }, MAC), { message: 'hive.config.json: "shortcuts.nextTab" is not available yet' });
  assert.throws(() => parseShortcuts({ nextActivity: 'CmdOrCtrl+Alt+PageDown' }, OTHER), { message: 'hive.config.json: "shortcuts.nextActivity" is not available yet' });
  assert.throws(() => parseShortcuts({ feedbackStart: null }, MAC), { message: `hive.config.json: "shortcuts" names "feedbackStart", which is no shortcut (${IDS})` });
});

test('displayKeys writes a digit range as one key and lists the rest; displayBinding writes the arrows, Esc and macOS\'s ↵ (#585)', () => {
  assert.equal(displayKeys(fixedShortcut('signal').keys.mac, MAC), '⌘⌥1–3');
  assert.equal(displayKeys(fixedShortcut('signal').keys.other, OTHER), 'Ctrl+Shift+1–3');
  assert.equal(displayKeys(fixedShortcut('pickSource').keys.other, OTHER), 'Alt+0–9');
  assert.equal(displayKeys(fixedShortcut('moveFocus').keys.mac, MAC), '↑ ↓ ← →');
  assert.equal(displayKeys(fixedShortcut('taskMenu').keys.other, OTHER), 'M Shift+F10');
  assert.equal(displayBinding('CmdOrCtrl+Enter', MAC), '⌘↵');
  assert.equal(displayBinding('CmdOrCtrl+Enter', OTHER), 'Ctrl+Enter');
  assert.equal(displayBinding('Escape', OTHER), 'Esc');
});

test('Cmd+, Shift+Enter and Escape are fixed keys: no shortcut, their ids are refused, the first two are reserved and Escape is no binding (#481)', () => {
  assert.deepEqual(FIXED_BINDINGS, { settings: 'CmdOrCtrl+,', newline: 'Shift+Enter', closePanel: 'Escape' });
  const ids: readonly string[] = SHORTCUTS.map((s) => s.id);
  for (const fixed of ['settings', 'newline', 'closePanel']) assert.equal(ids.includes(fixed), false, fixed);
  assert.throws(() => parseShortcuts({ newline: null }, MAC), { message: `hive.config.json: "shortcuts" names "newline", which is no shortcut (${IDS})` });
  assert.throws(() => parseShortcuts({ clear: 'Shift+Enter' }, MAC), { message: 'hive.config.json: "shortcuts.clear" is Shift+Enter, which the Edit or app menu keeps' });
  assert.throws(() => parseShortcuts({ clear: 'CmdOrCtrl+,' }, OTHER), { message: 'hive.config.json: "shortcuts.clear" is CmdOrCtrl+,, which the Edit or app menu keeps' });
  const badBinding = 'hive.config.json: "shortcuts.clear" must be null (off) or a key binding like CmdOrCtrl+Shift+J; a letter, digit or punctuation key needs CmdOrCtrl, Ctrl or Alt';
  for (const binding of ['Escape', 'Shift+Escape', 'CmdOrCtrl+Escape']) assert.throws(() => parseShortcuts({ clear: binding }, MAC), { message: badBinding }, binding);
});


test('the files tree\'s keys (#818): rename ↵ / F2, delete ⌘⌫ / Delete, reveal ⌥⌘R on both tables; new file, new folder, the terminal and the copy paths unbound until bound', () => {
  assert.deepEqual([pair('treeRename'), pair('treeDelete'), pair('treeReveal')], [['Enter', 'F2'], ['CmdOrCtrl+Backspace', 'Delete'], ['CmdOrCtrl+Alt+R', 'CmdOrCtrl+Alt+R']]);
  for (const id of ['treeNewFile', 'treeNewFolder', 'treeOpenTerminal', 'treeCopyPath', 'treeCopyRelativePath', 'treeCopyCheckoutPath'] as const) {
    assert.deepEqual([effectiveBindings({}, MAC)[id], effectiveBindings({}, OTHER)[id]], [null, null], id);
  }
  assert.deepEqual(parseShortcuts({ treeNewFile: 'CmdOrCtrl+Alt+N' }, MAC), { treeNewFile: 'CmdOrCtrl+Alt+N' });
  assert.deepEqual([fixedShortcut('treeCut').keys.mac, fixedShortcut('treeCopy').keys.other, fixedShortcut('treePaste').scope], [['CmdOrCtrl+X'], ['CmdOrCtrl+C'], 'files']);
});

test('a files key meets the activities and the global keys, never the flow\'s: ⌥⌘R is the flow\'s refresh too (#818)', () => {
  assert.deepEqual(collisions({ treeReveal: 'CmdOrCtrl+T' }, MAC), [['newTerminal', 'treeReveal']]);
  assert.deepEqual(collisions({ treeReveal: 'CmdOrCtrl+P' }, MAC), [['search', 'treeReveal']]);
  assert.deepEqual(collisions({ treeReveal: 'CmdOrCtrl+F' }, MAC), [['findInTerminal', 'treeReveal']], 'the files tree meets the activities (find in terminal, #12), not the flow\'s search');
  assert.deepEqual([collisions({}, MAC), collisions({}, OTHER)], [[], []]);
});

test('the flow\'s zoom keys (#910): ⌘- ⌘= ⌘0 on both tables, flow rows never in a terminal, and fit the handoff\'s ⇧1 as a fixed flow key; colliding with nothing', () => {
  const ids = ['zoomOut', 'zoomIn', 'zoomReset'] as const;
  assert.deepEqual(ids.map(pair), [['CmdOrCtrl+-', 'CmdOrCtrl+-'], ['CmdOrCtrl+=', 'CmdOrCtrl+='], ['CmdOrCtrl+0', 'CmdOrCtrl+0']]);
  assert.deepEqual(ids.map((id) => [shortcutDef(id).scope, shortcutDef(id).inTerminal]), ids.map(() => ['flow', false]));
  assert.deepEqual([fixedShortcut('zoomFit').scope, fixedShortcut('zoomFit').keys], ['flow', { mac: ['Shift+1'], other: ['Shift+1'] }]);
  // Shift+digit types (#585), so no binding takes it and bindingFromEvent never yields it: the reason fit is fixed and the flow matches it by hand
  assert.equal(normalizeBinding('Shift+1'), undefined);
  assert.deepEqual([displayKeys(['Shift+1'], MAC), displayKeys(['Shift+1'], OTHER)], ['⇧1', 'Shift+1']);
  assert.equal(bindingFromEvent(key({ key: '=', code: 'Equal', metaKey: true }), MAC), 'CmdOrCtrl+=');
  assert.equal(bindingFromEvent(key({ key: '-', code: 'Minus', ctrlKey: true }), OTHER), 'CmdOrCtrl+-');
  assert.deepEqual([collisions({}, MAC), collisions({}, OTHER)], [[], []]);
});

test('goBack (#911): ⌘[ on macOS and Alt+Left elsewhere, a flow key never in a terminal, colliding with nothing: prevPane\'s reserved ⌘[ acts only with an activity shown', () => {
  assert.deepEqual(pair('goBack'), ['CmdOrCtrl+[', 'Alt+Left']);
  assert.deepEqual([shortcutDef('goBack').scope, shortcutDef('goBack').inTerminal], ['flow', false]);
  assert.equal(bindingFromEvent(key({ key: '[', code: 'BracketLeft', metaKey: true }), MAC), 'CmdOrCtrl+[');
  assert.equal(bindingFromEvent(key({ key: 'ArrowLeft', code: 'ArrowLeft', altKey: true }), OTHER), 'Alt+Left');
  assert.deepEqual([displayBinding('CmdOrCtrl+[', MAC), displayBinding('Alt+Left', OTHER)], ['⌘[', 'Alt+←']);
  assert.deepEqual([collisions({}, MAC), collisions({}, OTHER)], [[], []]);
});
