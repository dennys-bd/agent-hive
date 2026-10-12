import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { TreeGroupHeader } from '@/components/TreeGroupHeader';
import { titleIfCut } from '@/lib/cut-title';
import type { Task } from '../../src/types';

afterEach(cleanup);

// jsdom lays nothing out: the sizes a cut (or fitting) text would have
const size = (el: HTMLElement, sizes: { scrollWidth?: number; clientWidth?: number; scrollHeight?: number; clientHeight?: number }): HTMLElement => {
  for (const [key, value] of Object.entries(sizes)) Object.defineProperty(el, key, { configurable: true, value });
  return el;
};

test('titleIfCut sets the full text as the title only while the text is cut, by width (truncate) or by height (line-clamp) (#91)', () => {
  // biome-ignore lint/a11y/noStaticElementInteractions: the element under test, as the components use it
  render(<span onMouseEnter={titleIfCut('the full title')}>the full title</span>);
  const span = screen.getByText('the full title');
  fireEvent.mouseEnter(size(span, { scrollWidth: 200, clientWidth: 100 }));
  expect(span).toHaveAttribute('title', 'the full title');
  fireEvent.mouseEnter(size(span, { scrollWidth: 100, clientWidth: 100 }));
  expect(span).not.toHaveAttribute('title');
  fireEvent.mouseEnter(size(span, { scrollHeight: 48, clientHeight: 32 }));
  expect(span).toHaveAttribute('title', 'the full title');
});

test('a cut tree name shows in full on hover; one that fits shows nothing (#91)', () => {
  const root = { item: { itemId: 'I1', id: '1', title: 'A long tree name', body: '', url: '' }, stage: 'dev', auto: false } as Task;
  render(<ul><TreeGroupHeader root={root} count={2} isCollapsed={false} onToggle={() => {}} /></ul>);
  const name = screen.getByText('⑂ #1 A long tree name');
  fireEvent.mouseEnter(size(name, { scrollWidth: 50, clientWidth: 50 }));
  expect(name).not.toHaveAttribute('title');
  fireEvent.mouseEnter(size(name, { scrollWidth: 300, clientWidth: 50 }));
  expect(name).toHaveAttribute('title', '⑂ #1 A long tree name');
});
