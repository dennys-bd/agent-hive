import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { SplitBox } from '@/components/SplitBox';
import type { TreeSplit } from '@/lib/split-tree';

type Leaf = { kind: 'leaf'; id: string };
const leaf = (id: string): Leaf => ({ kind: 'leaf', id });

function renderSplit(sizes: number[]) {
  const split: TreeSplit<Leaf> = { kind: 'split', axis: 'row', sizes, children: sizes.map((_, i) => leaf(`L${i}`)) };
  const onResize = vi.fn();
  render(<SplitBox split={split} path={[]} label="resize" onResize={onResize} keyOf={(node) => (node as Leaf).id} render={(node) => <span>{(node as Leaf).id}</span>} />);
  return onResize;
}

test('a double click on a divider gives its two panes the same size (#819)', () => {
  const onResize = renderSplit([70, 30]);
  fireEvent.doubleClick(screen.getByRole('separator'));
  expect(onResize).toHaveBeenCalledWith([], [50, 50]);
});

test('with more panes, a double click evens only the divider\'s two neighbours (#819)', () => {
  const onResize = renderSplit([20, 60, 20]);
  fireEvent.doubleClick(screen.getAllByRole('separator')[1]);
  expect(onResize).toHaveBeenCalledWith([], [20, 40, 40]);
});
