import { t } from '@/i18n';
import { agentName } from '../../../agents';
import { ruleSteps, signalZones, type Zone } from '@/lib/signal-rules';
import { MEASURE_LABEL, type RuleDraft } from '@/lib/settings-rules';
import { PERCENT_MAX } from '@/lib/usage';
import type { AgentId, RuleSource } from '../../../types';

interface SignalRulerProps { source: RuleSource; agent?: AgentId; rows: readonly RuleDraft[]; current?: number } // agent: #929, a non-default agent's ruler; rows: this ruler's

// Colour only for the yellow and red zones (#526): green is the empty track, the fill and marker are foreground, the ticks muted.
const ZONE_FILL: Partial<Record<Zone['signal'], string>> = { yellow: 'bg-signal-yellow/55', red: 'bg-signal-red/60' };
const clamp = (percent: number): number => Math.min(Math.max(percent, 0), PERCENT_MAX);

// One measure's 0–100% ruler (#526): its name and now on the left; on the right the yellow/red zones, the fill up to now and one tick per rule percent.
export function SignalRuler({ source, agent, rows, current }: SignalRulerProps) {
  const label = agent === undefined ? t(MEASURE_LABEL[source]) : `${t(MEASURE_LABEL[source])} · ${agentName(agent)}`;
  return (
    // fieldset carries role="group" natively (Biome's useSemanticElements over a plain div, as ShortcutsTab already does, #512)
    <fieldset aria-label={label} className="m-0 grid grid-cols-[170px_minmax(0,1fr)] items-start gap-4 border-0 p-0">
      <div className="flex flex-col gap-0.5 text-xs">
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground">{current === undefined ? t('settings.rules.none') : t('settings.rules.nowPercent', { percent: current })}</span>
      </div>
      <div className="relative h-10">
        <div className="absolute inset-x-0 top-[5px] h-2 overflow-hidden rounded-full bg-muted">
          {signalZones(rows).filter((z) => ZONE_FILL[z.signal]).map((z) => (
            <div key={z.signal} data-signal={z.signal} className={`absolute inset-y-0 ${ZONE_FILL[z.signal]}`} style={{ left: `${z.from}%`, width: `${z.to - z.from}%` }} />
          ))}
          {current !== undefined && <div data-testid="rules-fill" className="absolute inset-y-0 left-0 bg-foreground/35" style={{ width: `${clamp(current)}%` }} />}
        </div>
        {current !== undefined && <div data-testid="rules-now" className="absolute top-0 h-[18px] w-0.5 -translate-x-1/2 bg-foreground" style={{ left: `${clamp(current)}%` }} aria-hidden />}
        <ol>
          {ruleSteps(rows).map((step) => (
            <li key={step.percent} className="absolute top-0 flex -translate-x-1/2 flex-col items-center gap-0.5 whitespace-nowrap text-xs" style={{ left: `${clamp(step.percent)}%` }}>
              <span className="h-[18px] w-px bg-muted-foreground" aria-hidden />
              <span><span className="font-medium">{step.percent}%</span>{' '}<span className="text-muted-foreground">{step.labels.join(' · ')}</span></span>
            </li>
          ))}
        </ol>
      </div>
    </fieldset>
  );
}
