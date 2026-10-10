import type { EffectiveLimits, State } from '../../types';
import { FlowRepositories } from '@/components/FlowRepositories';
import { FlowSources, type SourcesNav } from '@/components/FlowSources';
import { SignalToggle } from '@/components/SignalToggle';
import { WorkerCap } from '@/components/WorkerCap';
import { t } from '@/i18n';

interface AutomationPanelProps {
  state: State; effective?: EffectiveLimits; sources: SourcesNav; source?: string; onSource(name?: string): void;
  repository?: string; onRepository?(name: string): void; // #757: the repositories section, one pick with the sources'; absent: no section
}

/** The flow sidebar (redesign 09), the Automação dock tab (#456): the manual signal, the worker cap, the sources, whose pick filters the
 * flow, and the repositories (#757). Workspaces are not here: they belong to atividades. A region named like its tab; the picks are the Dashboard's. */
export function AutomationPanel({ state, effective, sources, source, onSource, repository, onRepository }: AutomationPanelProps) {
  return (
    <section aria-label={t('dock.automation')} className="flex min-h-0 flex-1 flex-col gap-[18px] p-3">
      <SignalToggle signal={state.signal} signals={state.signals} effective={effective} />
      <WorkerCap state={state} effective={effective} />
      <hr />
      {/* a picked repository leaves no source row pressed, todas included (#757) */}
      <FlowSources nav={sources} tasks={state.tasks} selected={repository === undefined ? source : null} onPick={onSource} />
      {onRepository && <FlowRepositories selected={repository} onPick={onRepository} />}
    </section>
  );
}
