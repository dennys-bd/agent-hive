import { type KeyboardEvent, useEffect, useState } from 'react';
import type { DecompositionPreview, DecompositionProblem, DecompositionSource } from '../../types';
import { ButtonKeyHint } from '@/components/KeyHint';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { closeDecomposition, type DecompositionChoice, useDecompositionWrite, useOpenDecomposition, writeDecomposition } from '@/hooks/use-decomposition-write';
import { t, tPlural } from '@/i18n';
import { getJson } from '@/lib/api';
import { pressed } from '@/lib/shortcut-bindings';

const MUTED = 'text-muted-foreground';

const chosen = (source?: DecompositionSource): DecompositionChoice => (source === undefined ? {} : { source: source.name, ...(source.column === undefined ? {} : { column: source.column }) });

// One picker (#865): a label over a select of `options`
function Picker({ id, label, value, options, disabled = false, onChange }: { id: string; label: string; value?: string; options: string[]; disabled?: boolean; onChange(value: string): void }) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value ?? ''} disabled={disabled} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-full"><SelectValue /></SelectTrigger>
        <SelectContent>{options.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}</SelectContent>
      </Select>
    </div>
  );
}

// The overlaps (#936): nodes touching the same files with no blocker between them. Muted: they never stop the write. The list scrolls on its
// own (#555) so a long one never pushes the confirm button off the screen
function Warnings({ warnings }: { warnings: DecompositionProblem[] }) {
  if (warnings.length === 0) return null;
  return (
    <div className={`flex flex-col gap-1 text-sm ${MUTED}`}>
      <p>{t('decomposition.warnings')}</p>
      <ul className="max-h-48 list-disc overflow-y-auto pl-5">
        {warnings.map((w) => <li key={`${w.line}:${w.message}`}>{t('decomposition.problem', { line: w.line, message: w.message })}</li>)}
      </ul>
    </div>
  );
}

// What will be written, or why nothing can be (#865): the problems with their lines, else the counts and the suggestions left out
function Summary({ preview }: { preview: DecompositionPreview }) {
  if (preview.problems.length > 0) {
    return (
      <div className="flex flex-col gap-1 text-sm">
        <p>{t('decomposition.problems')}</p>
        <ul className="list-disc pl-5 text-destructive">
          {preview.problems.map((p) => <li key={`${p.line}:${p.message}`}>{t('decomposition.problem', { line: p.line, message: p.message })}</li>)}
        </ul>
      </div>
    );
  }
  const counts = `${tPlural('decomposition.issues', preview.issues, { n: preview.issues })}, ${tPlural('decomposition.blockers', preview.blockers, { n: preview.blockers })}`;
  return (
    <div className="flex flex-col gap-1 text-sm">
      <p>{counts}</p>
      {preview.suggestions > 0 && <p className={MUTED}>{tPlural('decomposition.suggestions', preview.suggestions, { n: preview.suggestions })}</p>}
      <Warnings warnings={preview.warnings} />
    </div>
  );
}

// Where the issues go (#865), or why there is nowhere: a local goal whose workspace has no GitHub origin
function Repository({ repository }: { repository?: string }) {
  if (repository === undefined) return <p className="text-destructive text-sm">{t('decomposition.noRepository')}</p>;
  return <p className="text-sm"><span className={MUTED}>{`${t('decomposition.repository')} `}</span><span className="font-mono">{repository}</span></p>;
}

// Where the file is pushed (#936): the checkout's repository, branch and path, or why it cannot go; the user sees what is pushed before creating anything.
// A file git ignores is pushed nowhere (#741): the row says it stays local, muted, since that is the workspace's choice and no error
function Delivery({ preview }: { preview: DecompositionPreview }) {
  const { delivery, deliveryRefusal } = preview;
  const pushed = delivery && <p className="text-sm"><span className={MUTED}>{`${t('decomposition.delivery')} `}</span><span className="font-mono">{`${delivery.repository} · ${delivery.branch} · ${delivery.path}`}</span></p>;
  return (
    <>
      {delivery?.local === true ? <p className={`${MUTED} text-sm`}>{`${t('decomposition.local')} · ${delivery.path}`}</p> : pushed}
      {deliveryRefusal !== undefined && <p className="text-destructive text-sm">{deliveryRefusal}</p>}
    </>
  );
}

