import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import type { UpdateConflict } from '../../src/types';
import { ConflictBlock } from '@/components/plugins/UpdateConflict';
import { setLanguage } from '@/i18n';

const CONFLICT: UpdateConflict = {
  kind: 'conflict', id: 'SKILL.md#0', file: 'SKILL.md', heading: '## Index',
  base: ['## Index', '| # | slice |'],
  mine: ['## Index', '| # | slice | owner |', 'Owner builds it.'],
  hive: ['## Index', '| # | slice | tests |'],
};
const HIVE = 'new from the hive · 0.15';
const column = (name: string): HTMLElement => screen.getByRole('region', { name });
const lines = (name: string): Element[] => [...column(name).querySelectorAll('[data-mark]')];

beforeEach(() => setLanguage('en'));

test("each column shows its side against base: shared lines plain, − on red ground, + on green ground; the hive's names the version it brings (#325)", () => {
  render(<ConflictBlock conflict={CONFLICT} to="0.15" onChoose={vi.fn()} />);
  expect(screen.getByRole('article', { name: '## Index' })).toHaveTextContent('## IndexSKILL.md');
  expect(lines('your version').map((line) => line.textContent)).toEqual([' ## Index', '−| # | slice |', '+| # | slice | owner |', '+Owner builds it.']);
  const [shared, removed, added] = lines(HIVE);
  expect([shared?.className, removed?.className, added?.className]).toEqual(['', 'bg-diff-del', 'bg-diff-add']);
  expect(removed?.firstElementChild).toHaveClass('text-destructive');
  expect(added?.firstElementChild).toHaveClass('text-working');
});

test('a choice presses its button and dims the other column; with none neither is dimmed, and the choice can change (#325)', async () => {
  const user = userEvent.setup();
  const onChoose = vi.fn();
  const { rerender } = render(<ConflictBlock conflict={CONFLICT} to="0.15" onChoose={onChoose} />);
  expect([column('your version'), column(HIVE)].map((c) => c.classList.contains('opacity-45'))).toEqual([false, false]);
  await user.click(screen.getByRole('button', { name: 'keep mine' }));
  expect(onChoose).toHaveBeenLastCalledWith('mine');
  rerender(<ConflictBlock conflict={CONFLICT} to="0.15" choice="mine" onChoose={onChoose} />);
  expect(screen.getByRole('button', { name: 'keep mine' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: 'use the hive one' })).toHaveAttribute('aria-pressed', 'false');
  expect(column(HIVE)).toHaveClass('opacity-45');
  expect(column('your version')).not.toHaveClass('opacity-45');
  await user.click(screen.getByRole('button', { name: 'use the hive one' }));
  expect(onChoose).toHaveBeenLastCalledWith('hive');
});

test('a side whose file was deleted shows file deleted in place of its lines; with no hive version the column is named without one (#325)', () => {
  render(<ConflictBlock conflict={{ ...CONFLICT, hive: null }} onChoose={vi.fn()} />);
  expect(column('new from the hive')).toHaveTextContent('file deleted');
  expect(lines('new from the hive')).toEqual([]);
  expect(column('your version')).not.toHaveTextContent('file deleted');
});
