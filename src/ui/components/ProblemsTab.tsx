import type { ReactNode } from 'react';
import { ProblemCounts, totalCounts } from '@/components/footer/ProblemsButton';
import { ProblemsList } from '@/components/ProblemsList';
import { Button } from '@/components/ui/button';
import { useDiagnostics } from '@/hooks/use-diagnostics';
import { t } from '@/i18n';
import { type CheckStatus, checkStatuses, problems } from '@/lib/diagnostics-store';
import type { FileAt } from '@/lib/editor-models';

export interface ProblemsTabProps {
  activityId?: string; tabs: ReactNode; collapsed: ReadonlySet<string>; onCollapsed(collapsed: ReadonlySet<string>): void; onClose(): void; onOpen(path: string, at: FileAt): void;
}

const ACTION = 'h-auto px-1.5 py-0.5 text-xs font-normal text-muted-foreground';
const pad = (n: number): string => String(n).padStart(2, '0');
const clock = (at: number): string => { const d = new Date(at); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

// The running or failed command-line checkers; over every activity a checker shows once
function liveChecks(activityId?: string): CheckStatus[] {
  const live = checkStatuses(activityId).filter((s) => s.phase === 'running' || s.phase === 'failed');
  return live.filter((s, i) => live.findIndex((other) => other.checker === s.checker) === i);
}

// handoff §4: running with its results' time, or failed with its reason in the title; no ver log
function CheckLine({ status }: { status: CheckStatus }) {
  const { checker, phase, at, reason } = status;
  if (phase === 'running') return <span className="shrink-0">{at === undefined ? t('problems.runningFirst', { checker }) : t('problems.running', { checker, time: clock(at) })}</span>;
  return <span title={reason} className="shrink-0 text-destructive">{t('problems.failed', { checker })}</span>;
}

/** The drawer's problems tab (#225, handoff §4): the segmented tabs, the totals, the running or failed checkers, recolher todos and esc,
 * then today's list. */
export function ProblemsTab({ activityId, tabs, collapsed, onCollapsed, onClose, onOpen }: ProblemsTabProps) {
  useDiagnostics();
  const toggle = (path: string): void => onCollapsed(collapsed.has(path) ? new Set([...collapsed].filter((p) => p !== path)) : new Set([...collapsed, path]));
  return (
    <section aria-label={t('problems.title')} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-[34px] shrink-0 items-center gap-2.5 border-b px-3 text-muted-foreground text-xs">
        {tabs}
        <ProblemCounts counts={totalCounts(activityId)} />
        <span className="flex-1" />
        {liveChecks(activityId).map((s) => <CheckLine key={s.checker} status={s} />)}
        <Button type="button" variant="ghost" size="xs" className={ACTION} onClick={() => onCollapsed(new Set(problems(activityId).map((g) => g.path)))}>{t('problems.collapseAll')}</Button>
        <Button type="button" variant="ghost" size="xs" className={ACTION} aria-label={t('console.close')} onClick={onClose}>esc</Button>
      </div>
      <ProblemsList activityId={activityId} collapsed={collapsed} onToggle={toggle} onOpen={onOpen} />
    </section>
  );
}
