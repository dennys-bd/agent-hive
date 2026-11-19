import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Input } from 'electron';
import { FRAME_KEY_CHANNEL, type FrameKey, type FrameKeyContents, forwardFrameKeys, frameKeyOf } from '../src/frame-keys.js';
import { fixedShortcut, SHORTCUTS } from '../src/shortcut-registry.js';
import { defaultBinding, fixedKeys } from '../src/shortcuts.js';
import type { Shortcuts } from '../src/types.js';

const PLATFORMS = [true, false]; // macOS, then Linux and Windows: the rule is pure, so both run on every OS
const PUNCTUATION_CODES: Record<string, string> = { ',': 'Comma', '.': 'Period', '/': 'Slash', '\\': 'Backslash', '[': 'BracketLeft', ']': 'BracketRight', '-': 'Minus', '=': 'Equal' };

function codeOf(key: string): string {
  if (/^[A-Z]$/.test(key)) return `Key${key}`;
  if (/^\d$/.test(key)) return `Digit${key}`;
  return PUNCTUATION_CODES[key] ?? key; // F1, Tab: the code is the name
}

// Electron's Input for `binding` as the keyboard sends it: CmdOrCtrl is meta on macOS and control elsewhere
function inputOf(binding: string, isMac: boolean, type = 'keyDown'): Input {
  const parts = binding.split('+');
  const last = parts[parts.length - 1];
  const has = (mod: string): boolean => parts.slice(0, -1).includes(mod);
  return {
    type, key: last.length === 1 ? last.toLowerCase() : last, code: codeOf(last),
    meta: isMac && has('CmdOrCtrl'), control: (!isMac && has('CmdOrCtrl')) || has('Ctrl'), alt: has('Alt'), shift: has('Shift'),
    isAutoRepeat: false, isComposing: false, location: 0, modifiers: [],
  };
}
const keyLikeOf = (input: Input): FrameKey =>
  ({ key: input.key, code: input.code, metaKey: input.meta, ctrlKey: input.control, altKey: input.alt, shiftKey: input.shift, repeat: input.isAutoRepeat });
const forwards = (binding: string, isMac: boolean, shortcuts = {}): boolean => frameKeyOf(inputOf(binding, isMac), shortcuts, isMac) !== undefined;

// The global and activities shortcuts a frame keeps on their default, in map order: the menu's (fullScreen, closeWindow, close), the
// terminal's own (clear, findInTerminal) and, off macOS, F1, which has no Cmd, Ctrl or Alt. Every other one must cross
const KEPT: Record<'mac' | 'other', string[]> = {
  mac: ['fullScreen', 'closeWindow', 'close', 'clear', 'findInTerminal'],
  other: ['searchOperations', 'fullScreen', 'closeWindow', 'close', 'clear', 'findInTerminal'],
};

test('every global and activities shortcut\'s default crosses a frame as the key itself, on both platforms, but the ones a frame keeps (#906)', () => {
  for (const isMac of PLATFORMS) {
    const scoped = SHORTCUTS.filter((def) => (def.scope === 'global' || def.scope === 'activities') && def.soon === undefined);
    const kept: string[] = [];
    for (const def of scoped) {
      const binding = defaultBinding(def, isMac);
      assert.ok(binding !== null, `${def.id} ships bound`);
      const input = inputOf(binding, isMac);
      const sent = frameKeyOf(input, {}, isMac);
      if (sent === undefined) kept.push(def.id);
      else assert.deepEqual(sent, keyLikeOf(input), `${def.id} is sent as pressed`);
    }
    assert.deepEqual(kept, KEPT[isMac ? 'mac' : 'other'], isMac ? 'macOS' : 'elsewhere');
  }
});

test('the signal\'s fixed keys cross a frame; Settings\' and Quit\'s, global fixed rows too, are reserved and stay the menu\'s (#906)', () => {
  for (const isMac of PLATFORMS) {
    assert.deepEqual(fixedKeys(fixedShortcut('signal'), isMac).map((key) => forwards(key, isMac)), [true, true, true]);
    assert.deepEqual(['CmdOrCtrl+,', 'CmdOrCtrl+Q'].map((key) => forwards(key, isMac)), [false, false]);
  }
});

