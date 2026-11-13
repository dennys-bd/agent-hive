import { CheckIcon, CircleAlertIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Confirm } from '@/components/Confirm';
import { DialogBase } from '@/components/DialogBase';
import { refusalText } from '@/components/DeleteActivity';
import {
  activityKey, type CleanTarget, cleanTargets, countsOf, hasRefused, orphanWorktrees, progressOf, type RowState, runClean, runForce, type States, worktreeKey,
} from '@/components/settings/workspace-removal-clean';
import { AlertDialogDescription } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { t } from '@/i18n';
import type { WorkspaceHoldings } from '../../../types';

type Phase = 'filled' | 'cleaning' | 'after';

const K = 'settings.workspaces.removal';
const MUTED = 'text-muted-foreground';

/** Thrown by the clean up when git refused some rows: a rejected action keeps the dialog open (DialogBase), showing the outcome. */
class RefusedRows extends Error {}

interface RowProps { lead?: string; title: string; isMono?: boolean; status?: ReactNode; note?: ReactNode; isDone?: boolean }

// One row of a list: [id] title, its status cell at the right, a second line under the title (a reason, or a refusal)
function Row({ lead, title, isMono, status, note, isDone }: RowProps) {
  const struck = isDone ? `${MUTED} line-through` : '';
  return (
    <li className={`grid items-center gap-x-3 gap-y-1 px-3 py-2 text-[13px] ${lead === undefined ? 'grid-cols-[minmax(0,1fr)_auto]' : 'grid-cols-[5rem_minmax(0,1fr)_auto]'}`}>
      {lead !== undefined && <span className={`truncate font-mono text-xs ${MUTED} ${isDone ? 'line-through' : ''}`}>{lead}</span>}
      <span className={`truncate ${isMono ? 'font-mono text-xs' : ''} ${struck}`} title={title}>{title}</span>
      <span className={`inline-flex min-h-7 items-center justify-end gap-1.5 whitespace-nowrap text-xs ${MUTED}`}>{status}</span>
      {note !== undefined && <div className={`col-span-full ${lead === undefined ? '' : 'sm:col-start-2'}`}>{note}</div>}
    </li>
  );
}

function Section({ title, count, hint, children }: { title: string; count: number; hint?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="flex items-baseline gap-2 font-medium text-[13px]">{title}<span className={`font-normal text-xs ${MUTED}`}>{hint === undefined ? count : `${count} · ${hint}`}</span></h3>
      <ul className="divide-y rounded-md border">{children}</ul>
    </section>
  );
}

interface StatusProps { state: RowState | undefined; idle?: ReactNode; onForce(): void }

// A row's status cell: what it is before the clean up, then queued → deleting → deleted, or the force button of a refusal
function Status({ state, idle, onForce }: StatusProps) {
  switch (state?.kind) {
    case undefined: return idle;
    case 'queued': return t(`${K}.row.queued`);
    case 'deleting': return <><Spinner />{t(`${K}.row.deleting`)}</>;
    case 'deleted': return <><CheckIcon className="size-3.5" />{t(`${K}.row.deleted`)}</>;
    case 'refused': return <Button type="button" variant="outline" size="xs" onClick={onForce} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onForce(); } }}>{t('task.force')}</Button>;
  }
}

const noteOf = (state: RowState | undefined, reason?: string): ReactNode => {
  if (state?.kind === 'refused') return <p role="alert" className="whitespace-pre-wrap text-destructive text-xs">{refusalText(state.refused)}</p>;
  return reason === undefined ? undefined : <p className={`text-xs ${MUTED}`}>{reason}</p>;
};

interface ListProps { holdings: WorkspaceHoldings; states: States; targets: CleanTarget[]; onForce(target: CleanTarget): void }

function ActivityRows({ holdings, states, targets, onForce }: ListProps) {
  return (
    <Section title={t(`${K}.activities`)} count={holdings.activities.length}>
      {holdings.activities.map((a) => {
        const key = activityKey(a.activityId);
        const state = states[key];
        const target = targets.find((x) => x.key === key);
        const idle = a.removable && !holdings.running ? t(`${K}.row.willGo`) : undefined;
        const reason = a.removable ? undefined : t(`${K}.reason.${a.reason}`);
        return <Row key={key} lead={a.task.id} title={a.task.title} isDone={state?.kind === 'deleted'} status={<Status state={state} idle={idle} onForce={() => target && onForce(target)} />} note={noteOf(state, reason)} />;
      })}
    </Section>
  );
}

function WorktreeRows({ holdings, states, targets, onForce }: ListProps) {
  const orphans = orphanWorktrees(holdings);
  if (orphans.length === 0) return null;
  return (
    <Section title={t(`${K}.worktrees`)} count={orphans.length}>
      {orphans.map((row) => {
        const key = worktreeKey(row.slug);
        const state = states[key];
        const target = targets.find((x) => x.key === key);
        return <Row key={key} title={row.slug} isMono isDone={state?.kind === 'deleted'} status={<Status state={state} idle={t('worktrees.orphan')} onForce={() => target && onForce(target)} />} note={noteOf(state)} />;
      })}
    </Section>
  );
}

