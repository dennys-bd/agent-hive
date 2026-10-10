import { afterEach, expect, test, vi } from 'vitest';
import { caretRect } from '@/lib/caret';

afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });

interface Seen { before: string; marker: string; fontSize: string; left: string; top: string; whiteSpace: string }

// jsdom lays nothing out: the field and the marker report fixed boxes, and the marker records what the mirror held when it was measured
function stubLayout(): { seen: Seen[] } {
  const seen: Seen[] = [];
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.tagName === 'TEXTAREA') return DOMRect.fromRect({ x: 100, y: 200, width: 300, height: 60 });
    const mirror = this.parentElement as HTMLElement;
    seen.push({ before: mirror.firstChild?.textContent ?? '', marker: this.textContent ?? '', fontSize: mirror.style.fontSize, left: mirror.style.left, top: mirror.style.top, whiteSpace: mirror.style.whiteSpace });
    return DOMRect.fromRect({ x: 140, y: 220, width: 8, height: 20 });
  });
  return { seen };
}

const field = (value: string): HTMLTextAreaElement => {
  const area = document.createElement('textarea');
  area.value = value;
  area.style.fontSize = '13px';
  document.body.append(area);
  return area;
};

test('caretRect measures the character at an index through a mirror laid over the field, then removes the mirror (#591)', () => {
  const { seen } = stubLayout();
  const area = field('see @cl');
  expect(caretRect(area, 4)).toEqual({ left: 140, top: 220, height: 20 });
  expect(seen).toEqual([{ before: 'see ', marker: '@', fontSize: '13px', left: '100px', top: '200px', whiteSpace: 'pre-wrap' }]);
  expect(document.body.children).toHaveLength(1); // only the field: the mirror is gone
});

test('caretRect follows the field\'s scroll, so a scrolled line reads where it shows (#591)', () => {
  stubLayout();
  const area = field('a\nb\nc\n@');
  Object.defineProperty(area, 'scrollTop', { value: 15 });
  Object.defineProperty(area, 'scrollLeft', { value: 4 });
  expect(caretRect(area, 6)).toEqual({ left: 136, top: 205, height: 20 });
});

test('caretRect at the end of the text still measures a line (#591)', () => {
  const { seen } = stubLayout();
  caretRect(field('ab'), 2);
  expect(seen[0].marker).not.toBe('');
});
