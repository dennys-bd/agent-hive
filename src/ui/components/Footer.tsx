import type { ReactNode } from 'react';
import type { EffectiveLimits, State } from '../../types';
import { workerCount } from '../../worker-count';
import { AgentUsage } from '@/components/footer/AgentUsage';
import { PowerButtons } from '@/components/footer/PowerButtons';
import { RulesButton } from '@/components/footer/RulesButton';
import { t } from '@/i18n';
import { signalEffect } from '@/lib/signal-effect';

// checkers, problems (#225): the shown activity's checkers and the problems button; console: its chip (redesign 05)
interface FooterProps { state: State; effective: EffectiveLimits; locale: string; onEditRules?(): void; checkers?: ReactNode; problems?: ReactNode; console?: ReactNode }

/** The window's footer (redesign 02, #223), the same under fluxo and atividades: the agents' plan usage and its panel, the effective signal and what it holds back, the workers, the
 * rules button (#224) opening the rules panel, then the checkers and the problems of the activity on screen (#225), the console's chip
 * (redesign 05) and the power buttons (#226) at the right edge.
 * `form="full"` stays fixed until 2.5 picks the form from the width. */
export function Footer({ state, effective, locale, onEditRules, checkers, problems, console: consoleChip }: FooterProps) {
  const effect = signalEffect(effective.signal, state.signals);
  return (
    <footer className="relative flex h-[30px] shrink-0 items-center gap-3 border-t px-3 text-xs text-muted-foreground">
      <AgentUsage state={state} form="full" />{/* #223: 2.5 picks the form from the width */}
      <span aria-hidden="true" className="h-3.5 w-px bg-border" />
      <span className="flex items-center gap-1.5">
        <span role="status" data-signal={effective.signal} className="signal-pill rounded-sm px-2 py-px font-medium">{effective.signal}</span>
        {effect}
      </span>
      <span>{t('footer.workers', { active: workerCount(state.workers), max: effective.maxWorkers ?? state.maxConcurrent })}</span>
      <span aria-hidden="true" className="h-3.5 w-px bg-border" />
      <RulesButton state={state} effective={effective} locale={locale} form="full" onEditRules={onEditRules} />
      <span className="flex-1" />
      {checkers}
      {problems}
      {problems !== undefined && <span aria-hidden="true" className="h-3.5 w-px bg-border" />}
      {consoleChip}
      <span aria-hidden="true" className="h-3.5 w-px bg-border" />
      <PowerButtons keepAwake={state.keepAwake === true} armed={state.shutdown !== undefined} />
    </footer>
  );
}
