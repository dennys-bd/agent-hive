// Landing on a Settings search pick (#689): the setting's block 96px under the content's top, smoothly; its control focused without a
// second scroll; the block outlined, the class taken off when its 2s animation (index.css) ends.
export const HIGHLIGHT_CLASS = 'setting-highlight';
const OFFSET_PX = 96;
const HIGHLIGHT_MS = 2000;
const CONTROL = 'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled]):not([aria-hidden="true"]), button:not([disabled])';

export function landOn(anchor: string, scroller: HTMLElement | null): void {
  const block = document.getElementById(anchor);
  if (block === null || scroller === null) return;
  const top = block.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - OFFSET_PX;
  scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  block.querySelector<HTMLElement>(CONTROL)?.focus({ preventScroll: true }); // the first enabled control, a switch before its label included
  block.classList.remove(HIGHLIGHT_CLASS);
  void block.offsetWidth; // a reflow restarts the animation when the same setting is picked again within its 2s
  block.classList.add(HIGHLIGHT_CLASS);
  // ponytail: a second pick within 2s keeps the first pick's timer, which takes the class off early; one timer per block if that shows
  window.setTimeout(() => block.classList.remove(HIGHLIGHT_CLASS), HIGHLIGHT_MS);
}
