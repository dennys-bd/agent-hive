import { fireEvent, render } from '@testing-library/react';
import { toast } from 'sonner';
import { beforeEach, expect, test, vi } from 'vitest';
import { CloseTabContext, type CloseTabSettings } from '@/components/close-tab-notice';
import { showSleepNotice, sleepInput, useSleptNotices } from '@/components/sleep-notice';
import { setLanguage } from '@/i18n';
import type { Activity, SleepingRun } from '@/lib/activities';
import { resetViewState } from '@/lib/view-state';
import type { LiveRun } from '../../src/task-runs';
import type { SleepCause, Task } from '../../src/types';
import { taskPairOf } from '../fixtures/work';

// sonner is mocked so the custom toast is observable
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), custom: vi.fn(), dismiss: vi.fn() }) }));

const STAGE: LiveRun = { ptyId: 'W1', label: 'Claude · a1b2c3d4', kind: 'stage', session: 'a1b2c3d4' };
const task: Task = { item: { itemId: 'I1', id: '11', title: 'Task 11', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true };
const ON: CloseTabSettings = { closeSessionTab: 'keep', closeStageTab: 'keep', closeSessionTabNotice: true, closeStageTabNotice: true };
const activity = (slept: SleepingRun[] = []): Activity => ({ kind: 'task', ...taskPairOf('I1'), task, runs: [STAGE], sessions: [], status: 'working', worker: true, slept });
const asleep = (ptyId: string, cause?: SleepCause): SleepingRun => ({ run: { ...STAGE, ptyId }, sessionId: `${ptyId}-session`, ...(cause === undefined ? {} : { cause }) });
const shown = (): number => vi.mocked(toast.custom).mock.calls.length;

function Watcher({ activities }: { activities: Activity[] }) {
  useSleptNotices(activities);
  return null;
}
const Watch = ({ activities, settings = ON }: { activities: Activity[]; settings?: CloseTabSettings }) =>
  <CloseTabContext.Provider value={settings}><Watcher activities={activities} /></CloseTabContext.Provider>;

beforeEach(() => {
  setLanguage('pt');
  resetViewState();
  vi.mocked(toast.custom).mockClear();
});

test('sleepInput names the task, a stage run\'s stage and each session; continuar only for a run that holds a session (#672)', () => {
  const input = sleepInput(activity(), [STAGE], 'manual');
  expect([input.cause, input.where, input.sessions, input.onContinue]).toEqual(['manual', '#11 Task 11', [{ ptyId: 'W1', agent: 'claude', session: 'a1b2c3d4', stage: 'dev' }], undefined]);
  expect(sleepInput(activity([asleep('W5')]), [{ ...STAGE, ptyId: 'W5' }], 'auto').onContinue).toBeTypeOf('function');
});

test('each cause shows its notice only while its own switch is on, and the checkbox saves that switch (#672)', () => {
  const input = sleepInput(activity(), [STAGE], 'idle');
  showSleepNotice(input, { ...ON, sleepIdleNotice: false });
  expect(shown()).toBe(0);
  showSleepNotice(input, { ...ON, sleepNotice: false, sleepAutoNotice: false, sleepAllNotice: false });
  expect(shown()).toBe(1);
  const saveNotice = vi.fn(async () => true);
  showSleepNotice({ ...input, cause: 'all' }, { ...ON, saveNotice });
  const [build] = vi.mocked(toast.custom).mock.calls.at(-1) ?? [];
  const { getByRole } = render(build?.('t1'));
  fireEvent.click(getByRole('checkbox'));
  expect(saveNotice).toHaveBeenLastCalledWith('sleepAllNotice', false);
});

test('an auto or an idle sleep the activities gain shows its notice once while its switch is on; the first list\'s, a manual and an unmarked one never (#672)', () => {
  const { rerender } = render(<Watch activities={[activity([asleep('W0', 'auto')])]} />);
  expect(shown()).toBe(0);
  rerender(<Watch activities={[activity([asleep('W0', 'auto'), asleep('W5', 'auto')])]} />);
  expect(shown()).toBe(1);
  rerender(<Watch activities={[activity([asleep('W0', 'auto'), asleep('W5', 'auto'), asleep('W6', 'manual'), asleep('W7')])]} />);
  expect(shown()).toBe(1);
  rerender(<Watch activities={[activity([asleep('W8', 'idle')])]} settings={{ ...ON, sleepIdleNotice: false }} />);
  expect(shown()).toBe(1);
  rerender(<Watch activities={[activity([asleep('W8', 'idle'), asleep('W9', 'idle')])]} />);
  expect(shown()).toBe(2);
});
