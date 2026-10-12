import { type KeyboardEvent, useId, useRef, useState } from 'react';
import { taskOfActivity } from '../../activities.js';
import type { CopySummary, OpenResult, SessionRef, SessionTarget, State } from '../../types.js';
import { attachRun } from '@/components/actions';
import { ButtonKeyHint } from '@/components/KeyHint';
import { SwitchRow } from '@/components/StartFields';
import { localRunTab, useOpenRun } from '@/components/terminal-tabs';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCopySummary } from '@/hooks/use-copy-summary';
import { t, tPlural } from '@/i18n';
import { postJson } from '@/lib/api';
import { localKey } from '@/lib/activities';
import { copyLabels, sessionPath } from '@/lib/copy-targets';
import { pressed } from '@/lib/shortcut-bindings';
import { fmt } from '@/lib/usage';
import { shownSize } from '@/lib/xterm-setup';

export interface CopySessionDialogProps {
  state: State; from: SessionRef; to: SessionTarget;
  shown?: string; // the activity the center shows: a copy into it opens as its tab (A5)
  onClose(): void;
}

const LOADING = '…';
const end = (path: string, branch: string | null): string => `${path} · ${branch ?? t('copy.noBranch')}`;

// The POST, and what follows it: the run opens as a tab only when the destination is the activity the center shows; a refusal stays in the dialog
function useCopySubmit({ state, from, to, shown, onClose }: CopySessionDialogProps) {
  const openRun = useOpenRun();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const submit = (name: string, notice: boolean): void => {
    if (pending) return;
    setPending(true);
    setError(undefined);
    postJson<OpenResult>(`${sessionPath(from)}/copy`, { to, name: name.trim() || undefined, notice, size: shownSize() }).then((result) => {
      const target = state.activities.find((a) => a.id === to.activityId); // a live activity (#629)
      const task = target?.kind === 'task' ? taskOfActivity(state, target.id) : undefined;
      if (task && task.item.itemId === shown) attachRun(result, task, 'session', openRun);
      else if (target?.kind === 'local' && localKey(target.workspace) === shown && result?.ptyId) openRun?.(localRunTab(result.ptyId, target.workspace, 'session')); // #590
      onClose();
    }, (err: Error) => { setPending(false); setError(err.message); });
  };
  return { pending, error, submit };
}

function SummaryGrid({ summary }: { summary?: CopySummary }) {
  const history = summary && `${tPlural('copy.messages', summary.messages, { n: summary.messages })} · ${t('copy.tokens', { n: fmt(summary.tokens) })}`;
  const rows: [string, string, boolean][] = [
    [t('copy.from'), summary ? end(summary.from.path, summary.from.branch) : LOADING, true],
    [t('copy.into'), summary ? end(summary.to.path, summary.to.branch) : LOADING, true],
    [t('copy.history'), history ?? LOADING, false],
  ];
  return (
    <div className="grid grid-cols-[80px_minmax(0,1fr)] gap-x-2 gap-y-1.5 rounded-md border bg-background p-2.5 text-xs">
      {rows.map(([label, value, isMono]) => (
        <div key={label} className="contents">
          <span className="text-muted-foreground">{label}</span>
          <span className={`truncate ${isMono ? 'font-mono' : ''}`}>{value}</span>
        </div>
      ))}
    </div>
  );
}

// The code stays where it is (A3): the second clause only when the source has uncommitted changes
function CodeWarning({ summary, from }: { summary: CopySummary; from: string }) {
  const branch = summary.to.branch ?? t('copy.noBranch');
  const tail = summary.uncommitted > 0 ? tPlural('copy.uncommitted', summary.uncommitted, { n: summary.uncommitted, from }) : '.';
  return (
    <div role="note" className="rounded-md border border-waiting bg-waiting/12 px-2.5 py-2 text-xs leading-4">
      <span className="font-medium text-waiting">{t('copy.warning')}</span>{' '}
      <span>{`${t('copy.noCode', { branch })}${tail}`}</span>
    </div>
  );
}

/** Copiar sessão para… (#587, 6a): the name of the new session, where it comes from and goes to, its size, what the code leaves behind, and
 * whether the agent is told about the change of directory. the confirm key copies; a refusal shows in the dialog, which stays open. */
export function CopySessionDialog(props: CopySessionDialogProps) {
  const { state, from, to, onClose } = props;
  const id = useId();
  const labels = copyLabels(state, from, to);
  const { summary, error: summaryError } = useCopySummary(from, to);
  const { pending, error, submit } = useCopySubmit(props);
  const [name, setName] = useState(t('copy.defaultName', { source: labels.source, to: labels.toRef }));
  const [notice, setNotice] = useState(true);
  const input = useRef<HTMLInputElement>(null);
  const go = (): void => submit(name, notice);
  const onKeyDown = (e: KeyboardEvent): void => {
    if (pressed(e.nativeEvent, 'confirm')) { e.preventDefault(); go(); } // #585: the confirm shortcut, was a fixed ⌘↵
  };
  const shownError = error ?? summaryError;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        className="sm:max-w-[480px]" onKeyDown={onKeyDown}
        onOpenAutoFocus={(e) => { e.preventDefault(); input.current?.focus(); input.current?.select(); }}
      >
        <DialogHeader>
          <DialogTitle>{t('copy.title', { to: labels.to })}</DialogTitle>
          <DialogDescription className="text-[13px]">{t('copy.subtitle', { agent: labels.agent, id: labels.shortId, from: labels.from })}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-name`}>{t('copy.name')}</Label>
          <Input id={`${id}-name`} ref={input} value={name} onChange={(e) => setName(e.target.value)} />
          <p className="text-muted-foreground text-xs">{t('copy.hint', { from: labels.from })}</p>
        </div>
        <SummaryGrid summary={summary} />
        {summary && <CodeWarning summary={summary} from={labels.from} />}
        <SwitchRow id={`${id}-notice`} label={t('copy.notice')} checked={notice} onChange={setNotice} />
        {shownError && <p role="alert" className="text-destructive text-sm">{shownError}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>{t('base.cancel')}</Button>
          <Button type="button" disabled={pending} onClick={go}>
            {t('copy.submit')}<ButtonKeyHint id="confirm" />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
