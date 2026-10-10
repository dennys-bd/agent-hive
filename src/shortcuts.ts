// The rules of a keyboard shortcut's binding (#449): normalize, match a keydown, collide, warn, display, parse. The shortcuts and their
// defaults per platform live in shortcut-registry.ts (#585). Shared by main (the app menu's accelerators), the main window's page, the terminal
// window, the settings form and the config parser, so it has no Node or Electron import: the UI bundles it. A binding is an Electron accelerator
// (CmdOrCtrl is Cmd on macOS, Ctrl elsewhere), stored normalized so equal bindings compare equal.
import { FIXED_SHORTCUTS, type FixedShortcut, type ShortcutDef, type ShortcutScope, SHORTCUTS, shortcutDef } from './shortcut-registry.js';
import type { OperationId, Shortcuts } from './types.js';

export type Bindings = Record<OperationId, string | null>;
/** A shortcut and what it collides with: another shortcut, a key the menus keep, or a fixed key (#585). */
export type Collision = [OperationId, OperationId | 'reserved' | FixedShortcut];

/** The part of a KeyboardEvent a binding reads; node:test builds it as a plain object. */
export interface KeyLike { key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }

/** The keys that act but are no shortcut (#481): never listed, rebound or turned off. Cmd+, is the macOS convention for an app's settings,
 * Shift+Enter is the sequence Claude Code's /terminal-setup expects, and Escape is what every panel closes on. The app menu, the terminal
 * and the detail panel read them here. */
export const FIXED_BINDINGS = { settings: 'CmdOrCtrl+,', newline: 'Shift+Enter', closePanel: 'Escape' } as const;

