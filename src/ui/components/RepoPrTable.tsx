import { useState } from 'react';
import type { PrRow, PrState, RepoPrs, RepoSummary, State } from '../../types';
import { ForkEmpty } from '@/components/ForkEmpty';
import { FlowHeader, type RepoTab } from '@/components/FlowHeader';
import { useIsFlowShown } from '@/components/MainDock';
import { RepoPrRow } from '@/components/RepoPrRow';
import { useRepoRead } from '@/hooks/use-repo-issues';
import { reloadRepositories, repoPath } from '@/hooks/use-repositories';
import { type MessageKey, t } from '@/i18n';

const COLUMNS = 'minmax(0,1fr) 80px 56px 120px 112px 56px 64px 80px'; // handoff 03: PR · state · checks · review · merge · stack · task · updated
const HEAD: MessageKey[] = ['prs.col.pr', 'prs.col.state', 'prs.col.checks', 'prs.col.review', 'prs.col.merge', 'prs.col.stack', 'prs.col.task', 'prs.col.updated'];
const SEGMENTS: { id: PrState; label: MessageKey }[] = [{ id: 'open', label: 'prs.segment.open' }, { id: 'merged', label: 'prs.segment.merged' }, { id: 'closed', label: 'prs.segment.closed' }];

// The subbar (handoff 03): abertos N / mergeados / fechados, #757's segmented; lendo… only while nothing is cached
function Subbar({ value, open, isLoading, onChange }: { value: PrState; open: number; isLoading: boolean; onChange(state: PrState): void }) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-3 px-3.5 text-muted-foreground text-xs">
      <div role="radiogroup" aria-label={t('repos.tab.prs')} className="flex rounded-md bg-muted p-0.5">
        {SEGMENTS.map(({ id, label }) => (
          // biome-ignore lint/a11y/useSemanticElements: a styled segment button, as the issue list's; the group keeps its role for a screen reader (#757)
          <button
            key={id} type="button" role="radio" aria-checked={value === id} onClick={() => onChange(id)}
            className={`rounded-[5px] px-2.5 py-0.5 font-medium text-xs ${value === id ? 'bg-background text-foreground' : 'text-muted-foreground'}`}
          >
            {t(label, { n: open })}
          </button>
        ))}
      </div>
      {isLoading && <span>{t('project.loading')}</span>}
    </div>
  );
}

// The table (handoff 03): a 34px header on card, 40px rows, then the open count, the cap when hit, and the ↵ hint
function PrGrid({ prs, state, onOpen, isOriginal }: { prs?: RepoPrs; state: State; onOpen?(row: PrRow): void; isOriginal: boolean }) {
  const footer = t(isOriginal ? 'prs.footer.original' : 'prs.footer', { n: prs?.counts.open ?? 0 });
  return (
    <div className="mx-3.5 mb-3.5 flex min-h-0 flex-col overflow-hidden rounded-[10px] border">
      <div className="min-h-0 overflow-auto">
        <table className="block w-full">
          <thead className="block">
            <tr className="grid h-[34px] items-center gap-3 border-b bg-card px-3 text-muted-foreground text-xs" style={{ gridTemplateColumns: COLUMNS }}>
              {HEAD.map((key) => <th key={key} className="min-w-0 truncate text-left font-normal">{t(key)}</th>)}
            </tr>
          </thead>
          <tbody className="block">
            {(prs?.rows ?? []).map((row) => <RepoPrRow key={row.url} row={row} columns={COLUMNS} state={state} canPush={prs?.canPush !== false} onOpen={onOpen} />)}
          </tbody>
        </table>
      </div>
      <div className="flex h-8 shrink-0 items-center justify-between border-t px-3 text-muted-foreground text-xs">
        <span>{prs?.truncated ? `${footer} · ${t('prs.truncated')}` : footer}</span>
        <span>{t('prs.open')}</span>
      </div>
    </div>
  );
}

export interface RepoPrTableProps { state: State; summary: RepoSummary; onTab(tab: RepoTab): void; onOpen?(row: PrRow): void; onRepository?(repository: string): void }

/** A repository's PRs (#758, handoff 03) under the repository header's PRs tab: open, merged or closed, newest update first. Read on opening,
 * on a segment change and on atualizar, which reads the sidebar's list again too; never polled. */
export function RepoPrTable({ state, summary, onTab, onOpen, onRepository }: RepoPrTableProps) {
  const [prState, setPrState] = useState<PrState>('open');
  const { data, isLoading, reload } = useRepoRead<RepoPrs>(`${repoPath(summary.repository)}/pulls?state=${prState}`);
  const isShown = useIsFlowShown();
  const refresh = async (): Promise<void> => {
    await Promise.all([reloadRepositories(), reload()]);
  };
  const isElsewhere = summary.role === 'fork' && summary.pr === 'original'; // #854: this workspace's PRs go to the original
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <FlowHeader state={state} tasks={[]} isShown={isShown} repository={{ summary, tab: 'prs', onTab, onRepository }} onRefresh={refresh} />
      {isElsewhere ? <ForkEmpty text={t('repos.fork.noPrs', { fork: summary.repository })} original={summary.fork?.parent} onRepository={onRepository} /> : (
        <>
          <Subbar value={prState} open={data?.counts.open ?? summary.openPrs} isLoading={isLoading && data === undefined} onChange={setPrState} />
          <PrGrid prs={data} state={state} onOpen={onOpen} isOriginal={summary.role === 'original'} />
        </>
      )}
    </div>
  );
}
