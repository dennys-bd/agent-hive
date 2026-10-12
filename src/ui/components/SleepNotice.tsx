import type { AgentId } from '../../types';
import { NoticeShell, whoOf } from '@/components/NoticeShell';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';

export interface SleepNoticeProps {
  sessions: { agent: AgentId; session?: string; stage?: string }[]; // who slept: one, or each of a sleep all's
  where: string; // the task's label, or local
  hasTab: boolean; // a single session's tab is still open on its transcript
  onContinue?(): void; onSettings?(): void; onDontWarn?(checked: boolean): Promise<boolean>; onClose(): void;
}

// The sessions of a sleep all as one phrase: commas, then the language's `and` before the last
function listOf(names: string[]): string {
  if (names.length < 2) return names.join('');
  return `${names.slice(0, -1).join(', ')} ${t('sleepNotice.and')} ${names[names.length - 1]}`;
}

/** The sleep notice (#672), in the close-tab notice's layout: the title, the body, continuar (continuar todas for several) and the settings'
 * link, não avisar de novo and the countdown bar. A pure view: showSleepNotice mounts it and binds the callbacks. */
export function SleepNotice({ sessions, where, hasTab, onContinue, ...shell }: SleepNoticeProps) {
  const names = sessions.map(({ agent, session, stage }) => whoOf(agent, session, stage));
  const isMany = names.length > 1;
  const title = isMany ? t('sleepNotice.titleMany', { n: names.length }) : t('sleepNotice.title');
  const body = isMany
    ? t('sleepNotice.bodyMany', { list: listOf(names), where })
    : t(hasTab ? 'sleepNotice.body.tab' : 'sleepNotice.body.noTab', { who: names[0] ?? '', where });
  const actions = onContinue && (
    <Button type="button" variant="outline" size="sm" className="h-7" onClick={onContinue}>{t(isMany ? 'sleepNotice.continueAll' : 'session.continue')}</Button>
  );
  return <NoticeShell title={title} body={body} actions={actions} {...shell} />;
}
