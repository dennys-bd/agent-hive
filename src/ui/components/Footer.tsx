import { type ReactNode, useRef } from 'react';
import type { AgentId, EffectiveLimits, State } from '../../types';
import { AgentUsage, PLAN_AGENTS } from '@/components/footer/AgentUsage';
import { PowerButtons } from '@/components/footer/PowerButtons';
import { RulesButton } from '@/components/footer/RulesButton';
import { useFooterStep } from '@/lib/footer-steps';
import { effectsInForce, rulesLabel } from '@/lib/rule-effects';

// checkers, problems (#225): the shown activity's checkers and the problems button; console: its chip (redesign 05); agents: the tests' seam (#227)
interface FooterProps {
  state: State; effective: EffectiveLimits; locale: string; onEditRules?(): void; checkers?: ReactNode; problems?: ReactNode; console?: ReactNode; agents?: readonly AgentId[];
}

/** The window's footer (redesign 02, #223), the same under fluxo and atividades: the agents' plan usage and its panel, the rules button (#224)
 * opening the rules panel, then the checkers and the problems of the activity on screen (#225), the console's chip (redesign 05) and the
 * power buttons (#226) at the right edge. The usage and the rules take the first step of handoff §6 whose content fits (#227). */
export function Footer({ state, effective, locale, onEditRules, checkers, problems, console: consoleChip, agents = PLAN_AGENTS }: FooterProps) {
  const row = useRef<HTMLDivElement>(null);
  // What the content's width hangs on besides the window. Content that grows overflows and steps down by itself; an agent or a rule that
  // goes away frees room no resize reports, so a new key starts the descent over
  const step = useFooterStep(row, `${agents.length}|${rulesLabel(effectsInForce(effective), 'full').text}`);
  return (
    <footer data-usage={step.usage} data-rules={step.rules} className="relative flex h-[30px] shrink-0 items-center border-t px-3 text-xs text-muted-foreground">
      {/* The row clips, not the footer: the usage panel hangs above the footer (absolute, bottom-full) and an overflow-hidden footer would cut it */}
      <div ref={row} className="flex h-full min-w-0 flex-1 items-center gap-3 overflow-hidden *:shrink-0 *:whitespace-nowrap">
        <AgentUsage state={state} form={step.usage} agents={agents} />
        <span aria-hidden="true" className="h-3.5 w-px bg-border" />
        <RulesButton state={state} effective={effective} locale={locale} form={step.rules} onEditRules={onEditRules} />
        <span className="flex-1" />
        {checkers}
        {problems}
        {problems !== undefined && <span aria-hidden="true" className="h-3.5 w-px bg-border" />}
        {consoleChip}
        <span aria-hidden="true" className="h-3.5 w-px bg-border" />
        <PowerButtons keepAwake={state.keepAwake === true} armed={state.shutdown !== undefined} />
      </div>
    </footer>
  );
}
