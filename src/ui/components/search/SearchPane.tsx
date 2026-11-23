import { GitBranchIcon, LoaderCircleIcon } from 'lucide-react';
import { useRef, useState } from 'react';
import { useOpenFile } from '@/components/terminal-tabs';
import { formatCount, t, tPlural } from '@/i18n';
import { type Activity, activityKey } from '@/lib/activities';
import type { FileAt } from '@/lib/editor-models';
import { SEARCH_PANE_ATTR, type SearchKey, useSearchPaneKeys } from '@/lib/search-keys';
import { setSearchPane, type SearchPaneState, useSearchPane } from '@/lib/search-query';
import { type SearchView, useSearch } from '@/lib/search-stream';
import { SEARCH_CAP } from '../../../types';
import { CapNote, EmptyNote, NoResultsNote, NoWorktreeNote } from './SearchNotes';
import { ReplaceConfirm } from './ReplaceConfirm';
import { useReplace } from './use-replace';
import { SearchForm } from './SearchForm';
import { SearchResults } from './SearchResults';

const resultsText = (n: number): string => tPlural('search.results', n, { n: formatCount(n) });

// The summary line: what a settled or running search holds, or nothing while there is no query or the query is broken
function summaryOf(view: SearchView): string | undefined {
  if (view.kind === 'running') return t('search.busy', { results: resultsText(view.total) });
  if (view.kind !== 'done') return undefined;
  if (view.end.total === 0) return t('search.noResults');
  if (view.end.capped) return t('search.many', { n: formatCount(SEARCH_CAP) });
  return t('search.summary', { results: resultsText(view.end.total), files: tPlural('search.files', view.end.files, { n: formatCount(view.end.files) }) });
}

function Scope({ target, repos }: { target: Activity; repos: string[] }) {
  const { branch, workspace } = target.activity;
  return (
    <div title={t('search.scope')} className="flex items-center gap-1.5 whitespace-nowrap px-3 pt-2.5 pb-2 text-muted-foreground text-xs">
      <GitBranchIcon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate font-mono">{branch ?? workspace}</span>
      {repos.length > 0 && <span>{`+ ${repos.join(', ')}`}</span>}
    </div>
  );
}

const reposOf = (view: SearchView): string[] => (view.kind === 'unavailable' ? [] : view.kind === 'done' ? view.end.repos : view.repos);

// The toggles' keys flip the query's own flags
const FLAG: Record<'matchCase' | 'wholeWord' | 'regex', 'isCaseSensitive' | 'isWholeWord' | 'isRegex'> = { matchCase: 'isCaseSensitive', wholeWord: 'isWholeWord', regex: 'isRegex' };

function runKey(key: SearchKey, pane: SearchPaneState, canReplaceAll: boolean, onReplaceAll: (() => void) | undefined): void {
  if (key === 'replaceAll') {
    if (canReplaceAll) onReplaceAll?.();
    return;
  }
  setSearchPane({ query: { ...pane.query, [FLAG[key]]: !pane.query[FLAG[key]] } });
}

/** The busca tab of the activity sidebar (#868, ⌘⇧F): the contents of the activity's worktree and its nested repositories, streamed in and
 * grouped by file; a match row opens the file at its line. */
export function SearchPane({ target, isShown, onReplaceAll }: { target: Activity; isShown: boolean; onReplaceAll?: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const pane = useSearchPane();
  const openFile = useOpenFile();
  const [runId, setRunId] = useState(0);
  const { view: found, isCurrent } = useSearch(target.activity.id, pane.query, runId);
  // the first read of an empty query is the scope question: it is idle, not "searching"
  const view: SearchView = pane.query.q === '' && found.kind === 'running' ? { kind: 'idle', repos: [] } : found;
  const onOpen = (path: string, at: FileAt): void => { openFile?.(activityKey(target), path, at); };
  const summary = summaryOf(view);
  // replace-all needs a settled search of the query on screen, with something to replace and the replace field open
  const canReplaceAll = pane.isReplaceOpen && isCurrent && view.kind === 'done' && view.end.total > 0;
  // a view of an older query stays on screen, but nothing in it can be replaced
  const results = isCurrent && (view.kind === 'running' || view.kind === 'done') ? view.files : [];
  const replace = useReplace({ activityId: target.activity.id, query: pane.query, replacement: pane.replacement, files: results, rerun: () => setRunId((n) => n + 1) });
  const askReplaceAll = (): void => { replace.setConfirmOpen(true); onReplaceAll?.(); };
  useSearchPaneKeys(root, (key) => runKey(key, pane, canReplaceAll, askReplaceAll));
  return (
    <div ref={root} {...{ [SEARCH_PANE_ATTR]: '' }} hidden={!isShown} className="flex min-h-0 flex-1 flex-col">
      {view.kind === 'unavailable' ? <NoWorktreeNote /> : (
        <>
          <Scope target={target} repos={reposOf(view)} />
          <SearchForm pane={pane} error={view.kind === 'error' ? view.message : undefined} canReplaceAll={canReplaceAll} onReplaceAll={askReplaceAll} />
          {summary !== undefined && (
            <div role="status" className="flex min-h-[30px] items-center gap-1.5 px-3 py-1.5 text-muted-foreground text-xs">
              {view.kind === 'running' && <LoaderCircleIcon aria-hidden="true" className="size-3.5 shrink-0 motion-safe:animate-spin" />}
              <span className="min-w-0 flex-1">{summary}</span>
            </div>
          )}
          {view.kind === 'done' && view.end.capped && <CapNote text={t('search.capNote', { n: formatCount(SEARCH_CAP) })} />}
          {(view.kind === 'running' || view.kind === 'done') && view.files.length > 0 && <SearchResults files={view.files} onOpen={onOpen} dirty={replace.dirty} {...(pane.isReplaceOpen && isCurrent ? { replacement: pane.replacement, onReplaceFile: replace.replaceFile } : {})} />}
          {view.kind === 'idle' && <EmptyNote repos={view.repos} />}
          {view.kind === 'done' && view.end.total === 0 && <NoResultsNote text={t('search.noneNote', { n: formatCount(view.end.searched ?? 0) })} />}
          <ReplaceConfirm
            open={replace.isConfirmOpen} onOpenChange={replace.setConfirmOpen} {...replace.plan} query={pane.query.q} replacement={pane.replacement}
            scope={`${target.activity.branch ?? target.activity.workspace}${reposOf(view).length > 0 ? ` + ${reposOf(view).join(', ')}` : ''}`} onConfirm={replace.replaceAll}
          />
        </>
      )}
    </div>
  );
}