// The source and its Status column (#865), or why there is none; both stay disabled while the write runs (#781), so the write cannot change under it
function Sources({ preview, choice, isRunning, onChoice }: { preview: DecompositionPreview; choice: DecompositionChoice; isRunning: boolean; onChoice(choice: DecompositionChoice): void }) {
  if (preview.sources.length === 0) return <p className="text-destructive text-sm">{t('decomposition.noSource')}</p>;
  const source = preview.sources.find((s) => s.name === choice.source);
  return (
    <div className="grid grid-cols-2 gap-2">
      <Picker id="decomposition-source" label={t('decomposition.source')} value={choice.source} options={preview.sources.map((s) => s.name)} disabled={isRunning} onChange={(name) => onChoice(chosen(preview.sources.find((s) => s.name === name)))} />
      <Picker id="decomposition-column" label={t('decomposition.column')} value={choice.column} options={source?.statuses ?? []} disabled={isRunning} onChange={(column) => onChoice({ ...choice, column })} />
    </div>
  );
}

// #781: while the write runs, fechar replaces cancelar, since closing leaves the write going rather than cancelling it, and the primary is busy
// with no second press. esc is the key's own name, as SearchChrome's
function Footer({ isRunning, canWrite, onWrite, onClose }: { isRunning: boolean; canWrite: boolean; onWrite(): void; onClose(): void }) {
  if (isRunning) {
    return (
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>{t('base.close')}<span aria-hidden="true" className="text-xs tracking-widest opacity-60">esc</span></Button>
        <Button type="button" disabled><Spinner />{t('decomposition.creating')}</Button>
      </DialogFooter>
    );
  }
  return (
    <DialogFooter>
      <Button type="button" variant="outline" onClick={onClose}>{t('base.cancel')}</Button>
      <Button type="button" onClick={onWrite} disabled={!canWrite}>{t('decomposition.create')}<ButtonKeyHint id="confirm" /></Button>
    </DialogFooter>
  );
}

/** The decomposition's confirm (#865): what the tree writes, or its problems with their lines; the target repository; the GitHub source
 * (the first preselected) and the Status column (the first stage's, suggested). criar issues is disabled while there is a problem, no
 * repository or no choice. The write lives in the store (#781), so it outlives this dialog: reopened while it runs, the dialog shows it running.
 * A failure stays here with GitHub's words (a transient one shows its own copy, #702), and a second press resumes the write. */
function DecompositionDialog({ activityId }: { activityId: string }) {
  const { isRunning, error: writeFailure } = useDecompositionWrite(activityId);
  const [preview, setPreview] = useState<DecompositionPreview>();
  const [choice, setChoice] = useState<DecompositionChoice>({});
  const [readFailure, setReadFailure] = useState<string>();
  useEffect(() => {
    getJson<DecompositionPreview>(`/activities/${encodeURIComponent(activityId)}/decomposition`)
      .then((read) => { setPreview(read); setChoice(chosen(read.sources[0])); }, (err: Error) => setReadFailure(err.message));
  }, [activityId]);
  const source = preview?.sources.find((s) => s.name === choice.source);
  const canWrite = preview !== undefined && preview.problems.length === 0 && preview.repository !== undefined && preview.deliveryRefusal === undefined && source !== undefined && choice.column !== undefined && !isRunning;
  const write = (): void => { void writeDecomposition(activityId, choice); };
  const close = (): void => closeDecomposition(activityId);
  // the confirm shortcut, as every other dialog's (#585); only while criar issues is enabled
  const onKeyDown = (e: KeyboardEvent): void => {
    if (canWrite && pressed(e.nativeEvent, 'confirm')) { e.preventDefault(); write(); }
  };
  const error = writeFailure ?? readFailure;
  return (
    <Dialog open onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent aria-busy={isRunning} onKeyDown={onKeyDown}>
        <DialogHeader>
          <DialogTitle>{t('decomposition.title')}</DialogTitle>
          <DialogDescription>{preview?.title ?? ''}</DialogDescription>
        </DialogHeader>
        {preview && <Summary preview={preview} />}
        {preview && <Repository repository={preview.repository} />}
        {preview && <Delivery preview={preview} />}
        {preview && <Sources preview={preview} choice={choice} isRunning={isRunning} onChoice={setChoice} />}
        {/* #781: mounted from the open and filled when the write starts, so a screen reader announces it; sr-only while empty, so it takes no row */}
        <p role="status" className={isRunning ? `${MUTED} text-sm` : 'sr-only'}>{isRunning ? t('decomposition.running') : ''}</p>
        {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
        <Footer isRunning={isRunning} canWrite={canWrite} onWrite={write} onClose={close} />
      </DialogContent>
    </Dialog>
  );
}

/** The window's one decomposition dialog (#781), for the store's open activity: the approval's criar issues, the task menu's A and a toast's
 * reabrir all open it, so it shows with neither mount point on screen. Keyed by the activity, so another one's open mounts a fresh preview. */
export function DecompositionHost() {
  const activityId = useOpenDecomposition();
  if (activityId === undefined) return null;
  return <DecompositionDialog key={activityId} activityId={activityId} />;
}