const FILE = 'hive.config.json'; // config.ts's CONFIG_FILE, which this module cannot import: config.ts reads the disk (as in run-commands.ts)
const MODIFIERS = ['CmdOrCtrl', 'Ctrl', 'Alt', 'Shift'] as const; // the normalized order
type Modifier = (typeof MODIFIERS)[number];
const PUNCTUATION = [',', '.', '/', ';', "'", '[', ']', '\\', '-', '=', '`'];
// Escape is no binding (#481): it closes panels and cancels a recording, so no shortcut may hold it. PageUp and PageDown since #585: the
// activity navigation's planned keys off macOS. Insert since #644: Ctrl+Insert and Shift+Insert copy and paste in the terminal off macOS.
const NAMED_KEYS = ['Enter', 'Tab', 'Backspace', 'Delete', 'Insert', 'Space', 'Up', 'Down', 'Left', 'Right', 'PageUp', 'PageDown', ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`)];
// A letter, digit or punctuation key with only Shift, or nothing, would eat typing: it needs one of these.
const TYPING_GUARDS: readonly Modifier[] = ['CmdOrCtrl', 'Ctrl', 'Alt'];
// The Edit and app menus' roles (#242): on macOS copy and paste only reach a page through them. Off macOS the menu no longer takes them
// (#644), but the text fields still handle Ctrl+C / V / X / Z / A natively, so no shortcut may take them there either. And the fixed keys a
// binding could hold (#481): a shortcut on Cmd+, or Shift+Enter would fire with it. Escape needs no entry, since no binding can be Escape.
const RESERVED: readonly string[] = ['CmdOrCtrl+C', 'CmdOrCtrl+V', 'CmdOrCtrl+X', 'CmdOrCtrl+Z', 'CmdOrCtrl+Shift+Z', 'CmdOrCtrl+A', 'CmdOrCtrl+Q', 'CmdOrCtrl+H', 'CmdOrCtrl+Alt+H', 'CmdOrCtrl+M', FIXED_BINDINGS.settings, FIXED_BINDINGS.newline];
// What a terminal's program reads (#585): the editing and moving keys, alone or with Shift, and F1–F12. Ctrl+letter and Ctrl+punctuation
// are checked apart, since Ctrl is a different modifier on and off macOS; Ctrl+Shift+letter sends the same byte, so the program loses nothing.
// Taking one warns, never blocks.
const TERMINAL_NAMED = /^(?:(?:Shift\+)?(?:Tab|Enter|Backspace|Up|Down|Left|Right)|F(?:[1-9]|1[0-2]))$/;
const MAC_SYMBOL: Record<Modifier, string> = { CmdOrCtrl: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧' };
// Letters, digits and punctuation come from the key's position (code): with Alt on macOS `key` is a symbol (∆ for Alt+J, ≤ for Alt+,).
const CODE_KEY = /^(?:Key([A-Z])|Digit([0-9]))$/;
const CODE_PUNCTUATION: Record<string, string> = {
  Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Backslash: '\\', Minus: '-', Equal: '=', Backquote: '`',
};
const EVENT_KEY: Record<string, string> = { ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' };
// How a key reads (#585): the arrows as arrows and Escape as Esc on every platform; Enter reads ↵ on macOS, as its menus write it
const KEY_SYMBOL: Readonly<Record<string, string>> = { Up: '↑', Down: '↓', Left: '←', Right: '→', Escape: 'Esc' };

const isModifier = (part: string): part is Modifier => (MODIFIERS as readonly string[]).includes(part);
const isTypingKey = (key: string): boolean => /^[A-Z0-9]$/.test(key) || PUNCTUATION.includes(key);

/** The binding with its modifiers in the fixed order and a letter uppercased; undefined when it is not one a shortcut may take. */
export function normalizeBinding(text: string): string | undefined {
  const parts = text.split('+');
  const last = parts[parts.length - 1];
  const key = last.length === 1 ? last.toUpperCase() : last;
  const mods = parts.slice(0, -1);
  if (!(isTypingKey(key) || NAMED_KEYS.includes(key)) || !mods.every(isModifier) || new Set(mods).size !== mods.length) return undefined;
  const ordered = MODIFIERS.filter((m) => mods.includes(m));
  if (isTypingKey(key) && !ordered.some((m) => TYPING_GUARDS.includes(m))) return undefined;
  return [...ordered, key].join('+');
}

/** A binding as it compares (#585): off macOS Ctrl is CmdOrCtrl, the same physical key, before any match, collision or warning. */
export function canonicalBinding(binding: string, isMac: boolean): string {
  if (isMac) return binding;
  const parts = binding.split('+');
  const mods = parts.slice(0, -1).map((m) => (m === 'Ctrl' ? 'CmdOrCtrl' : m));
  return [...MODIFIERS.filter((m) => mods.includes(m)), parts[parts.length - 1]].join('+');
}

// The key's accelerator name. A synthetic event without a code (the tests' fireEvent) falls back to `key`.
function keyOf(event: KeyLike): string {
  const code = CODE_KEY.exec(event.code);
  if (code) return code[1] ?? code[2];
  if (Object.hasOwn(CODE_PUNCTUATION, event.code)) return CODE_PUNCTUATION[event.code];
  const key = EVENT_KEY[event.key] ?? event.key;
  return key.length === 1 ? key.toUpperCase() : key;
}

/** What a keydown is as a binding, normalized: Cmd is CmdOrCtrl and Ctrl is Ctrl on macOS, Ctrl is CmdOrCtrl elsewhere. undefined for a
 * lone modifier or any combination normalizeBinding refuses. */
export function bindingFromEvent(event: KeyLike, isMac: boolean): string | undefined {
  if (!isMac && event.metaKey) return undefined; // off macOS the Windows key has no accelerator name here
  const mods = [
    (isMac ? event.metaKey : event.ctrlKey) ? 'CmdOrCtrl' : '',
    isMac && event.ctrlKey ? 'Ctrl' : '',
    event.altKey ? 'Alt' : '',
    event.shiftKey ? 'Shift' : '',
  ].filter((m) => m !== '');
  return normalizeBinding([...mods, keyOf(event)].join('+'));
}

/** Whether a keydown is `binding` with exactly its modifiers: Cmd+Shift+J never fires Cmd+J. Off macOS a Ctrl+… binding is CmdOrCtrl+… (#585). */
export function matches(event: KeyLike, binding: string, isMac: boolean): boolean {
  const pressed = bindingFromEvent(event, isMac);
  return pressed !== undefined && pressed === canonicalBinding(binding, isMac);
}

/** A shortcut's default on this platform (#585): the macOS table, or the one Linux and Windows share; null when it ships unbound (#818). */
export const defaultBinding = (def: ShortcutDef, isMac: boolean): string | null => (isMac ? def.defaults.mac : def.defaults.other);

/** A fixed row's keys on this platform (#585). */
export const fixedKeys = (fixed: FixedShortcut, isMac: boolean): readonly string[] => (isMac ? fixed.keys.mac : fixed.keys.other);

/** A shortcut's binding: the user's change over this platform's default (null = off). A soon one is always its default (#585): the config
 * may not name it, and its key stays reserved. */
export function bindingOf(shortcuts: Shortcuts, def: ShortcutDef, isMac: boolean): string | null {
  const change = def.soon ? undefined : shortcuts[def.id];
  return change === undefined ? defaultBinding(def, isMac) : change;
}

/** Every shortcut's binding on this platform. */
export function effectiveBindings(shortcuts: Shortcuts, isMac: boolean): Bindings {
  return Object.fromEntries(SHORTCUTS.map((def) => [def.id, bindingOf(shortcuts, def, isMac)])) as Bindings;
}

// Two keys meet when one can fire where the other acts (#585): the same scope, or either one global. The flow's keys act only with the flow
// shown and an activity's only with one shown, so Alt+1–9 can be both. The files tree sits inside the activities view, so its keys meet the
// activities' too (#818), never the flow's.
const isFilesAndActivities = (a: ShortcutScope, b: ShortcutScope): boolean => (a === 'files' && b === 'activities') || (a === 'activities' && b === 'files');
const scopesMeet = (a: ShortcutScope, b: ShortcutScope): boolean => a === b || a === 'global' || b === 'global' || isFilesAndActivities(a, b);

interface Held { binding: string; scope: ShortcutScope }

// Every fixed key that is a binding, canonical. A bare letter or Escape is none, so no shortcut can take it anyway
function fixedHeld(isMac: boolean): (Held & { fixed: FixedShortcut })[] {
  return FIXED_SHORTCUTS.flatMap((fixed) => fixedKeys(fixed, isMac).flatMap((key) => {
    const binding = normalizeBinding(key);
    return binding === undefined ? [] : [{ fixed, scope: fixed.scope, binding: canonicalBinding(binding, isMac) }];
  }));
}

/** The blocking collisions, in the map's order (#449, #585): a shortcut on a key the menus keep, or two keys that meet (see scopesMeet), a
 * soon default and a fixed key included. Compared in their canonical form. Off ones never collide. */
export function collisions(shortcuts: Shortcuts, isMac: boolean): Collision[] {
  const bindings = effectiveBindings(shortcuts, isMac);
  const on = SHORTCUTS.flatMap((def) => {
    const binding = bindings[def.id];
    return binding === null ? [] : [{ id: def.id, scope: def.scope, binding: canonicalBinding(binding, isMac) }];
  });
  const fixed = fixedHeld(isMac);
  return on.flatMap(({ id, scope, binding }, i): Collision[] => {
    if (RESERVED.includes(binding)) return [[id, 'reserved']];
    const meets = (other: Held): boolean => other.binding === binding && scopesMeet(scope, other.scope);
    return [
      ...on.slice(i + 1).filter(meets).map((other): Collision => [id, other.id]),
      ...fixed.filter(meets).map((other): Collision => [id, other.fixed]),
    ];
  });
}

/** Whether a binding takes a key the terminal's program reads (#585): the warning under an in-terminal shortcut's row. */
export function takesTerminalKey(binding: string, isMac: boolean): boolean {
  const canonical = canonicalBinding(binding, isMac);
  const [mod, key, ...rest] = canonical.split('+');
  const isCtrlKey = rest.length === 0 && mod === (isMac ? 'Ctrl' : 'CmdOrCtrl') && key !== undefined && (/^[A-Z]$/.test(key) || PUNCTUATION.includes(key));
  return isCtrlKey || TERMINAL_NAMED.test(canonical);
}

/** A binding as the user reads it: ⌘⇧J on macOS, Ctrl+Shift+J elsewhere; the arrows, Esc and macOS's ↵ as symbols (#585). */
export function displayBinding(binding: string, isMac: boolean): string {
  const parts = binding.split('+');
  const last = parts[parts.length - 1];
  const key = isMac && last === 'Enter' ? '↵' : (Object.hasOwn(KEY_SYMBOL, last) ? KEY_SYMBOL[last] : last);
  const mods = parts.slice(0, -1) as Modifier[];
  if (isMac) return `${mods.map((m) => MAC_SYMBOL[m]).join('')}${key}`;
  return [...mods.map((m) => (m === 'CmdOrCtrl' ? 'Ctrl' : m)), key].join('+');
}

const DIGIT_KEY = /^(.*?)(\d)$/;

/** A fixed row's keys as the user reads them (#585): a digit range as one key (⌘⌥1–3), anything else each key, space-separated. */
export function displayKeys(keys: readonly string[], isMac: boolean): string {
  const found = keys.map((key) => DIGIT_KEY.exec(key));
  const prefix = found[0]?.[1];
  const isRange = keys.length > 1 && found.every((m) => m !== null && m[1] === prefix);
  if (!isRange) return keys.map((key) => displayBinding(key, isMac)).join(' ');
  const values = found.map((m) => Number(m?.[2]));
  return `${displayBinding(`${prefix}${Math.min(...values)}`, isMac)}–${Math.max(...values)}`;
}

const IDS: readonly string[] = SHORTCUTS.map((s) => s.id);

const isOperationId = (id: string): id is OperationId => IDS.includes(id);

function parseBinding(id: string, value: unknown): string | null {
  if (!isOperationId(id)) throw new Error(`${FILE}: "shortcuts" names "${id}", which is no shortcut (${IDS.join(', ')})`);
  if (shortcutDef(id).soon) throw new Error(`${FILE}: "shortcuts.${id}" is not available yet`); // #585: its operation does not exist yet
  if (value === null) return null;
  const binding = typeof value === 'string' ? normalizeBinding(value) : undefined;
  if (binding === undefined) {
    throw new Error(`${FILE}: "shortcuts.${id}" must be null (off) or a key binding like CmdOrCtrl+Shift+J; a letter, digit or punctuation key needs CmdOrCtrl, Ctrl or Alt`);
  }
  return binding;
}

function collisionMessage([id, other]: Collision, binding: string | null): string {
  if (other === 'reserved') return `${FILE}: "shortcuts.${id}" is ${binding}, which the Edit or app menu keeps`;
  if (typeof other === 'object') return `${FILE}: "shortcuts.${id}" is ${binding}, which the fixed key "${other.id}" holds`;
  return `${FILE}: "shortcuts.${id}" and "shortcuts.${other}" are both ${binding}`;
}

/** hive.config.json's "shortcuts" (#449): required, the user's changes only, each binding normalized, over the defaults of the platform it
 * is parsed on (#585). A soon id may not be named. Two keys that meet never both work, a menu role's key is how copy and paste reach a page,
 * and a fixed key never changes, so each is refused by name. */
export function parseShortcuts(raw: unknown, isMac: boolean): Shortcuts {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${FILE}: "shortcuts" must be an object of shortcut ids to a key binding or null ({} = every default)`);
  }
  const shortcuts = Object.fromEntries(Object.entries(raw as Record<string, unknown>).map(([id, value]) => [id, parseBinding(id, value)])) as Shortcuts;
  const [clash] = collisions(shortcuts, isMac);
  if (clash === undefined) return shortcuts;
  throw new Error(collisionMessage(clash, effectiveBindings(shortcuts, isMac)[clash[0]]));
}
