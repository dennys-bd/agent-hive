import type { PlanReadings } from '../../../types';
import type { Benchmark } from '@/components/benchmark/benchmark-dock';
import { ExperimentHeader } from '@/components/benchmark/ExperimentHeader';
import { TABS } from '@/components/benchmark/tabs';
import { HeaderSlot } from '@/components/HeaderSlot';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { WorkspaceSquare } from '@/components/WorkspaceSquare';
import { t } from '@/i18n';

// experimento vazio, as the sidebar's item: straight into the only workspace, a menu of them when there are several
function EmptyExperiment({ benchmark, workspaces }: { benchmark: Benchmark; workspaces: readonly string[] }) {
  const [only, ...others] = workspaces;
  if (only === undefined) return <Button type="button" variant="outline" size="sm" disabled>{t('benchmark.sidebar.empty')}</Button>;
  if (others.length === 0) return <Button type="button" variant="outline" size="sm" onClick={() => void benchmark.createEmpty(only)}>{t('benchmark.sidebar.empty')}</Button>;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button type="button" variant="outline" size="sm">{t('benchmark.sidebar.empty')}</Button></DropdownMenuTrigger>
      <DropdownMenuContent>
        {workspaces.map((name) => <DropdownMenuItem key={name} onSelect={() => void benchmark.createEmpty(name)}><WorkspaceSquare name={name} />{name}</DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The benchmark view's centre (#461): the tab bar and the selected tab's body, the experiment's head portalled into the header; or, with no
 * live experiment and no archived one picked, the empty state with no head and no tabs. Mounted only while the view is shown, so the slot holds no other view's head. */
export function BenchmarkView({ benchmark, workspaces, rateLimits }: { benchmark: Benchmark; workspaces: readonly string[]; rateLimits?: PlanReadings }) {
  const { selected } = benchmark;
  if (selected === undefined) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-3 text-muted-foreground text-sm">
        <p>{t('benchmark.header.empty')}</p>
        <EmptyExperiment benchmark={benchmark} workspaces={workspaces} />
      </div>
    );
  }
  const tab = TABS.find((entry) => entry.id === benchmark.tab) ?? TABS[0];
  return (
    <div data-benchmark-tab={tab.id} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <HeaderSlot><ExperimentHeader benchmark={benchmark} experiment={selected} primary={tab.primary?.(selected)} /></HeaderSlot>
      <nav aria-label={t('benchmark.header.tabs')} className="flex h-9 shrink-0 items-end gap-4 border-b px-4">
        {TABS.map((entry) => (
          <button
            key={entry.id} type="button" aria-current={entry.id === tab.id ? 'page' : undefined} onClick={() => benchmark.setTab(entry.id)}
            className={`pb-2 text-[13px] ${entry.id === tab.id ? 'text-foreground shadow-[inset_0_-2px_0_var(--foreground)]' : 'text-muted-foreground hover:text-foreground'}`}
          >
            {t(entry.label)}
          </button>
        ))}
      </nav>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        {tab.render?.(selected, benchmark, { select: benchmark.select, ...(rateLimits === undefined ? {} : { rateLimits }) }) ?? <p className="p-6 text-muted-foreground text-sm">{t('benchmark.header.soon')}</p>}
      </div>
    </div>
  );
}
