import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { StatusBox } from '@/components/DetailSections';
import { setLanguage } from '@/i18n';
import type { Stage, State, TaskApproval, Transition } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { activityIdOf, bareTask, movedWork, type WithWork } from '../fixtures/work';
import { flowed } from '../fixtures/main-flow.js';

// #693: the status box of a task whose approval holds a verdict: the verdict row, its evidence, then everything as before
const SINCE = '2026-11-06T10:00:00.000Z';
const ACTIVITY = activityIdOf('I1');
const stages: Stage[] = [
  { name: 'Brainstorm', from: { board: ['Ready'] }, prompt: '/brainstorm {url}', approval: true, verdicts: ['spike', 'ship', 'task'] },
  { name: 'Spike', from: {}, prompt: '/spike {url}' },
  { name: 'Spec', from: {}, prompt: '/spec {url}' },
];
const transitions: Transition[] = [
  { from: 'Brainstorm', to: 'Spike', when: 'verdict', verdict: 'spike' },
  { from: 'Brainstorm', to: 'end', when: 'verdict', verdict: 'ship' },
  { from: 'Brainstorm', to: 'Spec', when: 'approved' },
];
const LONG = 'The change crosses three owners, so one task would not fit a single PR.\n\n1. The daemon binds a fixed port.\n2. The shell reads it at boot.\n3. The CLI hard-codes it.\n\nEach part ships alone.';
const awaiting = (approval: TaskApproval): WithWork => ({ item: { itemId: 'I1', id: '702', title: 'Pick the port', body: '', url: '' }, stage: 'Brainstorm', boardColumn: 'Ready', auto: true, approval });
const state = (task: WithWork, result?: Record<string, unknown>): State => movedWork<State>({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [], terminals: [], ...flowed(stages, transitions), tasks: [task], sourceOrder: [], localCount: 0, benchmark: { experiments: [] }, semaphores: {}, usage: [], budget: {}, usageRules: [], disabledRules: [], workspaces: ['hive'],
  activities: [], activityRecords: [{ id: ACTIVITY, taskIds: ['I1'], sessions: [], ...(result === undefined ? {} : { result }) }],
  sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
});
const box = (approval: TaskApproval, result?: Record<string, unknown>) => {
  const task = awaiting(approval);
  render(<StatusBox task={bareTask(task)} state={state(task, result)} isActivity={false} />);
  return screen.getByRole('region', { name: 'aguardando aprovação' });
};
beforeEach(() => setLanguage('pt'));
afterEach(() => vi.restoreAllMocks());

