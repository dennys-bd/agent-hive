import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Runs from dist/test: the sources are read as text, since neither is a module node can load (a stylesheet; main.ts needs Electron).
const source = (path: string): string => readFileSync(fileURLToPath(new URL(`../../src/${path}`, import.meta.url)), 'utf8');
const CSS = source('ui/theme.css').replace(/\/\*[\s\S]*?\*\//g, ''); // comments may carry ; or {
const LIGHT_BLOCK = ':root[data-theme="light"]';

// The custom properties of one rule of theme.css, by exact selector.
function block(selector: string): Map<string, string> {
  const body = new RegExp(`${selector.replace(/[[\]]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(CSS)?.[1];
  assert.ok(body !== undefined, `${selector} missing from theme.css`);
  return new Map([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m): [string, string] => [m[1], m[2].trim()]));
}

const DARK = block(':root');
const LIGHT = new Map([...DARK, ...block(LIGHT_BLOCK)]); // what the light page computes: the overrides over :root

// WCAG 2 relative luminance of a #rrggbb color, and the contrast ratio of two.
function luminance(hex: string): number {
  assert.match(hex, /^#[0-9a-f]{6}$/i, hex);
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string): number => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
};
const TEXT_MIN = 4.5; // WCAG AA for text: the strip's and the toggle's ink
const UI_MIN = 3; // WCAG AA for a UI component against what surrounds it: the signal colors on the page

test('every token of the dark :root is redeclared for light or is a var() alias, and the light block declares nothing new (#296)', () => {
  const light = block(LIGHT_BLOCK);
  const missing = [...DARK].filter(([name, value]) => !light.has(name) && !/^var\(--[\w-]+\)$/.test(value)).map(([name]) => name);
  assert.deepEqual(missing, [], 'a token the light theme would inherit from the dark one');
  assert.deepEqual([...light.keys()].filter((name) => !DARK.has(name)), [], 'a light token no dark rule defines');
  assert.ok(DARK.has('--blink') && DARK.has('--signal-ink'), 'the two colors that used to be hard-coded or borrowed');
});

test('in both themes the signal ink reads at 4.5:1 on green, yellow and red, and those reach 3:1 on the background (#296)', () => {
  for (const [name, tokens] of [['dark', DARK], ['light', LIGHT]] as const) {
    const color = (token: string): string => tokens.get(token) ?? assert.fail(`${name}: ${token} missing`);
    for (const signal of ['--working', '--waiting', '--destructive']) {
      const ink = contrast(color('--signal-ink'), color(signal));
      assert.ok(ink >= TEXT_MIN, `${name}: --signal-ink on ${signal} is ${ink.toFixed(2)}:1`);
      const page = contrast(color(signal), color('--background'));
      assert.ok(page >= UI_MIN, `${name}: ${signal} on --background is ${page.toFixed(2)}:1`);
    }
  }
});

test('WINDOW_BACKGROUND in main.ts holds the two --background values: the window paints them before the page (#296)', () => {
  const match = /WINDOW_BACKGROUND = \{ dark: '(#[0-9a-f]{6})', light: '(#[0-9a-f]{6})' \}/i.exec(source('main.ts'));
  assert.deepEqual(match?.slice(1), [DARK.get('--background'), LIGHT.get('--background')]);
});

test('in both themes the text reads at 4.5:1 on an added and on a deleted diff line (#270)', () => {
  for (const [name, tokens] of [['dark', DARK], ['light', LIGHT]] as const) {
    const color = (token: string): string => tokens.get(token) ?? assert.fail(`${name}: ${token} missing`);
    for (const line of ['--diff-add', '--diff-del']) {
      const ratio = contrast(color('--foreground'), color(line));
      assert.ok(ratio >= TEXT_MIN, `${name}: --foreground on ${line} is ${ratio.toFixed(2)}:1`);
    }
  }
});

test('--backoff is the orange of the backoff status, darker on white, and reads at 3:1 on the background in both themes (#805)', () => {
  assert.deepEqual([DARK.get('--backoff'), LIGHT.get('--backoff')], ['#f08a3c', '#c2410c']);
  for (const [name, tokens] of [['dark', DARK], ['light', LIGHT]] as const) {
    const ratio = contrast(tokens.get('--backoff') ?? '', tokens.get('--background') ?? '');
    assert.ok(ratio >= UI_MIN, `${name}: --backoff on --background is ${ratio.toFixed(2)}:1`);
  }
});

test('--agent-codex is declared in both themes, apart from green, yellow and red, and reads at 3:1 on the background (#927)', () => {
  assert.ok(DARK.has('--agent-codex') && block(LIGHT_BLOCK).has('--agent-codex'), 'both themes');
  for (const [name, tokens] of [['dark', DARK], ['light', LIGHT]] as const) {
    const codex = tokens.get('--agent-codex') ?? '';
    for (const signal of ['--working', '--waiting', '--destructive']) assert.notEqual(codex, tokens.get(signal), `${name}: ${signal}`);
    const ratio = contrast(codex, tokens.get('--background') ?? '');
    assert.ok(ratio >= UI_MIN, `${name}: --agent-codex on --background is ${ratio.toFixed(2)}:1`);
  }
});
