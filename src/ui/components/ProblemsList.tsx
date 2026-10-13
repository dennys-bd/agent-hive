import { ChevronDownIcon, ChevronRightIcon, CircleXIcon, InfoIcon, TriangleAlertIcon, XIcon } from 'lucide-react';
import { type KeyboardEvent, type MouseEvent as ReactMouseEvent, useEffect, useRef, useState } from 'react';
import { ProblemCounts } from '@/components/footer/ProblemsButton';
import { Button } from '@/components/ui/button';
import { toneOf, useDiagnostics } from '@/hooks/use-diagnostics';
import { t } from '@/i18n';
import { answeredSources, checkStatuses, type CheckStatus, type Problem, type ProblemGroup, problems } from '@/lib/diagnostics-store';
import type { FileAt } from '@/lib/editor-models';
import { addCounts, ZERO } from '@/lib/problems';
import { listOf } from '@/lib/settings-languages';
import type { FormatLog } from '../../types';

/** onOpen: a problem's file at its line and column, through the pane's opener (#782). */
export interface ProblemsListProps { activityId: string; onOpen(path: string, at: FileAt): void; onClose(): void; onViewLog?(log: FormatLog): void }
type OnOpen = ProblemsListProps['onOpen'];

const LIST_HEIGHT = 180; // px (the handoff's): every pane opens the list at it; never persisted
const MIN_HEIGHT = 80;
const KEY_STEP = 16;
const SEVERITY = { error: { Icon: CircleXIcon, tone: 'text-destructive' }, warning: { Icon: TriangleAlertIcon, tone: 'text-waiting' }, info: { Icon: InfoIcon, tone: 'text-review' } } as const;
const pad = (n: number): string => String(n).padStart(2, '0');
const clock = (at: number): string => { const d = new Date(at); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

// The list's top edge (#782): dragged, or ↑ and ↓ once focused, to change its height; never under MIN_HEIGHT
function Resizer({ height, onHeight }: { height: number; onHeight(height: number): void }) {
  const clamp = (h: number): number => Math.max(MIN_HEIGHT, Math.round(h));
  const stopDrag = useRef<() => void>(() => undefined);
  useEffect(() => () => stopDrag.current(), []); // the list closing mid-drag must not leave its listeners on the window
  const startDrag = (e: ReactMouseEvent): void => {
    const [startY, start] = [e.clientY, height];
    const move = (m: MouseEvent): void => onHeight(clamp(start + startY - m.clientY));
    const up = (): void => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    stopDrag.current();
    stopDrag.current = up;
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  const key = (e: KeyboardEvent): void => {
    if (e.key === 'ArrowUp') onHeight(clamp(height + KEY_STEP));
    if (e.key === 'ArrowDown') onHeight(clamp(height - KEY_STEP));
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable separator is the WAI-ARIA splitter pattern: arrows resize it, as the console drawer's (#251)
    <div
      role="separator" aria-orientation="horizontal" aria-label={t('problems.resize')} aria-valuenow={height} tabIndex={0}
      onMouseDown={startDrag} onKeyDown={key} className="h-1 shrink-0 cursor-row-resize hover:bg-border focus-visible:bg-border focus-visible:outline-none"
    />
  );
}

// A command-line checker running again (its results' time) or failed (with ver log), above the groups
function StatusLine({ status, onViewLog }: { status: CheckStatus; onViewLog?(log: FormatLog): void }) {
  const { checker, phase, at, reason, log } = status;
  if (phase === 'running') return <p className="px-3 py-1 text-muted-foreground text-xs">{at === undefined ? t('problems.runningFirst', { checker }) : t('problems.running', { checker, time: clock(at) })}</p>;
  return (
    <p className="flex items-center gap-2 px-3 py-1 text-xs">
      <span title={reason} className="text-destructive">{t('problems.failed', { checker })}</span>
      {onViewLog && log && <Button type="button" variant="link" size="xs" className="h-auto p-0 text-review" onClick={() => onViewLog(log)}>{t('editor.viewLog')}</Button>}
    </p>
  );
}

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

function Empty({ activityId }: { activityId: string }) {
  const sources = answeredSources(activityId);
  return (
    <div className="flex flex-col items-center gap-1 p-4 text-xs">
      <span>{t('problems.empty')}</span>
      {sources.length > 0 && <span className="text-muted-foreground">{t('problems.emptySources', { sources: listOf(sources, t('settings.formatters.and')) })}</span>}
    </div>
  );
}

/** The problems list (#782), inside the editor pane under the code: the whole activity's problems from its language servers and checkers,
 * grouped by file, errors first; a click opens the file at the problem. Its height and its groups' state live and die with the pane. */
export function ProblemsList({ activityId, onOpen, onClose, onViewLog }: ProblemsListProps) {
  useDiagnostics();
  const [height, setHeight] = useState(LIST_HEIGHT);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const groups = problems(activityId);
  const toggle = (path: string): void => setCollapsed((was) => (was.has(path) ? new Set([...was].filter((p) => p !== path)) : new Set([...was, path])));
  return (
    <section aria-label={t('problems.title')} style={{ height }} className="flex shrink-0 flex-col border-t">
      <Resizer height={height} onHeight={setHeight} />
      <header className="flex h-7 shrink-0 items-center gap-2 border-b px-3 text-xs">
        <span className="font-semibold">{t('problems.title')}</span>
        <ProblemCounts counts={groups.reduce((sum, g) => addCounts(sum, g.counts), ZERO)} />
        <Button type="button" variant="ghost" size="xs" className="ml-auto" onClick={() => setCollapsed(new Set(groups.map((g) => g.path)))}>{t('problems.collapseAll')}</Button>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={t('problems.close')} title={t('problems.close')} onClick={onClose}><XIcon /></Button>
      </header>
      {checkStatuses(activityId).filter((s) => s.phase === 'running' || s.phase === 'failed').map((s) => <StatusLine key={s.checker} status={s} onViewLog={onViewLog} />)}
      <div className="min-h-0 flex-1 overflow-auto">
        {groups.length === 0 ? <Empty activityId={activityId} /> : <ul>{groups.map((g) => <Group key={g.path} group={g} isCollapsed={collapsed.has(g.path)} onToggle={() => toggle(g.path)} onOpen={onOpen} />)}</ul>}
      </div>
    </section>
  );
}
