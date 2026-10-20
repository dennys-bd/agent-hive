import { useState } from 'react';
import { taskOfIssue } from '../../repos/issue-task';
import type { RepoIssue, RepoIssues, RepoSummary, State } from '../../types';
import { ColumnScroll, HeaderHandles, useColumnWidths } from '@/components/ColumnDividers';
import { ForkEmpty } from '@/components/ForkEmpty';
import { FlowHeader, type RepoTab } from '@/components/FlowHeader';
import { useIsFlowShown } from '@/components/MainDock';
import { RepoIssueRow } from '@/components/RepoIssueRow';
import { Syncing } from '@/components/ui/spinner';
import { useRepoIssues } from '@/hooks/use-repo-issues';
import { reloadRepositories } from '@/hooks/use-repositories';
import { type MessageKey, t } from '@/i18n';
import { gridTemplate, type WidthColumn, withWidths } from '@/lib/column-widths';
import { readRepoListWidths, writeRepoListWidths } from '@/lib/repo-list-views';

interface ListColumn extends WidthColumn { head: MessageKey }
// handoff 02's widths (the handoff gives no defaults of its own for the lists): labels · resp. · in the flow · PR · updated, after the issue
const COLUMNS: ListColumn[] = [
  { key: 'labels', width: 132, head: 'repos.col.labels' }, { key: 'assignee', width: 40, head: 'repos.col.assignee' },
  { key: 'flow', width: 112, head: 'repos.col.flow' }, { key: 'pr', width: 120, head: 'repos.col.pr' }, { key: 'updated', width: 80, head: 'repos.col.updated' },
];
const SUBBAR = 'flex h-10 shrink-0 items-center gap-3 px-3.5 text-muted-foreground text-xs';
type IssueState = RepoIssues['state'];

// The search (#757): the title or #number, case-insensitive, over the issues read in the current state
const matches = (issue: RepoIssue, term: string): boolean => term === '' || issue.title.toLowerCase().includes(term) || `#${issue.number}`.includes(term);

interface SubbarProps { summary: RepoSummary; value: IssueState; onChange(state: IssueState): void; issues?: RepoIssues; isLoading: boolean }

// The subbar (handoff 02): abertas N / fechadas N with GitHub's counts from the summary, lendo… only while nothing is cached, the cap when
// hit. A list the model never synced (#182) shows the syncing mark in place of each N, silent there since the body announces it: a 0 would read as no issues
function Subbar({ summary, value, onChange, issues, isLoading }: SubbarProps) {
  const isSyncing = issues?.syncedAt === null;
  const item = (id: IssueState, label: MessageKey, n: number) => (
    // biome-ignore lint/a11y/useSemanticElements: a styled segment button; a native radio cannot take this look, and the group keeps its role for a screen reader (#757)
    <button
      key={id} type="button" role="radio" aria-checked={value === id} onClick={() => onChange(id)}
      className={`rounded-[5px] px-2.5 py-0.5 font-medium text-xs ${value === id ? 'bg-background text-foreground' : 'text-muted-foreground'}`}
    >
      {t(label)} <span className="font-normal text-muted-foreground">{isSyncing ? <Syncing isRepeat /> : n}</span>
    </button>
  );
  return (
    <div className={SUBBAR}>
      <div role="radiogroup" aria-label={t('repos.tab.issues')} className="flex rounded-md bg-muted p-0.5">
        {item('open', 'repos.issues.open', summary.openIssues)}{item('closed', 'repos.issues.closed', summary.closedIssues)}
      </div>
      {isLoading && issues === undefined && <span>{t('project.loading')}</span>}
      {issues?.truncated && <span>{t('project.truncated', { n: issues.issues.length })}</span>}
    </div>
  );
}

// The table (handoff 02): a 34px header on card with a handle on each column's left edge, 40px rows, the dividers down to the footer, then
// the footer's X de N and the ↵ hint. Widths are saved per repository; the box fills the pane
interface IssueGridProps { repository: string; rows: RepoIssue[]; total: number; state: State; isSyncing: boolean; onOpen?(issue: RepoIssue): void }

