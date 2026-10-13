import { ChevronDownIcon, ChevronRightIcon, CircleXIcon, InfoIcon, TriangleAlertIcon } from 'lucide-react';
import { toneOf, useDiagnostics } from '@/hooks/use-diagnostics';
import { t } from '@/i18n';
import { answeredSources, type Problem, type ProblemGroup, problems } from '@/lib/diagnostics-store';
import type { FileAt } from '@/lib/editor-models';
import { listOf } from '@/lib/settings-languages';

/** The drawer hands the groups' collapsed state (#225), so its recolher todos reaches them; onOpen: a problem's file at its line and column. */
export interface ProblemsListProps { activityId?: string; collapsed: ReadonlySet<string>; onToggle(path: string): void; onOpen(path: string, at: FileAt): void }
type OnOpen = ProblemsListProps['onOpen'];

const SEVERITY = { error: { Icon: CircleXIcon, tone: 'text-destructive' }, warning: { Icon: TriangleAlertIcon, tone: 'text-waiting' }, info: { Icon: InfoIcon, tone: 'text-review' } } as const;

function Line({ problem, onOpen }: { problem: Problem; onOpen: OnOpen }) {
  const { Icon, tone } = SEVERITY[problem.severity];
  return (
    <li>
      <button type="button" onClick={() => onOpen(problem.path, { line: problem.line, col: problem.column })} className={`flex w-full items-center gap-2 py-0.5 pr-3 pl-7 text-left text-xs hover:bg-accent ${problem.isStale ? 'opacity-50' : ''}`}>
        <Icon aria-hidden className={`size-3.5 shrink-0 ${tone}`} />
        <span className="min-w-0 flex-1 truncate">{problem.message}</span>
        <span className="shrink-0 text-muted-foreground">{[problem.source, problem.code].filter((part) => part !== undefined).join(' ')}</span>
        <span className="shrink-0 font-mono text-muted-foreground">{problem.line}:{problem.column}</span>
      </button>
    </li>
  );
}

function Group({ group, isCollapsed, onToggle, onOpen }: { group: ProblemGroup; isCollapsed: boolean; onToggle(): void; onOpen: OnOpen }) {
  const slash = group.path.lastIndexOf('/');
  const Chevron = isCollapsed ? ChevronRightIcon : ChevronDownIcon;
  return (
    <li>
      <button type="button" aria-expanded={!isCollapsed} title={group.path} onClick={onToggle} className="flex w-full items-center gap-1.5 px-2 py-0.5 text-left text-xs hover:bg-accent">
        <Chevron aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className={toneOf(group.counts) ?? ''}>{group.path.slice(slash + 1)}</span>
        {slash > 0 && <span className="min-w-0 truncate font-mono text-muted-foreground">{group.path.slice(0, slash)}</span>}
        <span className="ml-auto shrink-0 rounded-full bg-secondary px-1.5 text-secondary-foreground">{group.problems.length}</span>
      </button>
      {/* biome-ignore lint/suspicious/noArrayIndexKey: two checkers can report the same line, column and message; the list is rebuilt whole, never reordered in place */}
      {!isCollapsed && <ul>{group.problems.map((p, i) => <Line key={`${p.source}:${p.line}:${p.column}:${p.message}:${i}`} problem={p} onOpen={onOpen} />)}</ul>}
    </li>
  );
}

function Empty({ activityId }: { activityId?: string }) {
  const sources = answeredSources(activityId);
  return (
    <div className="flex flex-col items-center gap-1 p-4 text-xs">
      <span>{t(activityId === undefined ? 'problems.emptyAll' : 'problems.empty')}</span>
      {sources.length > 0 && <span className="text-muted-foreground">{t('problems.emptySources', { sources: listOf(sources, t('settings.formatters.and')) })}</span>}
    </div>
  );
}

/** The problems list (#782), the body of the drawer's problems tab (#225): the activity's problems, or every activity's, from their language
 * servers and checkers, grouped by file, errors first; a click opens the file at the problem. */
export function ProblemsList({ activityId, collapsed, onToggle, onOpen }: ProblemsListProps) {
  useDiagnostics();
  const groups = problems(activityId);
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {groups.length === 0
        ? <Empty activityId={activityId} />
        : <ul>{groups.map((g) => <Group key={g.path} group={g} isCollapsed={collapsed.has(g.path)} onToggle={() => onToggle(g.path)} onOpen={onOpen} />)}</ul>}
    </div>
  );
}
