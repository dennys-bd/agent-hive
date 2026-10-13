import { RotateCwIcon } from 'lucide-react';
import type { AgentId, RateLimits } from '../../../types';
import { AGENT_ICON } from '@/components/SessionLabel';
import { Progress } from '@/components/ui/progress';
import { refreshTitle } from '@/lib/agent-usage';
import { PERCENT_MAX, RED_AT } from '@/lib/usage';

const MARK = 'size-3.5 shrink-0';
// The agent's own colour on its mark (#669), the design system's agent-colour exception; an agent without one keeps currentColor
const AGENT_COLOR: Partial<Record<AgentId, string>> = { claude: 'text-agent-claude', codex: 'text-agent-codex' };

/** A percent's band, shared by its %, its reset time and (as bg-) its fill: destructive from RED_AT, muted below. */
export const percentTone = (percent: number): string => (percent >= RED_AT ? 'text-destructive' : 'text-muted-foreground');

/** The agent's 14px mark in its colour, or a 14×14 blank until it has one: never its name (handoff §3.1). */
export function AgentMark({ agent }: { agent: AgentId }) {
  const Icon = AGENT_ICON[agent];
  return Icon === undefined
    ? <span aria-hidden="true" data-mark="blank" className={MARK} />
    : <Icon className={`${MARK} ${AGENT_COLOR[agent] ?? ''}`} />;
}

interface UsageMeterProps { label: string; percent: number; barClassName: string; reset?: string }

/** One window: its label, a 4px bar on the accent track, the % right-aligned in 28px and, when given, the reset. */
export function UsageMeter({ label, percent, barClassName, reset }: UsageMeterProps) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-muted-foreground">{label}</span>
      <Progress className={`h-1 bg-accent ${barClassName}`} value={Math.min(percent, PERCENT_MAX)} indicatorClassName={percent >= RED_AT ? 'bg-destructive' : 'bg-foreground'} />
      <span className={`min-w-7 text-right ${percentTone(percent)}`}>{`${percent}%`}</span>
      {reset !== undefined && <span className={percentTone(percent)}>{reset}</span>}
    </span>
  );
}

interface RefreshButtonProps { agent: AgentId; reading?: RateLimits; now: number; isSpinning: boolean; onRefresh(agent: AgentId): void }

/** One agent's ↻: reads that agent only. It stops the click, so it never toggles the panel. */
export function RefreshButton({ agent, reading, now, isSpinning, onRefresh }: RefreshButtonProps) {
  const label = refreshTitle(agent, reading, now);
  return (
    <button
      type="button" aria-label={label} title={label} disabled={isSpinning}
      onClick={(e) => { e.stopPropagation(); onRefresh(agent); }}
      className="text-muted-foreground hover:text-foreground disabled:opacity-50"
    >
      <RotateCwIcon aria-hidden="true" className={`size-3 ${isSpinning ? 'animate-spin' : ''}`} />
    </button>
  );
}
