// The comment mode's anchors (#112): how the bridge names an element so it can find it again after the design changes, and where each
// pin goes. bridgeScript joins these functions into the frame's one script, where imports cannot cross, so each one is self-contained:
// it reads its arguments and browser globals, calls only functions of this file, and keeps its constants inside its own body.

import type { DesignRect, DesignTarget } from './types.js'; // type-only: erased, so nothing crosses into the joined script

// The wire shape is #111's DesignTarget: the pane adds path, viewport and theme and stores what the bridge posts unchanged
export type Rect = DesignRect;
export type ElementAnchor = Extract<DesignTarget, { kind: 'element' }>;
export interface Pin { id: string; rect: Rect | null }
/** One anchor of the parent's list: the pane's id for its comment, and the anchor as the bridge made it. */
export interface AnchorEntry { id: string; anchor: DesignTarget }

/** The element's own id when it is a plain, unique one, else nth-of-type steps up to such an id or to body. No CSS.escape: jsdom
 *  lacks it, and a plain id needs none. */
export function cssPath(el: Element): string {
  const doc = el.ownerDocument;
  let steps: string[] = [];
  for (let node: Element | null = el; node && node !== doc.body && node !== doc.documentElement; node = node.parentElement) {
    const current: Element = node;
    if (/^[A-Za-z][\w-]*$/.test(current.id) && doc.querySelectorAll(`#${current.id}`).length === 1) {
      return [`#${current.id}`, ...steps].join(' > ');
    }
    const siblings = current.parentElement ? Array.from(current.parentElement.children) : [current];
    const nth = siblings.filter((sibling) => sibling.tagName === current.tagName).indexOf(current) + 1;
    steps = [`${current.tagName.toLowerCase()}:nth-of-type(${nth})`, ...steps];
  }
  return ['body', ...steps].join(' > ');
}

/** The text an anchor is matched by: collapsed and cut, so a long section does not travel whole in every anchor. */
export function elementText(el: Element): string {
  const TEXT_LIMIT = 80;
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, TEXT_LIMIT);
}

/** The element's rect in document coordinates, which a scroll does not change. */
export function documentRect(el: Element): Rect {
  const box = el.getBoundingClientRect();
  return { x: box.left + window.scrollX, y: box.top + window.scrollY, width: box.width, height: box.height };
}

export function elementAnchor(el: Element): ElementAnchor {
  return { kind: 'element', selector: cssPath(el), text: elementText(el), rect: documentRect(el) };
}

/** Intersection over union: 1 for the same rect, 0 for rects that do not touch. */
export function rectOverlap(a: Rect, b: Rect): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (width <= 0 || height <= 0) return 0;
  const shared = width * height;
  return shared / (a.width * a.height + b.width * b.height - shared);
}

/** The selector step. After a move, nth-of-type silently lands on another element: the text check keeps the pin off it. */
export function anchorBySelector(doc: Document, anchor: ElementAnchor): Element | null {
  let found: Element | null;
  try {
    found = doc.querySelector(anchor.selector);
  } catch {
    return null; // a malformed selector throws
  }
  if (!found || found.hasAttribute('data-hive')) return null;
  return anchor.text === '' || elementText(found) === anchor.text ? found : null;
}

/** The text step: among the elements with the stored text, the deepest (an ancestor with that one child has the same text), and on a
 *  tie the one closest to the stored rect. */
export function anchorByText(doc: Document, anchor: ElementAnchor): Element | null {
  if (anchor.text === '') return null;
  const depth = (el: Element): number => {
    let count = 0;
    for (let parent = el.parentElement; parent; parent = parent.parentElement) count += 1;
    return count;
  };
  const distance = (el: Element): number => {
    const rect = documentRect(el);
    return Math.hypot(rect.x - anchor.rect.x, rect.y - anchor.rect.y);
  };
  const matches = Array.from(doc.body.querySelectorAll('*'))
    .filter((el) => !el.hasAttribute('data-hive') && elementText(el) === anchor.text);
  return matches.reduce<Element | null>((best, el) => {
    if (!best) return el;
    const deeper = depth(el) - depth(best);
    return deeper > 0 || (deeper === 0 && distance(el) < distance(best)) ? el : best;
  }, null);
}

/** The position step: among the elements with the tag of the selector's last step, the one overlapping the stored rect most, when it
 *  overlaps at least MIN_OVERLAP. No elementFromPoint: it hits the bridge's own overlay, and jsdom lacks it.
 *  ponytail: a heuristic for a pin whose selector and text both missed; a layout that moved the element by more than half its size
 *  loses the pin. */
export function anchorByPosition(doc: Document, anchor: ElementAnchor): Element | null {
  const MIN_OVERLAP = 0.5;
  const tag = (anchor.selector.split(' > ').pop() ?? '').split(':')[0];
  if (!/^[a-z][a-z0-9-]*$/.test(tag)) return null; // an #id step names no tag
  let best: Element | null = null;
  let bestOverlap = MIN_OVERLAP;
  for (const candidate of Array.from(doc.getElementsByTagName(tag))) {
    const overlap = candidate.hasAttribute('data-hive') ? 0 : rectOverlap(documentRect(candidate), anchor.rect);
    if (overlap >= bestOverlap) {
      best = candidate;
      bestOverlap = overlap;
    }
  }
  return best;
}

/** The element of an element anchor by selector, then text, then position; null when none finds it, and the anchor counts as removed. */
export function findAnchor(doc: Document, anchor: ElementAnchor): Element | null {
  return anchorBySelector(doc, anchor) ?? anchorByText(doc, anchor) ?? anchorByPosition(doc, anchor);
}

/** Each anchor's pin in frame-viewport coordinates; the parent adds the frame's offset and zoom. */
export function pinRects(doc: Document, anchors: readonly AnchorEntry[]): Pin[] {
  return anchors.map(({ id, anchor }) => {
    if (anchor.kind === 'area') {
      return { id, rect: { ...anchor.rect, x: anchor.rect.x - window.scrollX, y: anchor.rect.y - window.scrollY } };
    }
    const found = findAnchor(doc, anchor);
    if (!found) return { id, rect: null };
    const box = found.getBoundingClientRect();
    return { id, rect: { x: box.left, y: box.top, width: box.width, height: box.height } };
  });
}

/** A field the user types in. closest instead of isContentEditable: jsdom lacks isContentEditable, and closest also covers a child of
 *  the editable host. */
export function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
    || target.closest('[contenteditable]:not([contenteditable="false"])') !== null;
}

/** The anchors message's shape, checked at the frame's boundary. */
export function isAnchorList(value: unknown): value is AnchorEntry[] {
  const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
  const isRect = (v: unknown): boolean => isRecord(v) && ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(v[key]));
  const isAnchor = (v: unknown): boolean => isRecord(v) && isRect(v.rect)
    && (v.kind === 'area' || (v.kind === 'element' && typeof v.selector === 'string' && typeof v.text === 'string'));
  return Array.isArray(value) && value.every((entry: unknown) => isRecord(entry) && typeof entry.id === 'string' && isAnchor(entry.anchor));
}

/** Every function above, for bridgeScript to join: one left out is unbound in the frame. */
export const anchorFunctions = [
  cssPath, elementText, documentRect, elementAnchor, rectOverlap, anchorBySelector, anchorByText, anchorByPosition, findAnchor,
  pinRects, isEditable, isAnchorList,
];
