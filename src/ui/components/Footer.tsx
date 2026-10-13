import { ChevronDownIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { liveDefaultAgent } from '../../agents';
import type { DisabledRuleStatus, EffectiveLimits, State, UsageRule } from '../../types';
import { workerCount } from '../../worker-count';
import { AgentUsage } from '@/components/footer/AgentUsage';
import { PauseRulePopover } from '@/components/footer/PauseRulePopover';
import { PowerButtons } from '@/components/footer/PowerButtons';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';
import { firedRules, ruleKey, ruleLabel } from '@/lib/rule-effects';
import { signalEffect } from '@/lib/signal-effect';
import { timeLeft } from '@/lib/usage';

interface FooterProps { state: State; effective: EffectiveLimits; locale: string; onEditRules?(): void; console?: ReactNode } // console: its chip (redesign 05)

// The footer's chips and buttons share the 1px 8px chip box of the handoff (02), on the ui Button so focus and hover come with it.
const CHIP = 'h-auto gap-1.5 rounded-sm px-2 py-px text-xs font-normal text-foreground';

interface RuleChipProps { rule: UsageRule; paused: boolean; state: State; locale: string; onEditRules?(): void }

/** A rule's chip around its pausar regra popover; goes with the chips in the footer's last step (#224). */
function RuleChip({ rule, paused, state, locale, onEditRules }: RuleChipProps) {
  return (
    <PauseRulePopover rule={rule} paused={paused} state={state} locale={locale} onEditRules={onEditRules}>
      <Button type="button" variant="outline" className={`${CHIP} ${paused ? 'text-muted-foreground line-through' : ''}`}>
        {ruleLabel(rule, liveDefaultAgent(state))}
        <ChevronDownIcon className="size-3 text-muted-foreground" />
      </Button>
    </PauseRulePopover>
  );
}

// A paused rule: its struck-through chip, then `pausada · 52 min`, `~` when the end is an estimate (reset on hour / day); a pause until
// religar has no end to show.
function PausedRule({ status, ...chip }: Omit<RuleChipProps, 'rule' | 'paused'> & { status: DisabledRuleStatus }) {
  const left = status.backAt === undefined ? '' : ` · ${status.estimate ? '~' : ''}${timeLeft(status.backAt, Date.now())}`;
  return (
    <>
      <RuleChip rule={status.rule} paused {...chip} />
      <span>{t('footer.paused')}{left}</span>
    </>
  );
}

/** The window's footer (redesign 02, #223), the same under fluxo and atividades: the agents' plan usage and its panel, the effective signal and what it holds back, the workers, the
 * rules in force and the paused ones, each opening its pausar regra popover, then the console's chip (redesign 05) and the power buttons
 * (#226) at the right edge. */
export function Footer({ state, effective, locale, onEditRules, console: consoleChip }: FooterProps) {
  const fired = firedRules(effective);
  const chip = { state, locale, onEditRules };
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
      {fired.length + effective.disabledRules.length > 0 && (
        <>
          <span aria-hidden="true" className="h-3.5 w-px bg-border" />
          <span>{t('footer.rules')}</span>
          {fired.map((rule) => <RuleChip key={ruleKey(rule)} rule={rule} paused={false} {...chip} />)}
          {effective.disabledRules.map((status) => <PausedRule key={`off-${ruleKey(status.rule)}`} status={status} {...chip} />)}
        </>
      )}
      <span className="flex-1" />
      {consoleChip}
      <span aria-hidden="true" className="h-3.5 w-px bg-border" />
      <PowerButtons keepAwake={state.keepAwake === true} armed={state.shutdown !== undefined} />
    </footer>
  );
}
