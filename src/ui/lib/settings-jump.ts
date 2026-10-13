// Landing on a Settings search pick (#689): the setting's block 96px under the content's top, smoothly; its control focused without a
// second scroll; the block outlined, the class taken off when its 2s animation (index.css) ends.
export const HIGHLIGHT_CLASS = 'setting-highlight';
const OFFSET_PX = 96;
const HIGHLIGHT_MS = 2000;
// A field's own control before any button in its block, so a card lands on its first input rather than its header's add or remove
const FIELD_CONTROL = 'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled]):not([aria-hidden="true"]), [role="switch"]:not([disabled])';
const BUTTON = 'button:not([disabled])';
// One timer per block: a second pick within 2s restarts the outline, so the first pick's timer must not take it off early
const timers = new WeakMap<Element, number>();

export function landOn(anchor: string, scroller: HTMLElement | null): void {
  const block = document.getElementById(anchor);
  if (block === null || scroller === null) return;
  const top = block.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - OFFSET_PX;
  scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  (block.querySelector<HTMLElement>(FIELD_CONTROL) ?? block.querySelector<HTMLElement>(BUTTON))?.focus({ preventScroll: true });
  block.classList.remove(HIGHLIGHT_CLASS);
  void block.offsetWidth; // a reflow restarts the animation when the same setting is picked again within its 2s
  block.classList.add(HIGHLIGHT_CLASS);
  window.clearTimeout(timers.get(block));
  timers.set(block, window.setTimeout(() => block.classList.remove(HIGHLIGHT_CLASS), HIGHLIGHT_MS));
}
