import { type KeyboardEvent, useEffect, useState } from 'react';
import type { DecompositionHive, DecompositionPreview, DecompositionProblem, DecompositionSource, TaskEntry } from '../../types';
import { HIVE_SOURCE } from '../../tasks';
import { ButtonKeyHint } from '@/components/KeyHint';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { closeDecomposition, type DecompositionChoice, lastChoice, useDecompositionWrite, useOpenDecomposition, writeDecomposition } from '@/hooks/use-decomposition-write';
import { t, tPlural } from '@/i18n';
import { getJson } from '@/lib/api';
import { pressed } from '@/lib/shortcut-bindings';

const MUTED = 'text-muted-foreground';

const chosen = (source?: DecompositionSource): DecompositionChoice => (source === undefined ? {} : { source: source.name, ...(source.column === undefined ? {} : { column: source.column }) });

interface Option { value: string; label: string }
const plain = (names: readonly string[]): Option[] => names.map((name) => ({ value: name, label: name }));

// #784: the hive's choice, at the suggested entry when the preview has one; no entry key = not chosen yet
const hiveChoice = ({ entry }: DecompositionHive): DecompositionChoice => ({ source: HIVE_SOURCE, ...(entry === undefined ? {} : { entry }) });

// #784, decisions 4 and 6: the hive first while the preview offers it (the screen's order); a recorded hive target offers nothing else, since
// local numbers are never read as issue numbers
const sourceNames = (preview: DecompositionPreview): string[] =>
  [...(preview.hive === undefined ? [] : [HIVE_SOURCE]), ...(preview.target === HIVE_SOURCE ? [] : preview.sources.map((s) => s.name))];

const sameEntry = (a: TaskEntry, b: TaskEntry): boolean => (a === null || b === null ? a === b : a.flow === b.flow && a.stage === b.stage);

// The choice on open (#784, decision 5): the last write's while the preview still offers its source; else the hive for a recorded hive
// target, a hive goal (preselected) or no GitHub source; else the first source, the goal's own (sourcesOf sorts it first), with its column
function openingChoice(preview: DecompositionPreview, last?: DecompositionChoice): DecompositionChoice {
  const { hive } = preview;
  // an entry the preview no longer offers (its flow edited since the last write) falls back to the suggested one, never a blank enabled picker
  if (last?.source === HIVE_SOURCE && hive !== undefined && last.entry !== undefined && !hive.entries.some((e) => sameEntry(e, last.entry ?? null))) return hiveChoice(hive);
  if (last?.source !== undefined && sourceNames(preview).includes(last.source)) return last;
  if (hive !== undefined && (preview.target === HIVE_SOURCE || hive.preselected === true || preview.sources.length === 0)) return hiveChoice(hive);
  return preview.target === HIVE_SOURCE ? {} : chosen(preview.sources[0]);
}

// entra em (#784, decision 9): sem fluxo, a flow, flow · stage, in the preview's order. A flow's first stage right after the flow is left out:
// the flow alone lands there. Values are the entries' indexes, never their labels, so a flow named with " · " cannot collide
function entryOptions(entries: readonly TaskEntry[]): Option[] {
  return entries.flatMap((entry, at): Option[] => {
    const value = String(at);
    if (entry === null) return [{ value, label: t('create.noFlow') }];
    if (entry.stage === undefined) return [{ value, label: entry.flow }];
    const before = entries[at - 1];
    const isFirstStage = before !== undefined && before !== null && before.flow === entry.flow && before.stage === undefined;
    return isFirstStage ? [] : [{ value, label: `${entry.flow} · ${entry.stage}` }];
  });
}

function entryValue(entries: readonly TaskEntry[], { entry }: DecompositionChoice): string | undefined {
  if (entry === undefined) return undefined;
  const at = entries.findIndex((e) => sameEntry(e, entry));
  return at < 0 ? undefined : String(at);
}