test('a routed verdict shows under the head: veredito, the pill, the hidden aprovar leva a and the destination titled with it, then the evidence, then aprovar (#693)', () => {
  const status = box({ since: SINCE, verdict: 'spike' }, { verdict: { name: 'spike', evidence: 'The port race lives in src/daemon.ts:88-104.' } });
  expect(within(status).getByText('veredito')).toBeInTheDocument();
  const pill = within(status).getByTitle('spike');
  expect(pill).toHaveTextContent('spike');
  expect(within(status).getByText('aprovar leva a')).toHaveClass('sr-only');
  expect(within(status).getByTitle('aprovar leva a Spike')).toHaveTextContent('Spike');
  const evidence = within(status).getByText('The port race lives in src/daemon.ts:88-104.');
  const approve = within(status).getByRole('button', { name: 'aprovar' });
  expect(pill.compareDocumentPosition(evidence) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(evidence.compareDocumentPosition(approve) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(within(status).queryByRole('button', { name: 'mostrar tudo' })).not.toBeInTheDocument(); // jsdom lays nothing out: no overflow
});

test('a verdict whose transition goes to end shows the pill alone: no arrow text and no destination (#693)', () => {
  const status = box({ since: SINCE, verdict: 'ship' });
  expect(within(status).getByTitle('ship')).toHaveTextContent('ship');
  expect(within(status).queryByText('aprovar leva a')).not.toBeInTheDocument();
  expect(within(status).queryByTitle(/^aprovar leva a/)).not.toBeInTheDocument();
});

test('an evidence that overflows four lines is clamped, and mostrar tudo / mostrar menos toggle it with aria-expanded and aria-controls, the focus kept (#693)', async () => {
  vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(200);
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(72);
  const user = userEvent.setup();
  const status = box({ since: SINCE, verdict: 'spike' }, { verdict: { name: 'spike', evidence: LONG } });
  const evidence = within(status).getByText('The change crosses three owners', { exact: false });
  expect(evidence).toHaveClass('line-clamp-4');
  const more = within(status).getByRole('button', { name: 'mostrar tudo' });
  expect([more.getAttribute('aria-expanded'), more.getAttribute('aria-controls')]).toEqual(['false', evidence.id]);
  await user.click(more);
  const less = within(status).getByRole('button', { name: 'mostrar menos' });
  expect(less).toBe(more);
  expect([less.getAttribute('aria-expanded'), evidence.classList.contains('line-clamp-4')]).toEqual(['true', false]);
  expect(less).toHaveFocus();
  await user.click(less);
  expect(within(status).getByRole('button', { name: 'mostrar tudo' })).toHaveAttribute('aria-expanded', 'false');
  expect(evidence).toHaveClass('line-clamp-4');
});

test('an approval without a verdict shows no verdict row: the box is today\'s (#693)', () => {
  const status = box({ since: SINCE });
  expect(within(status).queryByText('veredito')).not.toBeInTheDocument();
  expect(within(status).getByRole('button', { name: 'aprovar' })).toBeInTheDocument();
});

test('an evidence the record holds for another verdict is not shown: an older stage\'s stays out (#693)', () => {
  const status = box({ since: SINCE, verdict: 'spike' }, { verdict: { name: 'task', evidence: 'an older stage said so' } });
  expect(within(status).getByTitle('spike')).toBeInTheDocument();
  expect(within(status).queryByText('an older stage said so')).not.toBeInTheDocument();
});

test('switching the box between two tasks awaiting approval, back and forth, shows exactly one verdict: the shown task\'s, with its evidence (#763)', () => {
  // The verdict and the actions once shared their key: a since that changed left the old verdict's nodes behind
  const one = awaiting({ since: SINCE, verdict: 'spike' });
  const two: WithWork = { ...awaiting({ since: '2026-11-06T11:00:00.000Z', verdict: 'task' }), item: { itemId: 'I2', id: '703', title: 'Split the CLI', body: '', url: '' } };
  const both = movedWork<State>({
    ...state(one), tasks: [one, two], activities: [],
    activityRecords: [
      { id: ACTIVITY, taskIds: ['I1'], sessions: [], result: { verdict: { name: 'spike', evidence: 'evidence of 702' } } },
      { id: activityIdOf('I2'), taskIds: ['I2'], sessions: [], result: { verdict: { name: 'task', evidence: 'evidence of 703' } } },
    ],
  });
  const { rerender } = render(<StatusBox task={bareTask(one)} state={both} isActivity={false} />);
  for (const [task, evidence] of [[two, 'evidence of 703'], [one, 'evidence of 702'], [two, 'evidence of 703']] as const) {
    rerender(<StatusBox task={bareTask(task)} state={both} isActivity={false} />);
    const status = screen.getByRole('region', { name: 'aguardando aprovação' });
    expect(within(status).getAllByText('veredito')).toHaveLength(1);
    expect(within(status).getByText(evidence)).toBeInTheDocument();
    expect(within(status).queryAllByText(/^evidence of/)).toHaveLength(1);
  }
  // A new stage end of the same task: its since changes, the box still holds one verdict
  const later = awaiting({ since: '2026-11-06T12:00:00.000Z', verdict: 'spike' });
  rerender(<StatusBox task={bareTask(later)} state={movedWork<State>({ ...both, tasks: [later, bareTask(two)] })} isActivity={false} />);
  expect(within(screen.getByRole('region', { name: 'aguardando aprovação' })).getAllByText('veredito')).toHaveLength(1);
});
