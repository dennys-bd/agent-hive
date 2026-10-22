import { useId } from 'react';
import type { PreviewState } from '@/components/benchmark/pr/BenchmarkPrDialog';
import { WorkspaceSquare } from '@/components/WorkspaceSquare';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { t, tPlural } from '@/i18n';
import type { PrProblem } from '@/lib/benchmark-pr-api';
import { runGroups, runLabel } from '@/lib/benchmark-pr';
import { bestRun } from '../../../../benchmark/pr-pick';
import type { Experiment } from '../../../../types';

interface PrFieldsProps {
  experiment: Experiment; picked?: string; preview: PreviewState; branch: string; isBranchValid: boolean; withSummary: boolean; problem?: PrProblem;
  onPick(token: string): void; onBranch(branch: string): void; onSummary(withSummary: boolean): void;
}

const KEY = 'text-muted-foreground';
const PILL = 'inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs';
const NO_VALUE = '-';

function RunPicker({ id, experiment, picked, onPick }: { id: string; experiment: Experiment; picked?: string; onPick(token: string): void }) {
  const groups = runGroups(experiment);
  const best = bestRun(experiment);
  if (groups.length === 0) return <span className={KEY}>{t('benchmark.pr.noRuns')}</span>;
  return (
    <Select value={picked} onValueChange={onPick}>
      <SelectTrigger id={id} className="w-full"><SelectValue /></SelectTrigger>
      <SelectContent>
        {groups.map(({ arm, runs }) => (
          <SelectGroup key={arm.id}>
            <SelectLabel>{`${arm.letter} · ${arm.name}`}</SelectLabel>
            {runs.map((run) => <SelectItem key={run.token} value={run.token}>{runLabel(run, best)}</SelectItem>)}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}

// The workspace's colour square is the design system's one colour exception; origin/<base> waits for the preview
function WorkspaceRow({ workspace, base }: { workspace: string; base?: string }) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className={PILL}><WorkspaceSquare name={workspace} />{workspace}</span>
      {base !== undefined && <span className={`${PILL} font-mono`}>{base}</span>}
    </span>
  );
}

// A conflict's or a dirty checkout's files, inline: an error the dialog shows gets no toast
function FileList({ label, files }: { label: string; files: string[] }) {
  return (
    <div className="flex flex-col gap-1 text-xs">
      <p className="text-destructive">{label}</p>
      <ul className="font-mono">{files.map((file) => <li key={file}>{file}</li>)}</ul>
    </div>
  );
}

function commitsText(preview: PreviewState): string {
  if (preview.state === 'loading') return t('benchmark.pr.loading');
  if (preview.state === 'failed') return NO_VALUE;
  const { commits, tasks, baseSha } = preview.preview;
  return tPlural('benchmark.pr.commitsLine', commits, { n: commits, tasks, sha: baseSha });
}

function branchNoteOf(isBranchValid: boolean, problem: PrProblem | undefined): string | undefined {
  if (problem?.error === 'branch-exists') return t('benchmark.pr.branchExists');
  return !isBranchValid || problem?.error === 'invalid-branch' ? t('benchmark.pr.branchInvalid') : undefined;
}

/** dlg-pr's body (#477): the run picker, the workspace and its base, the branch, the commits line, the summary checkbox and the footer's note. */
export function PrFields({ experiment, picked, preview, branch, isBranchValid, withSummary, problem, onPick, onBranch, onSummary }: PrFieldsProps) {
  const id = useId();
  const ready = preview.state === 'ready' ? preview.preview : undefined;
  const note = branchNoteOf(isBranchValid, problem);
  return (
    <div className="flex flex-col gap-4 text-[13px]">
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-3">
        <Label htmlFor={`${id}-run`} className={KEY}>{t('benchmark.pr.run')}</Label>
        <RunPicker id={`${id}-run`} experiment={experiment} picked={picked} onPick={onPick} />
        <span className={KEY}>{t('benchmark.pr.workspace')}</span>
        <WorkspaceRow workspace={experiment.seed.workspace} base={ready?.base} />
        <Label htmlFor={`${id}-branch`} className={KEY}>{t('benchmark.pr.branch')}</Label>
        <div className="flex flex-col gap-1">
          <Input
            id={`${id}-branch`} className="font-mono" value={branch} aria-invalid={note !== undefined}
            aria-describedby={note === undefined ? undefined : `${id}-branch-note`} onChange={(e) => onBranch(e.target.value)}
          />
          {note !== undefined && <span id={`${id}-branch-note`} className="text-destructive text-xs">{note}</span>}
        </div>
        <span className={KEY}>{t('benchmark.pr.commits')}</span>
        <span className={KEY}>{commitsText(preview)}</span>
        <span className={KEY}>{t('benchmark.pr.description')}</span>
        <label className="flex items-center gap-2">
          <input type="checkbox" className="size-3.5 accent-primary" checked={withSummary} onChange={(e) => onSummary(e.target.checked)} />
          {t('benchmark.pr.summary')}
        </label>
      </div>
      {ready?.via === 'checkout' && <p className="text-muted-foreground text-xs">{t('benchmark.pr.inCheckout')}</p>}
      {problem?.error === 'conflict' && <FileList label={t('benchmark.pr.conflict')} files={problem.files} />}
      {problem?.error === 'dirty' && <FileList label={t('benchmark.pr.dirty')} files={problem.files} />}
      <p className="text-muted-foreground text-xs">{t('benchmark.pr.note')}</p>
    </div>
  );
}
