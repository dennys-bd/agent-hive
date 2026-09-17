import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { App } from '@/App';
import { setLanguage } from '@/i18n';
import type { Card, SetupInfo, Slot, State } from '../../src/types';

// App owns selectedSlotId; mocking its network hooks lets the test drive `state` directly without a real
// EventSource/fetch, and isolates the regression (App must clear a stale selection) from the network plumbing.
let currentState: State | undefined;

vi.mock('@/hooks/use-hive-state', () => ({
  useHiveState: () => ({ state: currentState, connected: true, tick: 0 }),
}));
vi.mock('@/hooks/use-setup-info', () => ({
  useSetupInfo: () => ({
    info: { configured: true, repo: '/repo', language: 'pt' } as SetupInfo,
    error: undefined,
    reload: vi.fn(),
  }),
}));
vi.mock('@/hooks/use-output', () => ({ useOutput: () => [] }));

beforeEach(() => { setLanguage('pt'); currentState = undefined; });

const card = (id: string, slotId: string): Card => ({
  task: { itemId: `I${id}`, id, title: `Task ${id}`, body: '', url: `https://github.com/acme/r/issues/${id}` },
  column: 'dev', boardColumn: 'Ready', slug: `hive-${id}-task-${id}`, slotId,
});
const slot = (cardId?: string): Slot => ({ id: 's1', status: cardId ? 'working' : 'empty', cardId });
const state = (cards: Card[], s: Slot): State => ({ signal: 'green', maxConcurrent: 1, slots: [s], columns: [], cards, usage: [], budget: {}, usageRules: [] });

test('closes the detail sheet when the selected slot empties, and does not reopen it for a new occupant of the same slot', async () => {
  const user = userEvent.setup();
  currentState = state([card('1', 'I1')], slot('I1'));
  const { rerender } = render(<App />);

  await user.click(screen.getByText('#1 Task 1'));
  expect(screen.getByRole('dialog')).toBeInTheDocument();

  currentState = state([], slot());
  rerender(<App />);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

  currentState = state([card('2', 'I2')], slot('I2'));
  rerender(<App />);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