test('a soon shortcut, a files, flow or dialog key, a bare or Shift key, a reserved key and a keyUp stay the frame\'s (#906)', () => {
  assert.equal(forwards('Ctrl+Tab', true), false, 'nextTab is soon: nothing would act on it');
  assert.equal(forwards('CmdOrCtrl+Alt+R', true), false, 'treeReveal and refreshFlow act only with their own focus');
  assert.equal(forwards('CmdOrCtrl+=', true), false, 'zoomIn is the flow\'s');
  assert.equal(forwards('CmdOrCtrl+Enter', true), false, 'confirm is a dialog\'s');
  assert.equal(forwards('B', true), false, 'typing');
  assert.equal(forwards('Shift+B', false), false, 'typing');
  assert.deepEqual(['CmdOrCtrl+C', 'CmdOrCtrl+V', 'CmdOrCtrl+Z', 'CmdOrCtrl+A'].map((key) => forwards(key, true)), [false, false, false, false]);
  assert.equal(frameKeyOf(inputOf('CmdOrCtrl+B', true, 'keyUp'), {}, true), undefined);
  const windowsKey = { ...inputOf('CmdOrCtrl+B', false), meta: true };
  assert.equal(frameKeyOf(windowsKey, {}, false), undefined, 'off macOS the Windows key has no accelerator name');
});

test('the bindings are the user\'s: a rebound key crosses and its old one stays, one turned off crosses no more, and a menu key stays the menu\'s on any binding (#906)', () => {
  assert.deepEqual([forwards('CmdOrCtrl+Alt+L', true, { toggleLeft: 'CmdOrCtrl+Alt+L' }), forwards('CmdOrCtrl+B', true, { toggleLeft: 'CmdOrCtrl+Alt+L' })], [true, false]);
  assert.equal(forwards('CmdOrCtrl+B', true, { toggleLeft: null }), false);
  assert.equal(forwards('CmdOrCtrl+Alt+W', true, { close: 'CmdOrCtrl+Alt+W' }), false, 'the menu\'s Close carries it in every frame');
  assert.equal(forwards('CmdOrCtrl+W', true, { close: 'CmdOrCtrl+Alt+W' }), false, '⌘W is no shortcut any more');
});

const MAIN_FRAME = 1;
const DESIGN_FRAME = 2;

// A window's WebContents with the frame `focused` names (null: nothing focused): `press` runs the listener and answers whether it prevented
function fakeContents(focused: number | null) {
  let listener: ((event: { preventDefault(): void }, input: Input) => void) | undefined;
  const sent: unknown[][] = [];
  const contents: FrameKeyContents = {
    on: (_event, callback) => { listener = callback; },
    focusedFrame: focused === null ? null : { frameTreeNodeId: focused },
    mainFrame: { frameTreeNodeId: MAIN_FRAME },
    send: (...args) => { sent.push(args); },
  };
  const press = (input: Input): boolean => {
    let isPrevented = false;
    listener?.({ preventDefault: () => { isPrevented = true; } }, input);
    return isPrevented;
  };
  return { contents, sent, press };
}

test('forwardFrameKeys: with a subframe focused a forwarded key is prevented and sent on window:frameKey; any other key goes on (#906)', () => {
  const { contents, sent, press } = fakeContents(DESIGN_FRAME);
  forwardFrameKeys(contents, () => ({ shortcuts: {}, isMac: true }));
  const toggleLeft = inputOf('CmdOrCtrl+B', true);
  assert.deepEqual([press(toggleLeft), press(inputOf('CmdOrCtrl+C', true)), press(inputOf('B', true))], [true, false, false]);
  assert.deepEqual(sent, [[FRAME_KEY_CHANNEL, keyLikeOf(toggleLeft)]]);
});

test('a held key crosses as a held key: the OS repeat reaches the page as repeat (#906)', () => {
  const held = { ...inputOf('CmdOrCtrl+B', true), isAutoRepeat: true };
  assert.equal(frameKeyOf(held, {}, true)?.repeat, true);
  assert.equal(frameKeyOf(inputOf('CmdOrCtrl+B', true), {}, true)?.repeat, false);
});

test('forwardFrameKeys: with the main frame focused, or nothing, every key goes on untouched; the page\'s own listeners have it (#906)', () => {
  for (const focused of [MAIN_FRAME, null]) {
    const { contents, sent, press } = fakeContents(focused);
    forwardFrameKeys(contents, () => ({ shortcuts: {}, isMac: true }));
    assert.equal(press(inputOf('CmdOrCtrl+B', true)), false);
    assert.deepEqual(sent, []);
  }
});

test('forwardFrameKeys reads the shortcuts at each key: a Settings save reaches the next one (#906)', () => {
  let shortcuts: Shortcuts = {};
  const { contents, press } = fakeContents(DESIGN_FRAME);
  forwardFrameKeys(contents, () => ({ shortcuts, isMac: false }));
  assert.equal(press(inputOf('CmdOrCtrl+Shift+B', false)), true);
  shortcuts = { toggleLeft: null };
  assert.equal(press(inputOf('CmdOrCtrl+Shift+B', false)), false);
});
