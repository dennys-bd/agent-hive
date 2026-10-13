import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test } from 'vitest';
import { MetaGrid } from '@/components/DetailSections';
import { setLanguage } from '@/i18n';
import type { ActivityRecord, Task } from '../../src/types';

const MINUTE = 60_000;
const task: Task = { item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true };
// before the breakdown, a stage and agent, a free session, a commands stage: 95 working minutes, 1700 tokens
const record: ActivityRecord = {
  id: 'a-I1', taskIds: ['I1'], sessions: [],
  usage: {
    tokens: 1700, ms: 105 * MINUTE, waitingMs: 10 * MINUTE,
    parts: [
      { tokens: 0, ms: 30 * MINUTE, waitingMs: 0 },
      { stage: 'spec', agent: 'claude', tokens: 1200, ms: 50 * MINUTE, waitingMs: 10 * MINUTE },
      { agent: 'claude', tokens: 500, ms: 20 * MINUTE, waitingMs: 0 },
      { stage: 'checks', tokens: 0, ms: 5 * MINUTE, waitingMs: 0 },
    ],
  },
};
const state = { workers: [], activities: [], activityRecords: [record], tasks: [] };
const lines = (): (string | null)[] => screen.queryAllByRole('listitem').map((li) => li.textContent);
beforeEach(() => setLanguage('pt'));

test('the total is a button, collapsed by default: one line, no parts (#617)', () => {
  render(<MetaGrid task={task} state={state} isActivity />);
  const total = screen.getByRole('button', { name: '1h35m · 1.7k tokens' });
  expect(total).toHaveAttribute('aria-expanded', 'false');
  expect(total).toHaveAttribute('title', 'mostrar por etapa e agente');
  expect(lines()).toEqual([]);
});

test('the button expands the parts in the order the task first ran them, each with its working time and tokens; a part with no agent shows its stage alone; a second click collapses them (#617)', async () => {
  const user = userEvent.setup();
  render(<MetaGrid task={task} state={state} isActivity />);
  const total = screen.getByRole('button', { name: '1h35m · 1.7k tokens' });
  await user.click(total);
  expect(total).toHaveAttribute('aria-expanded', 'true');
  expect(total).toHaveAttribute('title', 'ocultar por etapa e agente');
  expect(lines()).toEqual([
    'antes da quebra · 30m · 0 tokens', 'spec · claude · 40m · 1.2k tokens', 'sessão livre · claude · 20m · 500 tokens', 'checks · 5m · 0 tokens',
  ]);
  await user.click(total);
  expect(lines()).toEqual([]);
});

test('the free session\'s and the old usage\'s labels in English (#617)', async () => {
  setLanguage('en');
  const user = userEvent.setup();
  render(<MetaGrid task={task} state={state} isActivity />);
  await user.click(screen.getByRole('button', { name: '1h35m · 1.7k tokens' }));
  expect(lines()).toEqual([
    'before the breakdown · 30m · 0 tokens', 'spec · claude · 40m · 1.2k tokens', 'free session · claude · 20m · 500 tokens', 'checks · 5m · 0 tokens',
  ]);
});
