import { useEffect, useState } from 'react';
import type { DecompositionPreview, DecompositionProblem, DecompositionSource } from '../../types';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { t, tPlural } from '@/i18n';
import { getJson, postJson } from '@/lib/api';

const MUTED = 'text-muted-foreground';

interface Choice { source?: string; column?: string }
const chosen = (source?: DecompositionSource): Choice => (source === undefined ? {} : { source: source.name, ...(source.column === undefined ? {} : { column: source.column }) });

// One picker (#865): a label over a select of `options`
function Picker({ id, label, value, options, onChange }: { id: string; label: string; value?: string; options: string[]; onChange(value: string): void }) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value ?? ''} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-full"><SelectValue /></SelectTrigger>
        <SelectContent>{options.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}</SelectContent>
      </Select>
    </div>
  );
}

// The overlaps (#936): nodes touching the same files with no blocker between them. Muted: they never stop the write
function Warnings({ warnings }: { warnings: DecompositionProblem[] }) {
  if (warnings.length === 0) return null;
  return (
    <div className={`flex flex-col gap-1 text-sm ${MUTED}`}>
      <p>{t('decomposition.warnings')}</p>
      <ul className="list-disc pl-5">
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

// Where the file is pushed (#936): the checkout's repository, branch and path, or why it cannot go; the user sees what is pushed before creating anything
function Delivery({ preview }: { preview: DecompositionPreview }) {
  const { delivery, deliveryRefusal } = preview;
  return (
    <>
      {delivery && <p className="text-sm"><span className={MUTED}>{`${t('decomposition.delivery')} `}</span><span className="font-mono">{`${delivery.repository} · ${delivery.branch} · ${delivery.path}`}</span></p>}
      {deliveryRefusal !== undefined && <p className="text-destructive text-sm">{deliveryRefusal}</p>}
    </>
  );
}

/** The decomposition's confirm (#865): what the tree writes, or its problems with their lines; the target repository; the GitHub source
 * (the first preselected) and the Status column (the first stage's, suggested). criar issues is disabled while there is a problem, no
 * repository or no choice. A failure stays here with GitHub's words, and a second press resumes the write. */
export function DecompositionDialog({ activityId, onClose }: { activityId: string; onClose(): void }) {
  const path = `/activities/${encodeURIComponent(activityId)}/decomposition`;
  const [preview, setPreview] = useState<DecompositionPreview>();
  const [choice, setChoice] = useState<Choice>({});
  const [error, setError] = useState<string>();
  const [isWriting, setIsWriting] = useState(false);
  useEffect(() => {
    getJson<DecompositionPreview>(path).then((read) => { setPreview(read); setChoice(chosen(read.sources[0])); }, (err: Error) => setError(err.message));
  }, [path]);
  const source = preview?.sources.find((s) => s.name === choice.source);
  const canWrite = preview !== undefined && preview.problems.length === 0 && preview.repository !== undefined && preview.deliveryRefusal === undefined && source !== undefined && choice.column !== undefined && !isWriting;
  const write = (): void => {
    setIsWriting(true);
    setError(undefined);
    postJson(path, choice).then(() => onClose(), (err: Error) => setError(err.message)).finally(() => setIsWriting(false));
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('decomposition.title')}</DialogTitle>
          <DialogDescription>{preview?.title ?? ''}</DialogDescription>
        </DialogHeader>
        {preview && <Summary preview={preview} />}
        {preview && <Repository repository={preview.repository} />}
        {preview && <Delivery preview={preview} />}
        {preview && preview.sources.length === 0 && <p className="text-destructive text-sm">{t('decomposition.noSource')}</p>}
        {preview && preview.sources.length > 0 && (
          <div className="grid grid-cols-2 gap-2">
            <Picker id="decomposition-source" label={t('decomposition.source')} value={choice.source} options={preview.sources.map((s) => s.name)} onChange={(name) => setChoice(chosen(preview.sources.find((s) => s.name === name)))} />
            <Picker id="decomposition-column" label={t('decomposition.column')} value={choice.column} options={source?.statuses ?? []} onChange={(column) => setChoice({ ...choice, column })} />
          </div>
        )}
        {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>{t('base.cancel')}</Button>
          <Button type="button" onClick={write} disabled={!canWrite}>{t('decomposition.create')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
