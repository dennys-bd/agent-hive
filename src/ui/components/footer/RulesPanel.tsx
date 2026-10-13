import { XIcon } from 'lucide-react';
import type { EffectiveLimits, RuleSignal, State, UsageRule } from '../../../types';
import { PauseRulePopover } from '@/components/footer/PauseRulePopover';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';
import { ruleEffectText, ruleKey, type RuleRow, type RulesBlock, rulesBlocks, ruleStateText } from '@/lib/rule-effects';
import { PERCENT_MAX } from '@/lib/usage';

interface RulesPanelProps { state: State; effective: EffectiveLimits; locale: string; onEditRules?(): void; onClose(): void }
interface RowContext { state: State; locale: string; now: number; onEditRules?(): void }

// The signal dot is the panel's one coloured mark (design system: colour for status and the signal); bars, ticks and states stay neutral.
const SIGNAL_DOT: Record<RuleSignal, string> = { yellow: 'bg-signal-yellow', red: 'bg-signal-red' };
const clamp = (percent: number): number => Math.min(Math.max(percent, 0), PERCENT_MAX);
// ruleKey ignores the effect, so two rules on one floor with different caps would share it: the row key adds the effect.
const rowKey = (rule: UsageRule): string => `${ruleKey(rule)}-${rule.maxWorkers ?? ''}-${rule.signal ?? ''}`;

// One measure's bar (handoff §3.3): muted fill to now, a 2×12px marker at now, a 1×8px tick per rule percent, foreground once it has fired.
function RulesBar({ current, percents }: { current?: number; percents: number[] }) {
  const hasFired = (p: number): boolean => current !== undefined && current >= p;
  return (
    <div className="relative h-3" aria-hidden>
      <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-full bg-muted">
        {current !== undefined && <div className="absolute inset-y-0 left-0 bg-muted-foreground/40" style={{ width: `${clamp(current)}%` }} />}
      </div>
      {percents.map((p) => (
        <span key={p} data-testid="rules-tick" data-fired={String(hasFired(p))} className={`absolute top-0.5 h-2 w-px ${hasFired(p) ? 'bg-foreground' : 'bg-empty'}`} style={{ left: `${clamp(p)}%` }} />
      ))}
      {current !== undefined && <span data-testid="rules-now" className="absolute top-0 h-3 w-0.5 -translate-x-1/2 bg-foreground" style={{ left: `${clamp(current)}%` }} />}
    </div>
  );
}

// A rule's row: `40% → limitar workers a 4`, its state on the right; the row is the pause popover's trigger, as the chip was.
function RuleLine({ row, ctx }: { row: RuleRow; ctx: RowContext }) {
  const { rule, state: ruleState } = row;
  const paused = ruleState.kind === 'paused';
  return (
    <li>
      <PauseRulePopover rule={rule} paused={paused} state={ctx.state} locale={ctx.locale} onEditRules={ctx.onEditRules}>
        <Button type="button" variant="ghost" className="h-auto w-full justify-between gap-3 rounded-sm px-2 py-1 text-xs font-normal">
          <span className={`flex items-center gap-1.5 ${paused ? 'text-muted-foreground line-through' : ''}`}>
            {rule.signal && <span data-signal={rule.signal} aria-hidden className={`size-1.5 shrink-0 rounded-full ${SIGNAL_DOT[rule.signal]}`} />}
            {`${rule.percent}% → ${ruleEffectText(rule)}`}
          </span>{' '}
          <span className={ruleState.kind === 'binding' ? 'text-foreground' : 'text-muted-foreground'}>{ruleStateText(ruleState, ctx.now)}</span>
        </Button>
      </PauseRulePopover>
    </li>
  );
}

// fieldset carries role="group" natively, labelled by the measure, as SignalRuler does (#512).
function MeasureBlock({ block, ctx }: { block: RulesBlock; ctx: RowContext }) {
  return (
    <fieldset aria-label={block.label} className="m-0 flex flex-col gap-1.5 border-0 border-b px-3 py-2.5 last:border-b-0">
      <div className="flex items-baseline justify-between text-xs">
        <span className="font-medium">{block.label}</span>
        <span className="text-muted-foreground">{block.current === undefined ? t('settings.rules.none') : t('settings.rules.nowPercent', { percent: block.current })}</span>
      </div>
      <RulesBar current={block.current} percents={[...new Set(block.rows.map((row) => row.rule.percent))]} />
      <ul>{block.rows.map((row) => <RuleLine key={rowKey(row.rule)} row={row} ctx={ctx} />)}</ul>
    </fieldset>
  );
}

/** The rules panel's content (#224, handoff §3.3): the header, one block per measure a rule uses, and the footnote. */
export function RulesPanel({ state, effective, locale, onEditRules, onClose }: RulesPanelProps) {
  const now = Date.now();
  const { blocks, total, fired } = rulesBlocks(state, effective, now);
  const ctx: RowContext = { state, locale, now, onEditRules };
  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2 text-xs">
        <span className="font-medium">{t('rules.panel.title')}</span>
        <span className="text-muted-foreground">{t('rules.panel.count', { n: total, fired })}</span>
        <span className="flex-1" />
        {onEditRules && <Button type="button" variant="ghost" size="xs" onClick={onEditRules}>{t('rules.panel.edit')}</Button>}
        <Button type="button" variant="ghost" size="icon-xs" aria-label={t('rules.panel.close')} onClick={onClose}><XIcon /></Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {blocks.map((block) => <MeasureBlock key={block.key} block={block} ctx={ctx} />)}
      </div>
      <p className="shrink-0 border-t px-3 py-2 text-xs text-muted-foreground">{t('rules.panel.note')}</p>
    </>
  );
}
