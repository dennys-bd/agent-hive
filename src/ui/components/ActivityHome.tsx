import { type KeyboardEvent, type ReactNode, useContext, useEffect, useRef } from 'react';
import { continueTaskSession } from '@/components/actions';
import { ClaudeIcon } from '@/components/ClaudeIcon';
import { ButtonKeyHint } from '@/components/KeyHint';
import { openLocalSession } from '@/components/local-runs';
import { DefaultAgentContext, newRunEntries, referenceOf, startEntry } from '@/components/NewRunButton';
import { StatusWord } from '@/components/StatusWord';
import { useOpenDiff, useOpenRun } from '@/components/terminal-tabs';
import { openTerminal, terminalName } from '@/components/TerminalLines';
import { Button, buttonVariants } from '@/components/ui/button';
import { type MessageKey, t } from '@/i18n';
import type { Activity } from '@/lib/activities';
import { type HomeSession, homeSessions, homeTerminals } from '@/lib/activity-home';
import { keptRef } from '@/lib/copy-targets';

const MUTED = 'text-muted-foreground text-xs';
const ROW = 'flex w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-md px-3 py-[7px] text-left text-[13px] outline-none hover:bg-accent/50 focus:bg-card';
const ACTION = buttonVariants({ variant: 'outline', size: 'xs' });
const SESSION_ACTION: Record<HomeSession['action'], MessageKey> = { open: 'home.open', continue: 'session.continue' };

interface ActivityHomeProps { activity: Activity; onOpenRun(ptyId: string): void }
interface RowProps { mark: ReactNode; name: string; meta?: string; status?: ReactNode; action: string; onRun(): void }

// One row (#759): its mark in a fixed 14px slot (so names align, an agent with no logo included), its name, its meta, its status and its
// action word drawn as an outline xs button. The row is the one button, so its click and ↵ act alike and no button sits inside another
function ActivityHomeRow({ mark, name, meta, status, action, onRun }: RowProps) {
  return (
    <button type="button" data-home-row onClick={onRun} className={ROW}>
      <span aria-hidden="true" className="flex size-3.5 shrink-0 items-center justify-center">{mark}</span>
      <span className="shrink-0">{name}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground text-xs">{meta}</span>
      {status}
      <span className={ACTION}>{action}</span>
    </button>
  );
}

function Block({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-label={label} className="flex flex-col gap-0.5">
      <h3 className={`pb-1.5 ${MUTED}`}>{label}</h3>
      {children}
    </section>
  );
}

// ↑ ↓ move the focus across both blocks' rows (#759). They are handled on the list's own keydown, so they act only while the focus is inside
// the home and never fight the sidebar's keys or a dialog's. ↵ needs nothing: the focused row is a button
function moveFocus(event: KeyboardEvent<HTMLDivElement>): void {
  const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
  if (step === 0) return;
  event.preventDefault();
  const rows = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-home-row]'));
  const at = rows.indexOf(document.activeElement as HTMLButtonElement);
  rows[Math.min(Math.max(at + step, 0), rows.length - 1)]?.focus();
}

