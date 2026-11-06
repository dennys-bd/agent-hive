import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, expect, test } from 'vitest';
import { Flow } from '@/components/Flow';
import { setLanguage } from '@/i18n';
import type { Stage, State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { withPointedWork, type WithWork } from '../fixtures/work';
import { flowed } from '../fixtures/main-flow.js';
import { firstFlow } from './flow-of.js';

// The footer fits the card at any width (#719): the badge and the button never shrink, the status and its extras clip between them.
const stages: Stage[] = [{ name: 'dev', from: { board: ['Ready'] }, prompt: '/hive-build {url}' }, { name: 'review', from: { board: ['In review'] } }];
const back = { from: 'review', to: 'dev', when: 'verdict' as const, verdict: 'failed', maxTries: 2 };
const key = '["review","verdict","failed"]';
const failed: WithWork = {
  item: { itemId: 'I1', id: '1', title: 'Task 1', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true,
  via: key, tries: { [key]: 1 }, stopped: true, error: 'no transition: verdict:failed',
};
const STATE: State = withPointedWork({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [], terminals: [], ...flowed(stages, []), tasks: [failed], sourceOrder: [], localCount: 0, benchmark: { experiments: [] }, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [],
  workspaces: ['hive'], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
  transitions: [back],
});
const tile = (): HTMLElement => screen.getByText('#1 Task 1').closest('li')!;
const groupOf = (): HTMLElement => within(tile()).getByText('falhou · 1/2').parentElement!;
beforeEach(() => setLanguage('pt'));

test('the status, the dismiss button and the tries clip in their own group; the auto badge and the action button stay outside it (#719)', () => {
  render(<Flow state={STATE} flow={firstFlow(STATE)} />);
  const group = groupOf();
  expect(group).toHaveClass('min-w-0', 'flex-1', 'overflow-hidden');
  expect(within(group).getByRole('button', { name: 'dispensar erro' })).toBeInTheDocument();
  const footer = group.parentElement!;
  const outside = within(footer).getAllByRole('button').filter((b) => !group.contains(b));
  expect(outside).toHaveLength(1);
  expect(outside[0].closest('.shrink-0')).not.toBeNull();
  expect(group).not.toContainElement(within(footer).getByText('auto'));
  cleanup();
});

// Radix draws the content twice (visible, and a visually hidden role="tooltip" copy): read the role, not the text.
test('a clipped footer shows its status and tries in full in a tooltip on hover; one that fits shows none (#719)', async () => {
  render(<Flow state={STATE} flow={firstFlow(STATE)} />);
  const group = groupOf();
  const status = group.firstElementChild!;
  expect(status).not.toHaveAttribute('title');
  fireEvent.pointerMove(group, { pointerType: 'mouse' });
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  fireEvent.pointerLeave(group, { pointerType: 'mouse' });
  Object.defineProperty(group, 'scrollWidth', { configurable: true, value: 240 });
  Object.defineProperty(group, 'clientWidth', { configurable: true, value: 120 });
  fireEvent.pointerMove(group, { pointerType: 'mouse' });
  expect(await screen.findByRole('tooltip')).toHaveTextContent(`${status.textContent} · falhou · 1/2`);
  cleanup();
});
