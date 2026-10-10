// Where a character of a textarea sits on screen (#591). A textarea gives no coordinates for its text, so a hidden div copying its box and
// font lays out the same text over it, and a span holding the character reports where it falls.

// What decides where a textarea's text wraps and how tall its lines are
const MIRRORED = [
  'box-sizing', 'width', 'height', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'border-style',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'font-family', 'font-size', 'font-style', 'font-variant', 'font-weight',
  'font-stretch', 'line-height', 'letter-spacing', 'word-spacing', 'text-transform', 'text-indent', 'text-align', 'tab-size',
] as const;
// An empty span has no line box to measure; a zero-width space gives it one without moving anything
const EMPTY_MARK = '​';

export interface CaretRect { left: number; top: number; height: number }

function mirrorOf(field: HTMLTextAreaElement): HTMLDivElement {
  const mirror = field.ownerDocument.createElement('div');
  const style = field.ownerDocument.defaultView?.getComputedStyle(field);
  for (const prop of MIRRORED) mirror.style.setProperty(prop, style?.getPropertyValue(prop) ?? '');
  const box = field.getBoundingClientRect();
  // Laid exactly over the field, so the marker's viewport box is the character's once the field's scroll is taken off
  Object.assign(mirror.style, {
    position: 'fixed', left: `${box.left}px`, top: `${box.top}px`, visibility: 'hidden', pointerEvents: 'none',
    whiteSpace: 'pre-wrap', overflowWrap: 'break-word', overflow: 'hidden',
  });
  return mirror;
}

/** The viewport box of the character at `index` in a textarea: its left, its top and its line's height. */
export function caretRect(field: HTMLTextAreaElement, index: number): CaretRect {
  const mirror = mirrorOf(field);
  mirror.textContent = field.value.slice(0, index);
  const marker = field.ownerDocument.createElement('span');
  marker.textContent = field.value.charAt(index) || EMPTY_MARK;
  mirror.append(marker);
  field.ownerDocument.body.append(mirror);
  try {
    const box = marker.getBoundingClientRect();
    return { left: box.left - field.scrollLeft, top: box.top - field.scrollTop, height: box.height };
  } finally {
    mirror.remove();
  }
}
