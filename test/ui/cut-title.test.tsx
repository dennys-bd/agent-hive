import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { TreeGroupHeader } from '@/components/TreeGroupHeader';
import { CutTitle } from '@/lib/cut-title';
import type { Task } from '../../src/types';

afterEach(cleanup);

// jsdom lays nothing out: the sizes a cut (or fitting) text would have
const size = (el: HTMLElement, sizes: { scrollWidth?: number; clientWidth?: number; scrollHeight?: number; clientHeight?: number }): HTMLElement => {
  for (const [key, value] of Object.entries(sizes)) Object.defineProperty(el, key, { configurable: true, value });
  return el;
};

function Title() {
  const ref = useRef<HTMLButtonElement>(null);
  return <CutTitle text="the full title" cutRef={ref}><button type="button" ref={ref}>the full title</button></CutTitle>;
}

// Radix draws the content twice (visible, and a visually hidden role="tooltip" copy): read the role, not the text.
test('CutTitle opens its tooltip only while the text is cut, by width (truncate) or by height (line-clamp) (#91, #284)', async () => {
  render(<Title />);
  const el = screen.getByRole('button');
  fireEvent.focus(size(el, { scrollWidth: 100, clientWidth: 100, scrollHeight: 16, clientHeight: 16 }));
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  fireEvent.blur(el);
  fireEvent.focus(size(el, { scrollWidth: 200, clientWidth: 100 }));
  expect(await screen.findByRole('tooltip')).toHaveTextContent('the full title');
  fireEvent.blur(el);
  fireEvent.focus(size(el, { scrollWidth: 100, clientWidth: 100, scrollHeight: 48, clientHeight: 32 }));
  expect(await screen.findByRole('tooltip')).toHaveTextContent('the full title');
});

const root = { item: { itemId: 'I1', id: '1', title: 'A long tree name', body: '', url: '' }, stage: 'dev', auto: false } as Task;

test('a tree header\'s whole row is the tooltip\'s target: a cut name shows in full (#284)', async () => {
  render(<ul><TreeGroupHeader root={root} count={2} isCollapsed={false} onToggle={() => {}} /></ul>);
  size(screen.getByText('⑂ #1 A long tree name'), { scrollWidth: 300, clientWidth: 50 });
  fireEvent.focus(screen.getByRole('button'));
  expect(await screen.findByRole('tooltip')).toHaveTextContent('⑂ #1 A long tree name');
});

test('a click anywhere on a tree header\'s row toggles the group (#284)', () => {
  const onToggle = vi.fn();
  render(<ul><TreeGroupHeader root={root} count={2} isCollapsed={false} onToggle={onToggle} /></ul>);
  fireEvent.click(screen.getByText('2'));
  fireEvent.click(screen.getByText('⑂ #1 A long tree name'));
  expect(onToggle).toHaveBeenCalledTimes(2);
});