// The two blocks (#759): the sessions, then the terminals, each left out with no row. The first row takes the focus when the home mounts, or
// when its first rows arrive after it, but never from another element the user put it on
function Rows({ activity, onOpenRun }: ActivityHomeProps) {
  const openRun = useOpenRun();
  const list = useRef<HTMLDivElement>(null);
  const sessions = homeSessions(activity, Date.now());
  const terminals = homeTerminals(activity);
  const hasRows = sessions.length > 0 || terminals.length > 0;
  const hasMounted = useRef(false);
  useEffect(() => {
    const isFree = document.activeElement === null || document.activeElement === document.body;
    if (hasRows && (!hasMounted.current || isFree)) list.current?.querySelector<HTMLButtonElement>('[data-home-row]')?.focus();
    hasMounted.current = true;
  }, [hasRows]);
  // What the sidebar's line does (#759): a run's tab, a task's sleeping session continued, a local session through the local line's own open
  const runSession = ({ target }: HomeSession): void => {
    if (target.kind === 'run') onOpenRun(target.ptyId);
    else if (activity.kind === 'task') continueTaskSession(activity.task, keptRef(activity, target.session.id), openRun);
    else openLocalSession(activity.workspace, target.session, target.live, openRun);
  };
  if (!hasRows) return null;
  // ponytail: every session is claude's while AGENT_IDS holds only claude; rows name their own agent once #101 adds another
  const claudeMark = <ClaudeIcon className="size-3.5" />;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would bring a border and a legend; the group only holds the rows its arrow keys move across (#759)
    <div ref={list} role="group" onKeyDown={moveFocus} className="flex flex-col gap-7">
      {sessions.length > 0 && (
        <Block label={t('center.empty.sessions', { n: sessions.length })}>
          {sessions.map((row) => (
            <ActivityHomeRow
              key={row.key} mark={claudeMark} name={t('session.claude')} meta={row.meta.join(' · ')}
              status={<StatusWord status={row.status} emptyWord="session.sleeping" />} action={t(SESSION_ACTION[row.action])} onRun={() => runSession(row)}
            />
          ))}
        </Block>
      )}
      {terminals.length > 0 && (
        <Block label={t('center.empty.terminals', { n: terminals.length })}>
          {terminals.map((terminal) => (
            <ActivityHomeRow
              key={terminal.terminalId} mark={<span className="font-mono text-muted-foreground">$</span>} name={terminalName(terminal)}
              status={terminal.asleep ? <StatusWord status="empty" emptyWord="session.sleeping" /> : undefined}
              action={t(terminal.asleep ? 'terminal.wake' : 'home.open')} onRun={() => openTerminal(terminal, onOpenRun)}
            />
          ))}
        </Block>
      )}
    </div>
  );
}

// The new-run row (#759): the + menu's entries, from the same list, as outline buttons with their keys; disabled where the + is
function NewRunRow({ activity }: { activity: Activity }) {
  const openRun = useOpenRun();
  const openDiff = useOpenDiff();
  const defaultAgent = useContext(DefaultAgentContext);
  const label = t('center.empty.new', { activity: referenceOf(activity) });
  return (
    <section aria-label={label} className="flex flex-col gap-1.5">
      <h3 className={MUTED}>{label}</h3>
      <div className="flex flex-wrap gap-2">
        {newRunEntries(activity, defaultAgent).map((entry) => (
          <Button
            key={entry.kind} type="button" variant="outline" disabled={entry.disabled} className="h-auto gap-2 px-3 py-1.5 text-[13px]"
            onClick={() => startEntry(activity, entry.kind, openRun, openDiff)}
          >
            {entry.label}{entry.key && <ButtonKeyHint id={entry.key} />}
          </Button>
        ))}
      </div>
    </section>
  );
}

/** The picked activity's center with no tab open (#759), shaped like the global home (redesign 08): a title and a subtitle saying that
 * closing a tab left the session alive, the activity's sessions and kept terminals with an action each, and the + menu's ways to start a run. */
export function ActivityHome({ activity, onOpenRun }: ActivityHomeProps) {
  return (
    <section aria-label={t('center.empty')} className="flex min-h-0 min-w-0 flex-1 justify-center overflow-y-auto bg-background px-12 py-16">
      <div className="flex w-full max-w-[520px] flex-col gap-7">
        <div className="flex flex-col gap-2">
          <h2 className="font-semibold text-lg leading-none">{t('center.empty')}</h2>
          <p className="text-pretty text-[13px] text-muted-foreground">{t('center.empty.subtitle')}</p>
        </div>
        <Rows activity={activity} onOpenRun={onOpenRun} />
        <NewRunRow activity={activity} />
      </div>
    </section>
  );
}
