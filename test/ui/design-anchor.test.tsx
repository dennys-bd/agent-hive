import { afterEach, expect, test, vi } from 'vitest';
import {
  cssPath, type ElementAnchor, elementAnchor, findAnchor, isAnchorList, isEditable, pinRects, rectOverlap,
} from '../../src/design-anchor';
import type { DesignTarget } from '../../src/types';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

// jsdom lays nothing out: a test gives an element the box it needs
const place = (el: Element, x: number, y: number, width: number, height: number): void => {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(
    { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height, toJSON: () => ({}) } as DOMRect,
  );
};

test('a clicked element\'s selector finds that same element again, by its unique id or by nth-of-type steps (#112)', () => {
  document.body.innerHTML = '<main id="app"><section><p>One</p><p>Two</p></section></main><div><span id="dup">a</span><span id="dup">b</span></div>';
  const two = document.querySelectorAll('p')[1];
  const dup = document.querySelectorAll('span')[1];
  expect(cssPath(document.getElementById('app')!)).toBe('#app');
  expect(cssPath(two)).toBe('#app > section:nth-of-type(1) > p:nth-of-type(2)');
  expect(cssPath(dup)).toBe('body > div:nth-of-type(1) > span:nth-of-type(2)');
  expect(findAnchor(document, elementAnchor(two))).toBe(two);
  expect(findAnchor(document, elementAnchor(dup))).toBe(dup);
});

test('after the element moves elsewhere in the DOM, findAnchor finds it by its text, the deepest match (#112)', () => {
  document.body.innerHTML = '<section><h2>Plans</h2><p>Pick a plan</p></section><aside></aside>';
  const p = document.querySelector('p')!;
  const anchor = elementAnchor(p);
  document.querySelector('aside')!.append(p); // the aside's text is now the same: the deeper p wins
  expect(findAnchor(document, anchor)).toBe(p);
});

test('when the element is gone, findAnchor answers null and pinRects reports it as null; an area anchor is never removed (#112)', () => {
  document.body.innerHTML = '<p>Bye</p>';
  const anchor = elementAnchor(document.querySelector('p')!);
  document.body.innerHTML = '<div>Other</div>';
  const area: DesignTarget = { kind: 'area', rect: { x: 10, y: 400, width: 50, height: 20 } };
  vi.stubGlobal('scrollY', 300);
  expect(findAnchor(document, anchor)).toBeNull();
  expect(pinRects(document, [{ id: 'a', anchor }, { id: 'b', anchor: area }])).toEqual([
    { id: 'a', rect: null }, { id: 'b', rect: { x: 10, y: 100, width: 50, height: 20 } },
  ]);
});

test('the selector landing on an element with different text falls through to the text step (#112)', () => {
  document.body.innerHTML = '<ul><li>Alpha</li><li>Beta</li></ul>';
  const beta = document.querySelectorAll('li')[1];
  const anchor = elementAnchor(beta);
  document.querySelector('ul')!.insertAdjacentHTML('afterbegin', '<li>New</li>'); // li:nth-of-type(2) is now Alpha
  expect(findAnchor(document, anchor)).toBe(beta);
});

test('the position step takes an element of the same tag overlapping at least half, never one overlapping less nor an overlay (#112)', () => {
  const anchor: ElementAnchor = { kind: 'element', selector: 'body > p:nth-of-type(1)', text: 'Before', rect: { x: 0, y: 0, width: 100, height: 100 } };
  document.body.innerHTML = '<p data-hive></p><p>After</p>';
  const [overlay, p] = Array.from(document.querySelectorAll('p'));
  place(overlay, 0, 0, 100, 100);
  place(p, 0, 20, 100, 100); // 8000 / 12000
  expect(findAnchor(document, anchor)).toBe(p);
  place(p, 0, 40, 100, 100); // 6000 / 14000
  expect(findAnchor(document, anchor)).toBeNull();
  expect(rectOverlap({ x: 0, y: 0, width: 100, height: 100 }, { x: 0, y: 50, width: 100, height: 100 })).toBeCloseTo(1 / 3);
});

test('isEditable holds for an input, a textarea, a select and a content-editable element, and not for a button (#112)', () => {
  document.body.innerHTML = '<input><textarea></textarea><select></select><div contenteditable="true"><b>x</b></div><button>Go</button><div contenteditable="false">y</div>';
  const pick = (selector: string): Element | null => document.querySelector(selector);
  expect(['input', 'textarea', 'select', '[contenteditable="true"]', 'b'].map((s) => isEditable(pick(s)))).toEqual([true, true, true, true, true]);
  expect([pick('button'), pick('[contenteditable="false"]'), null].map((el) => isEditable(el))).toEqual([false, false, false]);
});

test('isAnchorList accepts the protocol\'s anchors and nothing else (#112)', () => {
  const rect = { x: 0, y: 0, width: 1, height: 1 };
  expect(isAnchorList([{ id: 'a', anchor: { kind: 'element', selector: 'p', text: '', rect } }, { id: 'b', anchor: { kind: 'area', rect } }])).toBe(true);
  expect(isAnchorList([])).toBe(true);
  const bad = [
    null, {}, [{ id: 1, anchor: { kind: 'area', rect } }], [{ id: 'a', anchor: { kind: 'area', rect: { x: 0 } } }],
    [{ id: 'a', anchor: { kind: 'element', selector: 'p', rect } }], [{ id: 'a', anchor: { kind: 'circle', rect } }],
  ];
  expect(bad.map((value) => isAnchorList(value))).toEqual([false, false, false, false, false, false]);
});

test('an element from a part names it by the nearest data-hv-source; the screen\'s own fill names none; a text-filled slot\'s holder names its slot; findAnchor ignores both (#421)', () => {
  document.body.innerHTML = [
    '<nav data-hv-source="parts/sidebar.html"><a>Issues</a></nav>',
    '<aside data-hv-source="parts/detail.html"><h2 data-hv-fill="title">Fix login</h2><p data-hv-source="issue.hv.html">Body</p></aside>',
    '<main><p>Plain</p></main>',
  ].join('');
  const [a, h2, body, plain] = ['nav > a', 'h2', 'aside > p', 'main > p'].map((selector) => document.querySelector(selector)!);
  expect(elementAnchor(a)).toEqual({ kind: 'element', selector: 'body > nav:nth-of-type(1) > a:nth-of-type(1)', text: 'Issues', rect: { x: 0, y: 0, width: 0, height: 0 }, part: 'parts/sidebar.html' });
  expect(Object.keys(elementAnchor(a))).not.toContain('slot');
  expect(elementAnchor(h2)).toMatchObject({ part: 'parts/detail.html', slot: 'title' });
  expect(Object.keys(elementAnchor(body))).not.toContain('part');
  expect(Object.keys(elementAnchor(plain))).toEqual(['kind', 'selector', 'text', 'rect']);
  expect(findAnchor(document, elementAnchor(h2))).toBe(h2);
});
