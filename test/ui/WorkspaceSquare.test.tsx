import { render } from '@testing-library/react';
import { expect, test } from 'vitest';
import { WorkspaceSquare } from '@/components/WorkspaceSquare';
import { WorkspaceColorsContext } from '@/lib/workspace-color';

// The squares are aria-hidden: no role to query, so the container's spans in render order
const squares = (container: HTMLElement): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('span')];

test('WorkspaceSquare paints the context\'s colour for its name, an explicit color over it, and bg-muted for a name with none (#78)', () => {
  const { container } = render(
    <WorkspaceColorsContext.Provider value={{ hive: '#a1b2c3' }}>
      <WorkspaceSquare name="hive" />
      <WorkspaceSquare name="hive" color="#102030" />
      <WorkspaceSquare name="gone" />
      <WorkspaceSquare />
      <WorkspaceSquare name="constructor" />
    </WorkspaceColorsContext.Provider>,
  );
  const [named, explicit, gone, none, inherited] = squares(container);
  expect(named).toHaveStyle({ backgroundColor: '#a1b2c3' });
  expect(named).toHaveAttribute('aria-hidden', 'true');
  expect(named).toHaveClass('shrink-0', 'size-2', 'rounded-[2px]');
  expect(named).not.toHaveClass('bg-muted');
  expect(explicit).toHaveStyle({ backgroundColor: '#102030' });
  for (const square of [gone, none, inherited]) {
    expect(square).toHaveClass('bg-muted'); // a task may name a workspace that is gone; an Object.prototype key is no colour
    expect(square.style.backgroundColor).toBe('');
  }
});

test('a caller\'s className replaces the default size and corner, and its title reaches the square (#78)', () => {
  const { container } = render(<WorkspaceSquare name="hive" color="#a1b2c3" title="hive" className="size-2.5 rounded-sm" />);
  const [square] = squares(container);
  expect(square).toHaveClass('size-2.5', 'rounded-sm');
  expect(square).not.toHaveClass('size-2', 'rounded-[2px]');
  expect(square).toHaveAttribute('title', 'hive');
});
