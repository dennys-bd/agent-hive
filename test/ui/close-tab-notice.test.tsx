import { fireEvent, render, screen } from '@testing-library/react';
import { toast } from 'sonner';
import { beforeEach, expect, test, vi } from 'vitest';
import { type CloseTabNoticeInput, type CloseTabSettings, sleepsOnClose, noticeInput, noticeKey, noticeOn, showCloseTabNotice } from '@/components/close-tab-notice';
import { NOTICE_MS } from '@/components/NoticeShell';
import { setLanguage, t } from '@/i18n';
import type { Activity } from '@/lib/activities';
import type { LiveRun } from '../../src/task-runs';
import type { Task } from '../../src/types';
import { localPairOf, taskPairOf } from '../fixtures/work';

// sonner is mocked so the custom toast, its options and its dismissals are observable
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), custom: vi.fn(), dismiss: vi.fn() }) }));

const STAGE: LiveRun = { ptyId: 'W1', label: 'Claude · a1b2c3d4', kind: 'stage', session: 'a1b2c3d4' };
const FREE: LiveRun = { ptyId: 'W2', label: 'Claude · 9e03b7c2', kind: 'session', session: '9e03b7c2' };
const SETTINGS: CloseTabSettings = { closeSessionTab: 'keep', closeStageTab: 'sleep', closeSessionTabNotice: true, closeStageTabNotice: false };
const task: Task = { item: { itemId: 'I1', id: '11', title: 'Task 11', body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true };
const TASK: Activity = { kind: 'task', ...taskPairOf('I1'), task, runs: [STAGE, FREE], sessions: [], status: 'working', worker: true };
const LOCAL: Activity = { kind: 'local', ...localPairOf('hive'), workspace: 'hive', runs: [FREE], sessions: [], kept: [] };
const input = (patch: Partial<CloseTabNoticeInput> = {}): CloseTabNoticeInput => ({ run: FREE, where: '#11 Task 11', onSleep: vi.fn(), ...patch });

// The notice as sonner would mount it for toast id 't1'
const renderNotice = () => {
  const [build] = vi.mocked(toast.custom).mock.calls.at(-1) ?? [];
  return render(build?.('t1'));
};

beforeEach(() => {
  setLanguage('pt');
  vi.mocked(toast.custom).mockClear();
  vi.mocked(toast.dismiss).mockClear();
});

test('sleepsOnClose reads closeSessionTab for a free or local session\'s run and closeStageTab for a stage\'s; noticeOn reads the matching switch (#614)', () => {
  expect([sleepsOnClose(FREE, SETTINGS), sleepsOnClose(STAGE, SETTINGS), noticeOn(FREE, SETTINGS), noticeOn(STAGE, SETTINGS)]).toEqual([false, true, true, false]);
  const flipped: CloseTabSettings = { closeSessionTab: 'sleep', closeStageTab: 'keep', closeSessionTabNotice: false, closeStageTabNotice: true };
  expect([sleepsOnClose(FREE, flipped), sleepsOnClose(STAGE, flipped), noticeOn(FREE, flipped), noticeOn(STAGE, flipped)]).toEqual([true, false, false, true]);
});

test('noticeInput names the task and a stage run\'s stage, and carries the caller\'s dormir; a local session reads local and names no stage (#614, #672)', () => {
  const onSleep = vi.fn();
  const stage = noticeInput(STAGE, TASK, SETTINGS, onSleep);
  expect([stage.run, stage.where, stage.stage, stage.onSleep]).toEqual([STAGE, '#11 Task 11', 'dev', onSleep]);
  expect(noticeInput(FREE, TASK, SETTINGS, vi.fn()).stage).toBeUndefined();
  const local = noticeInput(FREE, LOCAL, SETTINGS, vi.fn());
  expect([local.where, local.stage]).toEqual(['local', undefined]);
});

test('the notice lasts NOTICE_MS in a toast of its own width, and reabrir, dormir and the link each close it after their action (#614)', () => {
  const onReopen = vi.fn();
  const onSleep = vi.fn();
  const openSettings = vi.fn();
  showCloseTabNotice(input({ onReopen, onSleep, openSettings }));
  expect(vi.mocked(toast.custom).mock.calls[0][1]).toEqual({ duration: NOTICE_MS, style: { width: 440 } });
  renderNotice();
  expect(screen.getByText('tab fechada, sessão aberta')).toBeInTheDocument();
  for (const key of ['closeTabNotice.reopen', 'closeTabNotice.sleep', 'closeTabNotice.settings'] as const) fireEvent.click(screen.getByRole('button', { name: t(key) }));
  expect([onReopen, onSleep, openSettings].map((f) => f.mock.calls.length)).toEqual([1, 1, 1]);
  expect(vi.mocked(toast.dismiss).mock.calls).toEqual([['t1'], ['t1'], ['t1']]);
});

test('não avisar de novo saves that kind\'s notice switch off, unchecking saves it back on, and the notice stays open (#614)', () => {
  const saveNotice = vi.fn(async () => true);
  showCloseTabNotice(input({ saveNotice }));
  const { unmount } = renderNotice();
  fireEvent.click(screen.getByRole('checkbox', { name: t('closeTabNotice.dismiss') }));
  expect(saveNotice).toHaveBeenLastCalledWith('closeSessionTabNotice', false);
  unmount();
  showCloseTabNotice(input({ run: STAGE, saveNotice }));
  renderNotice();
  const box = screen.getByRole('checkbox', { name: t('closeTabNotice.dismiss') });
  fireEvent.click(box);
  expect(saveNotice).toHaveBeenLastCalledWith('closeStageTabNotice', false);
  fireEvent.click(box);
  expect(saveNotice).toHaveBeenLastCalledWith('closeStageTabNotice', true);
  expect(toast.dismiss).not.toHaveBeenCalled();
});

test('a terminal\'s tab follows closeTerminalTab and its own notice switch, absent reading as sleep and on (#696)', () => {
  const shell: LiveRun = { ptyId: 'T1', label: 'Terminal', kind: 'terminal' };
  expect([sleepsOnClose(shell, SETTINGS), noticeKey(shell), noticeOn(shell, SETTINGS)]).toEqual([true, 'closeTerminalTabNotice', true]);
  expect([sleepsOnClose(shell, { ...SETTINGS, closeTerminalTab: 'keep' }), noticeOn(shell, { ...SETTINGS, closeTerminalTabNotice: false })]).toEqual([false, false]);
});
