import { Fragment, type ReactNode, useRef } from 'react';
import { Divider } from '@/components/Divider';
import { MIN_SIZE, type TreeNode, type TreeSplit } from '@/lib/split-tree';

const STEP = 5; // percent per arrow key on a divider

interface SplitBoxProps<L> {
  split: TreeSplit<L>; path: number[]; label: string;
  onResize(path: readonly number[], sizes: number[]): void;
  keyOf(node: TreeNode<L>): string; // a child's React key, stable while the tree around it changes
  render(node: TreeNode<L>, path: number[]): ReactNode;
}

/** A split of either tree, the center's groups (#458) or a split tab's panes (#641): its children in a flex row or column sized by their
 * share, a Divider between each pair. A divider moves only the edge between its two neighbours; the tree clamps each to MIN_SIZE.
 * A double click on one evens those two neighbours (#819), since a single click starts every drag. */
export function SplitBox<L>({ split, path, label, onResize, keyOf, render }: SplitBoxProps<L>) {
  const box = useRef<HTMLDivElement>(null);
  const isRow = split.axis === 'row';
  const starts = split.sizes.map((_, i) => split.sizes.slice(0, i).reduce((sum, size) => sum + size, 0));
  const moveEdge = (i: number, at: number): void => {
    const first = at - starts[i];
    const pair = split.sizes[i] + split.sizes[i + 1];
    onResize(path, split.sizes.map((size, j) => {
      if (j === i) return first;
      return j === i + 1 ? pair - first : size;
    }));
  };
  const toValue = (rect: DOMRect, clientX: number, clientY: number): number =>
    (isRow ? (clientX - rect.left) / rect.width : (clientY - rect.top) / rect.height) * 100;
  const keys: Record<string, number> = isRow ? { ArrowRight: STEP, ArrowLeft: -STEP } : { ArrowDown: STEP, ArrowUp: -STEP };
  return (
    <div ref={box} className={`flex min-h-0 min-w-0 flex-1 ${isRow ? 'flex-row' : 'flex-col'}`}>
      {split.children.map((child, i) => (
        <Fragment key={keyOf(child)}>
          {i > 0 && (
            <Divider
              axis={isRow ? 'vertical' : 'horizontal'} value={starts[i]} min={starts[i - 1] + MIN_SIZE} max={starts[i] + split.sizes[i] - MIN_SIZE}
              keys={keys} label={label} measure={box} toValue={toValue} onChange={(at) => moveEdge(i - 1, at)}
              onDoubleClick={() => moveEdge(i - 1, starts[i - 1] + (split.sizes[i - 1] + split.sizes[i]) / 2)}
            />
          )}
          <div style={{ flex: `${split.sizes[i]} 1 0%` }} className="flex min-h-0 min-w-0">{render(child, [...path, i])}</div>
        </Fragment>
      ))}
    </div>
  );
}
