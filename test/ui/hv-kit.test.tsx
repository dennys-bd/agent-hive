import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, expect, test } from 'vitest';

// The plugin's interaction kit (#232): what a screen's data-hv-* markup does on a click, run as a design frame runs it, by delegation on
// the document. It loads once per file, as a screen loads it once per page; each test mounts its own markup after the first.
const KIT = readFileSync(join(process.cwd(), 'assets', 'plugin', 'reference', 'hv-kit.js'), 'utf8');
const root = document.documentElement;
const el = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;
const click = (id: string): void => { el(id).click(); };
const key = (name: string): void => { document.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true })); };

const MARKUP = `
  <nav><button id="go-a" data-hv-set="view=a">a</button><button id="go-b" data-hv-set="view=b">b</button></nav>
  <button id="menu-btn" data-hv-toggle="menu">menu</button>
  <div id="menu" data-hv-layer="popover" hidden>
    <div data-hv-group data-hv-label="menu-btn"><button id="pick-1" data-hv-pick>one</button><button id="pick-2" data-hv-pick>two</button></div>
  </div>
  <button id="open-dialog" data-hv-open="dialog">new</button>
  <div id="dialog" data-hv-layer hidden><div id="overlay" data-hv-close></div><button id="inside">field</button><button id="cancel" data-hv-close>cancel</button></div>
  <button id="sw" role="switch" aria-checked="false" data-hv-switch></button>
  <p id="outside">outside</p>`;

function mount(view = 'a'): void {
  document.body.innerHTML = MARKUP;
  root.setAttribute('data-view', view);
}

beforeAll(() => {
  mount('b');
  new Function(KIT)();
});

test('at load, the kit marks the control that holds the state authored on <html>', () => {
  expect(el('go-b')).toHaveAttribute('aria-current', 'true');
  expect(el('go-a')).not.toHaveAttribute('aria-current');
});

test('data-hv-set moves the screen state on <html> and the current mark with it', () => {
  mount();
  click('go-b');
  expect(root.getAttribute('data-view')).toBe('b');
  expect(el('go-b')).toHaveAttribute('aria-current', 'true');
  expect(el('go-a')).not.toHaveAttribute('aria-current');
});

test('data-hv-toggle opens and closes its target and keeps aria-expanded in step', () => {
  mount();
  click('menu-btn');
  expect(el('menu')).not.toHaveAttribute('hidden');
  expect(el('menu-btn')).toHaveAttribute('aria-expanded', 'true');
  click('menu-btn');
  expect(el('menu')).toHaveAttribute('hidden');
  expect(el('menu-btn')).toHaveAttribute('aria-expanded', 'false');
});

test('a pick selects within its group, labels the group\'s trigger and closes the popover it sits in', () => {
  mount();
  click('menu-btn');
  click('pick-2');
  expect(el('pick-2')).toHaveAttribute('aria-selected', 'true');
  expect(el('pick-1')).toHaveAttribute('aria-selected', 'false');
  expect(el('menu-btn')).toHaveTextContent('two');
  expect(el('menu')).toHaveAttribute('hidden');
});

test('a popover closes on a click outside it and on Escape', () => {
  mount();
  click('menu-btn');
  click('outside');
  expect(el('menu')).toHaveAttribute('hidden');
  click('menu-btn');
  key('Escape');
  expect(el('menu')).toHaveAttribute('hidden');
});

test('a dialog opens by data-hv-open, stays open on a click inside, and closes by data-hv-close or Escape', () => {
  mount();
  click('open-dialog');
  click('inside');
  expect(el('dialog')).not.toHaveAttribute('hidden');
  click('cancel');
  expect(el('dialog')).toHaveAttribute('hidden');
  click('open-dialog');
  click('overlay');
  expect(el('dialog')).toHaveAttribute('hidden');
  click('open-dialog');
  key('Escape');
  expect(el('dialog')).toHaveAttribute('hidden');
});

test('a switch flips aria-checked and data-state', () => {
  mount();
  click('sw');
  expect(el('sw')).toHaveAttribute('aria-checked', 'true');
  expect(el('sw')).toHaveAttribute('data-state', 'checked');
  click('sw');
  expect(el('sw')).toHaveAttribute('aria-checked', 'false');
});

test('data-hv-set never writes the pane\'s own attributes: a theme or a tweak name is ignored', () => {
  root.setAttribute('data-theme', 'dark');
  document.body.innerHTML = '<button id="t" data-hv-set="theme=light">x</button><button id="w" data-hv-set="tweak-layout=list">y</button>';
  click('t');
  click('w');
  expect(root.getAttribute('data-theme')).toBe('dark');
  expect(root.hasAttribute('data-tweak-layout')).toBe(false);
});
