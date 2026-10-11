import { render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { ProjectGroupRow } from '@/components/ProjectGroupMenu';
import { row } from './project-harness';

test('a group header is a sticky 36px row on card under the table header: the chevron, the name, the count in a pill and its stage (#60)', () => {
  const group = { key: 'Ready', label: 'Ready', items: [row(1), row(2)], stage: '→ dev' };
  render(<table><tbody><ProjectGroupRow group={group} isCollapsed={false} onToggle={vi.fn()} /></tbody></table>);
  expect(screen.getByRole('row')).toHaveClass('sticky', 'top-[34px]', 'z-[5]', 'h-9', 'border-y', 'bg-card');
  expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByText('Ready')).toHaveClass('font-semibold', 'text-[13px]');
  expect(screen.getByText('2')).toHaveClass('rounded-[9px]', 'bg-muted', 'px-1.5', 'tabular-nums');
  expect(screen.getByText('→ dev')).toBeInTheDocument();
});
