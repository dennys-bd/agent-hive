// What closing an agent's tab does (#614), and every notice's switch (#672): the settings, read by the center's tabs through a context App
// provides from the config, and the notice that follows a close that keeps the session, while its kind's switch is on. A close that puts the
// session to sleep shows the sleep notice instead (sleep-notice.tsx).
import { createContext, useContext } from 'react';
import { toast } from 'sonner';
import type { LiveRun } from '../../task-runs';
import { ranAgent } from '../../agents';
import { taskLabel } from '../../tasks';
import { CLOSE_TAB_DEFAULTS, type CloseTabAction, type Config } from '../../types';
import { act } from '@/components/actions';
import { CloseTabNotice } from '@/components/CloseTabNotice';
import { NOTICE_MS, NOTICE_WIDTH } from '@/components/NoticeShell';
import { activityRunTab, type OpenRun } from '@/components/terminal-tabs';
import { t } from '@/i18n';
import type { Activity } from '@/lib/activities';
import { strayAgents } from '@/lib/stray-agents';

export type CloseTabNoticeKey = 'closeSessionTabNotice' | 'closeStageTabNotice' | 'closeTerminalTabNotice';
/** One switch per cause of a sleep (#672). */
export type SleepNoticeKey = 'sleepNotice' | 'sleepAutoNotice' | 'sleepIdleNotice' | 'sleepAllNotice';
export type NoticeKey = CloseTabNoticeKey | SleepNoticeKey;

/** The close-tab settings as the center reads them (#614); the four sleep switches (#672) and a terminal's close (#696), absent reading as the
 * form's defaults; the notices' link to Settings › execution, and their checkbox's save of one switch. */
export interface CloseTabSettings extends Partial<Pick<Config, SleepNoticeKey | 'closeTerminalTab' | 'closeTerminalTabNotice'>> {
  closeSessionTab: CloseTabAction; closeStageTab: CloseTabAction; closeSessionTabNotice: boolean; closeStageTabNotice: boolean;
  openSettings?(): void;
  saveNotice?(key: NoticeKey, on: boolean): Promise<boolean>;
}

// Outside App (the tests' harness): a new form's defaults, and the notice has no link and no save
export const CloseTabContext = createContext<CloseTabSettings>(CLOSE_TAB_DEFAULTS);

export const useCloseTab = (): CloseTabSettings => useContext(CloseTabContext);

/** A run's stop (#283), a manual sleep for an agent's (#672): whether the server took it. */
export const stopRun = (ptyId: string): Promise<boolean> =>
  act<{ ok: true }>(`/ptys/${encodeURIComponent(ptyId)}/stop`).then((answer) => answer !== undefined);

/** A sleeping run's tab closed (#672): its kept transcript goes. */
export const forgetRun = (ptyId: string): void => void act(`/ptys/${encodeURIComponent(ptyId)}/scrollback`, undefined, 'DELETE');

/** What asks before a terminal sleeps when an agent the shim missed runs in it (#696): the center's confirm dialog, told which terminal so it
 * can name it (#75). */
export type ConfirmLoss = (sleep: () => void, ptyId: string) => void;

/** A terminal put to sleep from its tab or its keep notice (#696): stopped at once, or after confirmLoss when an agent the shim missed runs
 * there. Its stop reads its cwd first (the server's readCwd). */
export function sleepTerminal(ptyId: string, confirmLoss: ConfirmLoss): void {
  const sleep = (): void => void stopRun(ptyId);
  void strayAgents(ptyId).then((count) => (count === 0 ? sleep() : confirmLoss(sleep, ptyId)));
}

/** Where a notice says a session is (#614, #672): the task's label, or local. */
export const whereOf = (activity: Activity): string => (activity.kind === 'task' ? taskLabel(activity.task) : t('activities.local'));

// A free or a local session's run is kind session and follows the session settings; a stage's run the stage ones
const isSession = (run: LiveRun): boolean => run.kind === 'session';

// What closing a run's tab does (#614, #696): a terminal's own setting, a free or a local session's, or a stage's
function actionOf(run: LiveRun, settings: CloseTabSettings): CloseTabAction {
  if (run.kind === 'terminal') return settings.closeTerminalTab ?? CLOSE_TAB_DEFAULTS.closeTerminalTab;
  return isSession(run) ? settings.closeSessionTab : settings.closeStageTab;
}

/** Whether closing `run`'s tab puts it to sleep (#614, #696): sleep in the setting its kind follows. */
export const sleepsOnClose = (run: LiveRun, settings: CloseTabSettings): boolean => actionOf(run, settings) === 'sleep';

/** The switch that shows the keep notice after `run`'s tab closes (#614, #696), and whether it is on. */
export function noticeKey(run: LiveRun): CloseTabNoticeKey {
  if (run.kind === 'terminal') return 'closeTerminalTabNotice';
  return isSession(run) ? 'closeSessionTabNotice' : 'closeStageTabNotice';
}
export const noticeOn = (run: LiveRun, settings: CloseTabSettings): boolean => settings[noticeKey(run)] !== false; // an absent switch reads on (#696)

/** What showCloseTabNotice shows (#614): the closed run, the words and the actions. */
export interface CloseTabNoticeInput {
  run: LiveRun; where: string; stage?: string;
  onReopen?(): void; onSleep(): void; openSettings?(): void; saveNotice?(key: NoticeKey, on: boolean): Promise<boolean>;
}

/** The notice's words and actions after `run`'s tab closed with its session kept (#614): the task's label or local, a stage run's stage,
 * reabrir (its tab again), the caller's dormir (a sleep with the sleep notice, #672), and the settings' link and save. */
export function noticeInput(run: LiveRun, activity: Activity, settings: CloseTabSettings, onSleep: () => void, openRun?: OpenRun): CloseTabNoticeInput {
  return {
    run, onSleep, where: whereOf(activity),
    stage: run.kind === 'stage' && activity.kind === 'task' ? activity.task.stage : undefined,
    onReopen: () => openRun?.(activityRunTab(activity, run)),
    openSettings: settings.openSettings,
    saveNotice: settings.saveNotice,
  };
}

/** The notice after an agent's tab closes and its session keeps running (#614), a terminal's with its own words (#696), for NOTICE_MS: each
 * action closes it first; the checkbox saves its kind's switch off (or back on) and leaves it open. */
export function showCloseTabNotice({ run, where, stage, onReopen, onSleep, openSettings, saveNotice }: CloseTabNoticeInput): void {
  const key = noticeKey(run);
  toast.custom((id) => {
    const then = (action: () => void) => (): void => {
      toast.dismiss(id);
      action();
    };
    return (
      <CloseTabNotice
        agent={ranAgent(run)} session={run.session} where={where} stage={stage} terminal={run.kind === 'terminal' ? run.label : undefined}
        onReopen={onReopen && then(onReopen)} onSleep={then(onSleep)} onSettings={openSettings && then(openSettings)}
        onDontWarn={saveNotice && ((checked) => saveNotice(key, !checked))} onClose={() => toast.dismiss(id)}
      />
    );
  }, { duration: NOTICE_MS, style: { width: NOTICE_WIDTH } });
}