// One picker (#865): a label over a select of `options`
function Picker({ id, label, value, options, disabled = false, onChange }: { id: string; label: string; value?: string; options: readonly Option[]; disabled?: boolean; onChange(value: string): void }) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value ?? ''} disabled={disabled} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-full"><SelectValue /></SelectTrigger>
        <SelectContent>{options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
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
function Summary({ preview, hive }: { preview: DecompositionPreview; hive?: DecompositionHive }) {
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
  // #784: under the hive, the tasks the write creates (a GitHub goal's root task included)
  const written = hive === undefined ? tPlural('decomposition.issues', preview.issues, { n: preview.issues }) : tPlural('decomposition.tasks', hive.tasks, { n: hive.tasks });
  const counts = `${written}, ${tPlural('decomposition.blockers', preview.blockers, { n: preview.blockers })}`;
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

type DeliveryRow = NonNullable<DecompositionHive['delivery']>;

// Where the file is pushed (#936): the checkout's repository, branch and path, or why it cannot go; the user sees what is pushed before creating anything.
// A file git ignores is pushed nowhere (#741): the row says it stays local, muted, since that is the workspace's choice and no error. #784: the
// hive's row may name no repository or branch, so the line joins what it has
function Delivery({ delivery, refusal }: { delivery?: DeliveryRow; refusal?: string }) {
  const where = delivery && [delivery.repository, delivery.branch, delivery.path].filter((part) => part !== undefined).join(' · ');
  const pushed = delivery && <p className="text-sm"><span className={MUTED}>{`${t('decomposition.delivery')} `}</span><span className="font-mono">{where}</span></p>;
  return (
    <>
      {delivery?.local === true ? <p className={`${MUTED} text-sm`}>{`${t('decomposition.local')} · ${delivery.path}`}</p> : pushed}
      {refusal !== undefined && <p className="text-destructive text-sm">{refusal}</p>}
    </>
  );
}

// Where the write goes (#865, #936): the repository and the delivery; #784: under the hive no repository row, the hive's own delivery and why
// it cannot write (decision 10), so the top-level repository and refusal are never read there
function Target({ preview, hive }: { preview: DecompositionPreview; hive?: DecompositionHive }) {
  if (hive === undefined) return <><Repository repository={preview.repository} /><Delivery delivery={preview.delivery} refusal={preview.deliveryRefusal} /></>;
  return (
    <>
      <Delivery delivery={hive.delivery} refusal={hive.deliveryRefusal} />
      {hive.refusal !== undefined && <p className="text-destructive text-sm">{hive.refusal}</p>}
    </>
  );
}

// criar issues or criar tarefas (#865; #784, decision 11): no problem, then the chosen target's own needs. The top-level repository and
// deliveryRefusal are the GitHub target's, never read under the hive; a recorded hive target with the hive gone has no choice, so nothing
function isWritable(preview: DecompositionPreview, choice: DecompositionChoice): boolean {
  if (preview.problems.length > 0) return false;
  const { hive } = preview;
  if (choice.source === HIVE_SOURCE) return hive !== undefined && choice.entry !== undefined && hive.deliveryRefusal === undefined && hive.refusal === undefined;
  const source = preview.sources.find((s) => s.name === choice.source);
  return preview.repository !== undefined && preview.deliveryRefusal === undefined && source !== undefined && choice.column !== undefined;
}

// The source and its second picker (#865; #784: the hive first, with entra em in place of coluna), or why there is none. Both stay disabled
// while the write runs (#781); a recorded hive target locks the source on the hive (decision 6)
function Sources({ preview, choice, isRunning, onChoice }: { preview: DecompositionPreview; choice: DecompositionChoice; isRunning: boolean; onChoice(choice: DecompositionChoice): void }) {
  const names = sourceNames(preview);
  if (names.length === 0) return <p className="text-destructive text-sm">{t('decomposition.noSource')}</p>;
  const { hive } = preview;
  const source = preview.sources.find((s) => s.name === choice.source);
  const pick = (name: string): void => onChoice(name === HIVE_SOURCE && hive !== undefined ? hiveChoice(hive) : chosen(preview.sources.find((s) => s.name === name)));
  return (
    <div className="grid grid-cols-2 gap-2">
      <Picker id="decomposition-source" label={t('decomposition.source')} value={choice.source} options={plain(names)} disabled={isRunning || preview.target === HIVE_SOURCE} onChange={pick} />
      {choice.source === HIVE_SOURCE && hive !== undefined
        ? <Picker id="decomposition-entry" label={t('decomposition.entry')} value={entryValue(hive.entries, choice)} options={entryOptions(hive.entries)} disabled={isRunning} onChange={(at) => onChoice({ ...choice, entry: hive.entries[Number(at)] ?? null })} />
        : <Picker id="decomposition-column" label={t('decomposition.column')} value={choice.column} options={plain(source?.statuses ?? [])} disabled={isRunning} onChange={(column) => onChoice({ ...choice, column })} />}
    </div>
  );
}

// #781: while the write runs, fechar replaces cancelar, since closing leaves the write going rather than cancelling it, and the primary is busy
// with no second press. esc is the key's own name, as SearchChrome's. #784: the hive's words under the hive
function Footer({ isRunning, canWrite, isHive, onWrite, onClose }: { isRunning: boolean; canWrite: boolean; isHive: boolean; onWrite(): void; onClose(): void }) {
  if (isRunning) {
    return (
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>{t('base.close')}<span aria-hidden="true" className="text-xs tracking-widest opacity-60">esc</span></Button>
        <Button type="button" disabled><Spinner />{t(isHive ? 'decomposition.creatingHive' : 'decomposition.creating')}</Button>
      </DialogFooter>
    );
  }
  return (
    <DialogFooter>
      <Button type="button" variant="outline" onClick={onClose}>{t('base.cancel')}</Button>
      <Button type="button" onClick={onWrite} disabled={!canWrite}>{t(isHive ? 'decomposition.createHive' : 'decomposition.create')}<ButtonKeyHint id="confirm" /></Button>
    </DialogFooter>
  );
}

/** The decomposition's confirm (#865): what the tree writes, or its problems with their lines; the target repository; the GitHub source
 * (the first preselected) and the Status column (the first stage's, suggested). criar issues is disabled while there is a problem, no
 * repository or no choice. #784: the hive too, offered first while the preview carries it, with its own words, rows and entra em. The write lives in the store (#781), so it outlives this dialog: reopened while it runs, the dialog shows it running.
 * A failure stays here with GitHub's words (a transient one shows its own copy, #702), and a second press resumes the write. */
function DecompositionDialog({ activityId }: { activityId: string }) {
  const { isRunning, error: writeFailure } = useDecompositionWrite(activityId);
  const [preview, setPreview] = useState<DecompositionPreview>();
  const [choice, setChoice] = useState<DecompositionChoice>({});
  const [readFailure, setReadFailure] = useState<string>();
  useEffect(() => {
    getJson<DecompositionPreview>(`/activities/${encodeURIComponent(activityId)}/decomposition`)
      .then((read) => { setPreview(read); setChoice(openingChoice(read, lastChoice(activityId))); }, (err: Error) => setReadFailure(err.message));
  }, [activityId]);
  const hive = choice.source === HIVE_SOURCE ? preview?.hive : undefined; // #784: the hive chosen, and offered
  // #784, decision 3: blank until the preview loads, then the chosen target's title
  const title = preview === undefined ? '' : t(hive === undefined ? 'decomposition.title' : 'decomposition.titleHive');
  // a running write's words come from its own choice until the preview loads (or when its read failed), so a hive write never reads issues
  const isHive = hive !== undefined || (preview === undefined && lastChoice(activityId)?.source === HIVE_SOURCE);
  const canWrite = preview !== undefined && !isRunning && isWritable(preview, choice);
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
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{preview?.title ?? ''}</DialogDescription>
        </DialogHeader>
        {preview && <Summary preview={preview} hive={hive} />}
        {preview && <Target preview={preview} hive={hive} />}
        {preview && <Sources preview={preview} choice={choice} isRunning={isRunning} onChoice={setChoice} />}
        {/* #781: mounted from the open and filled when the write starts, so a screen reader announces it; sr-only while empty, so it takes no row */}
        <p role="status" className={isRunning ? `${MUTED} text-sm` : 'sr-only'}>{isRunning ? t(isHive ? 'decomposition.runningHive' : 'decomposition.running') : ''}</p>
        {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
        <Footer isRunning={isRunning} canWrite={canWrite} isHive={isHive} onWrite={write} onClose={close} />
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
