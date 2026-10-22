import { useId } from 'react';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { t } from '@/i18n';
import type { WorkspaceDraft } from '@/lib/settings-form';
import { settingAnchor } from '@/lib/settings-search';
import { BENCHMARK_PR_IN, type BenchmarkPrIn } from '../../../types';

interface WorkspaceBenchmarkPrProps { row: WorkspaceDraft; onChange(patch: Partial<WorkspaceDraft>): void }

const isPrIn = (value: string): value is BenchmarkPrIn => (BENCHMARK_PR_IN as readonly string[]).includes(value);

/** Where a benchmark run's PR is rebased and pushed from (#477): a temporary worktree, or this workspace's own checkout. The PR dialog never
 *  asks again: this is the choice. */
export function WorkspaceBenchmarkPr({ row, onChange }: WorkspaceBenchmarkPrProps) {
  const id = useId();
  return (
    <div id={settingAnchor('settings.workspaces.benchmarkPrIn', row.id)} className="flex max-w-80 flex-col gap-2">
      <Label htmlFor={id}>{t('settings.workspaces.benchmarkPrIn')}</Label>
      <Select value={row.benchmarkPrIn} onValueChange={(value) => { if (isPrIn(value)) onChange({ benchmarkPrIn: value }); }}>
        <SelectTrigger id={id} className="w-full"><SelectValue /></SelectTrigger>
        <SelectContent>
          {BENCHMARK_PR_IN.map((via) => <SelectItem key={via} value={via}>{t(`settings.workspaces.benchmarkPrIn.${via}`)}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}