// What clean up leaves alone: information only
function InfoRows({ holdings, name }: { holdings: WorkspaceHoldings; name: string }) {
  return (
    <>
      {holdings.branches.length > 0 && (
        <Section title={t(`${K}.branches`)} count={holdings.branches.length} hint={t(`${K}.branches.hint`)}>
          {holdings.branches.map((b) => <Row key={b.slug} title={b.branch} isMono status={t(`${K}.branch.target`, { target: b.target })} />)}
        </Section>
      )}
      {holdings.tasks.length > 0 && (
        <Section title={t(`${K}.tasks`)} count={holdings.tasks.length} hint={t(`${K}.tasks.hint`, { name })}>
          {holdings.tasks.map((task) => <Row key={task.id} lead={task.id} title={task.title} />)}
        </Section>
      )}
    </>
  );
}

function useCleanup(holdings: WorkspaceHoldings, onDone: () => void) {
  const [states, setStates] = useState<States>({});
  const [phase, setPhase] = useState<Phase>('filled');
  const targets = cleanTargets(holdings);
  const clean = async (): Promise<void> => {
    let acc: States = Object.fromEntries(targets.map((x): [string, RowState] => [x.key, { kind: 'queued' }]));
    setStates(acc);
    setPhase('cleaning');
    await runClean(targets, (key, state) => { acc = { ...acc, [key]: state }; setStates(acc); });
    if (hasRefused(acc)) {
      setPhase('after');
      throw new RefusedRows();
    }
    onDone();
  };
  // true when no refused row is left
  const force = async (target: CleanTarget): Promise<boolean> => {
    // states is current here: the force confirm is modal, so one force runs at a time
    const next = { ...states, [target.key]: await runForce(target.url) };
    setStates(next);
    return !hasRefused(next);
  };
  return { states, phase, targets, clean, force };
}

export interface WorkspaceRemovalProps { name: string; holdings: WorkspaceHoldings; open: boolean; onOpenChange(open: boolean): void; onRemove(): void }

/** The dialog of a saved workspace's ×, opened when it still holds work (#751): what it holds, then clean up and remove (one after another,
 * never forced), or remove anyway (the configuration only). Refused rows are forced one by one, through DeleteActivity's own confirm. */
export function WorkspaceRemoval({ name, holdings, open, onOpenChange, onRemove }: WorkspaceRemovalProps) {
  const [forcing, setForcing] = useState<CleanTarget>();
  const { states, phase, targets, clean, force } = useCleanup(holdings, onRemove);
  const refused = forcing === undefined ? undefined : states[forcing.key];
  const list = { holdings, states, targets, onForce: setForcing };
  const isCleaning = phase === 'cleaning';
  const anyway = { label: t(`${K}.removeAnyway`), onConfirm: onRemove };
  const primary = holdings.running ? undefined
    : phase === 'after' ? anyway
    : { label: isCleaning ? <><Spinner />{t(`${K}.cleaning`)}</> : t(`${K}.cleanUp`), onConfirm: clean, pending: isCleaning };
  const secondary = holdings.running || phase === 'after' ? undefined : { ...anyway, disabled: isCleaning };
  return (
    <>
      <DialogBase
        title={t(`${K}.title`, { name })} size="md" open={open} onOpenChange={(next) => { if (next || !isCleaning) onOpenChange(next); }}
        context={<AlertDialogDescription className="text-[13px]">{t(`${K}.lead`)}{!holdings.running && ` ${t(`${K}.lead.actions`)}`}</AlertDialogDescription>}
        closeButton={!isCleaning} isCancelLocked={isCleaning} primary={primary} secondary={secondary}
      >
        <div className="flex flex-col gap-4">
          {holdings.running && (
            <p role="status" className="flex items-start gap-2 text-[13px]"><CircleAlertIcon className="mt-0.5 size-4 shrink-0" /><span>{t(`${K}.running`, { name })}<br /><span className={MUTED}>{t(`${K}.running.hint`)}</span></span></p>
          )}
          {isCleaning && <p role="status" className={`text-[13px] ${MUTED}`}>{t(`${K}.progress`, { n: progressOf(states), total: targets.length })}</p>}
          {phase === 'after' && <p role="status" className={`text-[13px] ${MUTED}`}>{t(`${K}.outcome`, countsOf(states))}</p>}
          {holdings.activities.length > 0 && <ActivityRows {...list} />}
          <WorktreeRows {...list} />
          <InfoRows holdings={holdings} name={name} />
        </div>
      </DialogBase>
      <Confirm
        open={forcing !== undefined} onOpenChange={(next) => { if (!next) setForcing(undefined); }} title={t('confirm.title.forceDelete')}
        message={`${refused?.kind === 'refused' ? refusalText(refused.refused) : ''}\n\n${t('confirm.forceDeleteActivity')}`} confirmLabel={t('task.force')}
        onConfirm={async () => { if (forcing && await force(forcing)) { onRemove(); onOpenChange(false); } }}
      />
    </>
  );
}
