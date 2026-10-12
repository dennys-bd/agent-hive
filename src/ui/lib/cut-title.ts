import type { MouseEvent } from 'react';

/** A cut text's full version on hover (#91): the native title, set only while the element is cut, by width (truncate) or by height
 * (line-clamp). Measured on each hover, so a resize needs no observer; React never owns this title, so writing the DOM is safe. */
export function titleIfCut(text: string): (e: MouseEvent<HTMLElement>) => void {
  return (e) => {
    const el = e.currentTarget;
    const isCut = el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight;
    if (isCut) el.title = text;
    else el.removeAttribute('title');
  };
}