function IssueGrid({ repository, rows, total, state, isSyncing, onOpen }: IssueGridProps) {
  const [saved, setSaved] = useState(() => readRepoListWidths(repository, 'issues'));
  const { widths, onDrag, onResize } = useColumnWidths(saved, (next) => {
    setSaved(next);
    writeRepoListWidths(repository, 'issues', next);
  });
  const columns = withWidths(COLUMNS, widths);
  const template = gridTemplate(columns);
  return (
    <div className="mx-3.5 mb-3.5 flex min-h-0 flex-1 flex-col overflow-hidden rounded-[10px] border">
      <ColumnScroll columns={columns} hasRows={rows.length > 0}>
        <table className="block w-full">
          <thead className="block">
            <tr className="relative grid h-[34px] items-center gap-3 border-b bg-card px-3 text-muted-foreground text-xs" style={{ gridTemplateColumns: template }}>
              <th className="min-w-0 truncate text-left font-normal">{t('repos.col.issue')}</th>
              {columns.map((c) => <th key={c.key} className="min-w-0 truncate text-left font-normal">{t(c.head)}</th>)}
              <HeaderHandles columns={columns} labelOf={(c) => t(c.head)} onDrag={onDrag} onResize={onResize} />
            </tr>
          </thead>
          <tbody className="block">
            {isSyncing ? ( // #182: never synced, so no rows yet; one row says so instead of an empty table
              <tr className="grid h-10 items-center px-3"><td><Syncing /></td></tr>
            ) : rows.map((issue) => (
              <RepoIssueRow key={issue.number} issue={issue} task={taskOfIssue(state.tasks, issue.url)} columns={template} state={state} onOpen={onOpen} />
            ))}
          </tbody>
        </table>
      </ColumnScroll>
      <div className="flex h-8 shrink-0 items-center justify-between border-t px-3 text-muted-foreground text-xs">
        <span>{t('project.footer.count', { x: rows.length, n: total })}</span>
        <span>{t('repos.footer.open')}</span>
      </div>
    </div>
  );
}

export interface RepoIssueTableProps { state: State; summary: RepoSummary; onTab(tab: RepoTab): void; onOpen?(issue: RepoIssue): void; onRepository?(repository: string): void }

/** A repository's issues (#757, handoff 02) under the repository header: open or closed, newest update first, searched on the page. Read
 * on opening, on a state change and on atualizar, which reads the sidebar's list again too; never polled. */
export function RepoIssueTable({ state, summary, onTab, onOpen, onRepository }: RepoIssueTableProps) {
  const [issueState, setIssueState] = useState<IssueState>('open');
  const { issues, isLoading, reload } = useRepoIssues(summary.repository, issueState);
  const [search, setSearch] = useState('');
  const isShown = useIsFlowShown();
  const term = search.trim().toLowerCase();
  const rows = (issues?.issues ?? []).filter((issue) => matches(issue, term));
  const refresh = async (): Promise<void> => {
    await Promise.all([reloadRepositories(), reload()]);
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <FlowHeader state={state} tasks={[]} search={search} onSearch={setSearch} isShown={isShown} repository={{ summary, tab: 'issues', onTab, onRepository }} onRefresh={refresh} github={`${summary.url}/issues`} />
      {summary.role === 'fork' && summary.issuesEnabled === false ? ( // #854: GitHub turns a fork's issues off by default
        <ForkEmpty text={t('repos.fork.noIssues', { fork: summary.repository })} original={summary.fork?.parent} onRepository={onRepository} />
      ) : (
        <>
          <Subbar summary={summary} value={issueState} onChange={setIssueState} issues={issues} isLoading={isLoading} />
          <IssueGrid repository={summary.repository} rows={rows} total={issues?.total ?? 0} state={state} isSyncing={issues?.syncedAt === null} onOpen={onOpen} />
        </>
      )}
    </div>
  );
}
