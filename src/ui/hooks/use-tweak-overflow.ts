import { type RefObject, useLayoutEffect, useState } from 'react';

// The tweaks row's overflow (#342): every control stays in the row's layout and only the ones past its end are hidden, so hiding them never
// moves the others and the measure cannot flicker. The trigger's room is kept only once something no longer fits.

const TRIGGER_FALLBACK = 56; // more…'s width before it is first drawn: the measure runs before it exists

/** How many controls, from the first, stay in the row: all when they fit in available, else those that fit beside a trigger of reserve. */
export function fitCount(widths: readonly number[], gap: number, available: number, reserve: number): number {
  const total = widths.reduce((sum, width) => sum + width, 0) + gap * Math.max(widths.length - 1, 0);
  if (total <= available) return widths.length;
  const limit = available - reserve - gap;
  let right = 0;
  for (const [index, width] of widths.entries()) {
    right += (index === 0 ? 0 : gap) + width;
    if (right > limit) return index;
  }
  return widths.length;
}

const px = (value: string): number => Number.parseFloat(value) || 0;

function measure(row: HTMLElement): number {
  const items = Array.from(row.querySelectorAll<HTMLElement>(':scope > [data-tweak-item]'));
  const style = getComputedStyle(row);
  const available = row.clientWidth - px(style.paddingLeft) - px(style.paddingRight);
  const trigger = row.querySelector<HTMLElement>(':scope > [data-tweak-more]');
  return fitCount(items.map((item) => item.offsetWidth), px(style.columnGap), available, trigger?.offsetWidth || TRIGGER_FALLBACK);
}

/** The number of the row's [data-tweak-item] children that fit, kept current as the row or any control resizes. names: the controls' names,
 * so a new block measures and observes its own controls. */
export function useTweakOverflow(row: RefObject<HTMLElement | null>, names: readonly string[]): number {
  const [fits, setFits] = useState(names.length);
  const controls = names.join('\n');
  // biome-ignore lint/correctness/useExhaustiveDependencies: controls is the trigger of a new measure, not a value it uses
  useLayoutEffect(() => {
    const element = row.current;
    if (element === null) return undefined;
    const update = (): void => setFits(measure(element));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    for (const item of element.querySelectorAll(':scope > [data-tweak-item]')) observer.observe(item);
    return () => observer.disconnect();
  }, [row, controls]);
  return fits;
}
