import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';

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

// data-hv-hover: a card revealed while the pointer or focus is on its link or on the card, with a grace so the pointer can cross the gap.
const GRACE_MS = 150;
const HOVER_MARKUP = '<a id="link" href="#x" data-hv-hover="card">ref</a><div id="card" hidden><a id="card-link" href="#y">open</a></div><p id="away">away</p>';
const move = (type: 'pointerover' | 'pointerout', id: string, to?: string): void => {
  el(id).dispatchEvent(new MouseEvent(type, { bubbles: true, relatedTarget: to ? el(to) : null }));
};
const focus = (type: 'focusin' | 'focusout', id: string, to?: string): void => {
  el(id).dispatchEvent(new FocusEvent(type, { bubbles: true, relatedTarget: to ? el(to) : null }));
};
const mountHover = (): void => {
  vi.useFakeTimers();
  document.body.innerHTML = HOVER_MARKUP;
  // the kit loads once per file, so Escape clears where the previous test left the pointer and focus
  key('Escape');
};

afterEach(() => { vi.useRealTimers(); });

test('data-hv-hover shows its element while the pointer is over the control and sets aria-expanded', () => {
  mountHover();
  expect(el('card')).toHaveAttribute('hidden');
  move('pointerover', 'link', 'away');
  expect(el('card')).not.toHaveAttribute('hidden');
  expect(el('link')).toHaveAttribute('aria-expanded', 'true');
});

test('the element stays open while the pointer crosses from the control into it, even past the grace', () => {
  mountHover();
  move('pointerover', 'link', 'away');
  move('pointerout', 'link', 'card');
  move('pointerover', 'card', 'link');
  vi.advanceTimersByTime(GRACE_MS * 2);
  expect(el('card')).not.toHaveAttribute('hidden');
});

test('once both are left the element hides after the grace, not before', () => {
  mountHover();
  move('pointerover', 'link', 'away');
  move('pointerout', 'link', 'away');
  vi.advanceTimersByTime(GRACE_MS - 1);
  expect(el('card')).not.toHaveAttribute('hidden');
  vi.advanceTimersByTime(1);
  expect(el('card')).toHaveAttribute('hidden');
  expect(el('link')).toHaveAttribute('aria-expanded', 'false');
});

test('re-entering the control or the element before the grace cancels the hide', () => {
  mountHover();
  move('pointerover', 'link', 'away');
  move('pointerout', 'link', 'away');
  vi.advanceTimersByTime(GRACE_MS - 50);
  move('pointerover', 'card', 'away');
  vi.advanceTimersByTime(GRACE_MS * 2);
  expect(el('card')).not.toHaveAttribute('hidden');
  move('pointerout', 'card', 'away');
  vi.advanceTimersByTime(GRACE_MS - 50);
  move('pointerover', 'link', 'away');
  vi.advanceTimersByTime(GRACE_MS * 2);
  expect(el('card')).not.toHaveAttribute('hidden');
});

test('focus shows the element and keeps it while focus moves into a link inside it', () => {
  mountHover();
  focus('focusin', 'link');
  expect(el('card')).not.toHaveAttribute('hidden');
  focus('focusout', 'link', 'card-link');
  focus('focusin', 'card-link', 'link');
  vi.advanceTimersByTime(GRACE_MS * 2);
  expect(el('card')).not.toHaveAttribute('hidden');
  focus('focusout', 'card-link', 'away');
  vi.advanceTimersByTime(GRACE_MS);
  expect(el('card')).toHaveAttribute('hidden');
});

test('Escape hides a shown hover element at once and a pending hide does not reopen it', () => {
  mountHover();
  move('pointerover', 'link', 'away');
  move('pointerout', 'link', 'away');
  key('Escape');
  expect(el('card')).toHaveAttribute('hidden');
  expect(el('link')).toHaveAttribute('aria-expanded', 'false');
  vi.advanceTimersByTime(GRACE_MS);
  expect(el('card')).toHaveAttribute('hidden');
});

test('the pointer leaving keeps the element shown while focus is still on the control, and the other way round', () => {
  mountHover();
  focus('focusin', 'link', 'away');
  move('pointerover', 'link', 'away');
  move('pointerout', 'link', 'away');
  vi.advanceTimersByTime(GRACE_MS);
  expect(el('card')).not.toHaveAttribute('hidden');
  focus('focusout', 'link', 'away');
  vi.advanceTimersByTime(GRACE_MS);
  expect(el('card')).toHaveAttribute('hidden');
});

test('a move over a child of the control counts as the control', () => {
  mountHover();
  el('link').innerHTML = '<span id="link-child">ref</span>';
  move('pointerover', 'link-child', 'away');
  expect(el('card')).not.toHaveAttribute('hidden');
  move('pointerout', 'link-child', 'link');
  vi.advanceTimersByTime(GRACE_MS);
  expect(el('card')).not.toHaveAttribute('hidden');
});
