import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { TasksEntries } from '@/components/tasks/TasksEntries';
import { FIRST_CENTER } from '@/hooks/use-tasks-center';
import { setLanguage } from '@/i18n';
import { SIDEBAR_STATE } from './sidebar-fixtures.js';

beforeEach(() => setLanguage('pt'));
const row = (name: RegExp): HTMLElement => screen.getByRole('button', { name });
const pressed = (): string[] => screen.getAllByRole('button').filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent ?? '');

test('the tasks rows: todas em lista, one per flow in the state\'s order, sem fluxo, each with ● N in yellow when some wait for you, then its total (#572)', () => {
  render(<TasksEntries state={SIDEBAR_STATE} center={FIRST_CENTER} show={vi.fn()} />);
  expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['todas em lista● 35', 'build● 11', 'ship● 12', 'sem fluxo● 12']);
  expect(within(row(/^build/)).getByText('● 1')).toHaveClass('text-signal-yellow');
});

test('● N is hidden when none of the row\'s tasks waits for you (#572)', () => {
  render(<TasksEntries state={{ ...SIDEBAR_STATE, workers: [], activities: [] }} center={FIRST_CENTER} show={vi.fn()} />);
  expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['todas em lista5', 'build1', 'ship2', 'sem fluxo2']);
});

test('the row of the shown center is selected (the first flow\'s for a flow center with no flow), none under a source; a click shows its center (#572)', async () => {
  const user = userEvent.setup();
  const show = vi.fn();
  const { rerender } = render(<TasksEntries state={SIDEBAR_STATE} center={FIRST_CENTER} show={show} />);
  expect(pressed()).toEqual(['build● 11']);
  rerender(<TasksEntries state={SIDEBAR_STATE} center={{ kind: 'tasks', view: 'flow', flow: 'ship' }} show={show} />);
  expect(pressed()).toEqual(['ship● 12']);
  rerender(<TasksEntries state={SIDEBAR_STATE} center={{ kind: 'tasks', view: 'outside' }} show={show} />);
  expect(pressed()).toEqual(['sem fluxo● 12']);
  rerender(<TasksEntries state={SIDEBAR_STATE} center={{ kind: 'source', source: 'roadmap' }} show={show} />);
  expect(pressed()).toEqual([]);
  await user.click(row(/^todas em lista/));
  await user.click(row(/^ship/));
  await user.click(row(/^sem fluxo/));
  expect(show.mock.calls).toEqual([[{ kind: 'tasks', view: 'list' }], [{ kind: 'tasks', view: 'flow', flow: 'ship' }], [{ kind: 'tasks', view: 'outside' }]]);
});
