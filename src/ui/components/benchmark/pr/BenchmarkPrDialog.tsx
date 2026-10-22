import { useEffect, useState } from 'react';
import { PrFields } from '@/components/benchmark/pr/PrFields';
import { DialogBase } from '@/components/DialogBase';
import { t } from '@/i18n';
import { openBenchPr, type PrProblem, prProblemOf, readPrPreview } from '@/lib/benchmark-pr-api';
import { initialRun, problemText } from '@/lib/benchmark-pr';
import { type BenchPrPreview, endedRuns, suggestBranch } from '../../../../benchmark/pr-pick';
import { type Experiment, isBranchName } from '../../../../types';

export type PreviewState = { state: 'loading' } | { state: 'ready'; preview: BenchPrPreview } | { state: 'failed' };
interface BenchmarkPrDialogProps { experiment: Experiment; token?: string; onClose(): void }

// The picked run's preview, read again on every pick; an answer for a run no longer picked is dropped
function usePreview(experimentId: string, token: string | undefined): PreviewState {
  const [preview, setPreview] = useState<PreviewState>({ state: 'loading' });
  useEffect(() => {
    if (token === undefined) return undefined;
    let live = true;
    setPreview({ state: 'loading' });
    readPrPreview(experimentId, token).then(
      (read) => { if (live) setPreview({ state: 'ready', preview: read }); },
      () => { if (live) setPreview({ state: 'failed' }); },
    );
    return () => { live = false; };
  }, [experimentId, token]);
  return preview;
}

/** Open a PR with a benchmark run (#477), dlg-pr of docs/agent/design/benchmark.hv.html: one ended run's code out of its isolated origin and
 *  into a PR on the workspace's repository. Exported for the result screen (2.6) and the report tab (2.7), which mount it while it is open. */
export function BenchmarkPrDialog({ experiment, token, onClose }: BenchmarkPrDialogProps) {
  const [picked, setPicked] = useState(() => initialRun(experiment, token)?.token);
  const [branch, setBranch] = useState(() => suggestBranch(experiment.name));
  const [withSummary, setWithSummary] = useState(true);
  const [problem, setProblem] = useState<PrProblem>();
  const preview = usePreview(experiment.id, picked);
  const letter = experiment.arms.find((a) => a.id === endedRuns(experiment).find((r) => r.token === picked)?.armId)?.letter ?? '';
  const isBranchValid = isBranchName(branch.trim());
  const canOpen = preview.state === 'ready' && preview.preview.commits > 0 && isBranchValid;
  const open = async (): Promise<void> => {
    if (picked === undefined) return;
    setProblem(undefined);
    try {
      const { url } = await openBenchPr(experiment.id, picked, { branch: branch.trim(), withSummary });
      window.open(url, '_blank', 'noreferrer'); // as every other PR link opens
    } catch (err) {
      setProblem(prProblemOf(err));
      throw err; // a rejected action keeps DialogBase open, its reason shown inline or under the body
    }
  };
  return (
    <DialogBase
      open onOpenChange={(isOpen) => { if (!isOpen) onClose(); }} title={t('benchmark.pr.title', { letter })} context={t('benchmark.pr.context', { letter })}
      primary={{ label: t('benchmark.pr.open'), onConfirm: open, disabled: !canOpen }}
      error={preview.state === 'failed' ? t('benchmark.pr.failed.preview') : problemText(problem)}
    >
      <PrFields
        experiment={experiment} picked={picked} preview={preview} branch={branch} isBranchValid={isBranchValid} withSummary={withSummary} problem={problem}
        onPick={(next) => { setPicked(next); setProblem(undefined); }} onBranch={(next) => { setBranch(next); setProblem(undefined); }} onSummary={setWithSummary}
      />
    </DialogBase>
  );
}
