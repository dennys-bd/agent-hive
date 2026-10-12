import type { AgentId } from '../../types';
import { NoticeShell, whoOf } from '@/components/NoticeShell';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';

export interface CloseTabNoticeProps {
  agent: AgentId; // #925: the closed run's agent
  session?: string; // what the run's tab names it: its name or short id, unknown for a stage run before its SessionStart
  where: string; // the task's label, or local
  stage?: string; // a stage run's stage
  terminal?: string; // #696: a terminal's label: the keep notice speaks of it, not of a session
  onReopen?(): void; onSleep(): void; onSettings?(): void; onDontWarn?(checked: boolean): Promise<boolean>; onClose(): void;
}

/** The notice after an agent's tab closes and its session keeps running (#614), as the user's image draws it: tab fechada, sessão aberta;
 * reabrir, dormir (no longer in the destructive colour: sleeping loses nothing, #672) and the settings' link. A close that sleeps the session
 * shows the sleep notice instead. A pure view: showCloseTabNotice mounts it in sonner and binds the callbacks. */
export function CloseTabNotice({ agent, session, where, stage, terminal, onReopen, onSleep, ...shell }: CloseTabNoticeProps) {
  const actions = (
    <>
      {onReopen && <Button type="button" variant="outline" size="sm" className="h-7" onClick={onReopen}>{t('closeTabNotice.reopen')}</Button>}
      <Button type="button" variant="outline" size="sm" className="h-7" onClick={onSleep}>{t('closeTabNotice.sleep')}</Button>
    </>
  );
  const title = t(terminal === undefined ? 'closeTabNotice.title.keep' : 'closeTabNotice.title.keepTerminal');
  const body = terminal === undefined
    ? t('closeTabNotice.body.keep', { who: whoOf(agent, session, stage), where })
    : t('closeTabNotice.body.keepTerminal', { who: terminal, where });
  return <NoticeShell title={title} body={body} actions={actions} {...shell} />;
}
