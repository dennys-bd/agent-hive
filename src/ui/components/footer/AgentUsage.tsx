import { ChevronDownIcon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { AGENTS, planLimitAgents } from '../../../agents';
import type { AgentId, PlanReadings, RateLimits, State } from '../../../types';
import { sendJson, WriteCancelled } from '@/lib/api';
import { UsagePanel } from '@/components/footer/UsagePanel';
import { AgentMark, percentTone, RefreshButton, UsageMeter } from '@/components/footer/UsageParts';
import { t } from '@/i18n';
import { chipTitle, highestPercent, shownReadings, topAgent, usageWindows } from '@/lib/agent-usage';

/** The usage group's forms (#223): the footer picks one per step of handoff §6 (#227, footer-steps). */
export type UsageForm = 'full' | 'compact' | 'minimal' | 'group';
type ChipForm = Exclude<UsageForm, 'group'>;

const TICK_MS = 60_000;
const GROUP_MARKS = 3;
export const PLAN_AGENTS = planLimitAgents(); // the footer's default too, so its fit key counts the agents shown here (#227)
const CHIP = 'flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md border px-2 py-0.5';
const BAR: Record<Exclude<ChipForm, 'minimal'>, string> = { full: 'w-14', compact: 'w-7' };

// After the mark: each window (full, compact), the highest % (minimal), or that there is nothing to measure yet
function ChipBody({ reading, now, form }: { reading?: RateLimits; now: number; form: ChipForm }) {
  if (form === 'minimal') {
    const top = highestPercent(reading, now);
    return <span className={top === undefined ? 'text-muted-foreground' : percentTone(top)}>{top === undefined ? '—' : `${top}%`}</span>;
  }
  if (reading === undefined) return <span className="text-muted-foreground">{t('usage.noReading')}</span>;
  return usageWindows(reading, now).map((w) => (
    <UsageMeter key={w.key} label={w.short} percent={w.percent} barClassName={BAR[form]} reset={form === 'full' && w.reset !== '' ? w.reset : undefined} />
  ));
}

interface ChipProps { agent: AgentId; reading?: RateLimits; now: number; form: ChipForm; isOpen: boolean; isSpinning: boolean; onToggle(): void; onRefresh(agent: AgentId): void }

// The toggle (mark and meters) and the agent's ↻ side by side in one border, so no button nests in another
function UsageChip({ agent, reading, now, form, isOpen, isSpinning, onToggle, onRefresh }: ChipProps) {
  const title = chipTitle(agent, reading, now);
  return (
    <div className={CHIP} title={title}>
      <button type="button" aria-label={title} aria-expanded={isOpen} onClick={onToggle} className="flex items-center gap-2">
        <AgentMark agent={agent} />
        <ChipBody reading={reading} now={now} form={form} />
      </button>
      {form !== 'minimal' && <RefreshButton agent={agent} reading={reading} now={now} isSpinning={isSpinning} onRefresh={onRefresh} />}
    </div>
  );
}

interface GroupProps { agents: readonly AgentId[]; readings: PlanReadings; now: number; isOpen: boolean; onToggle(): void }

// The group form (handoff §6 step 6): the first three marks stacked, +n for the rest, the top agent and ⌄, one button for the panel
function UsageGroupButton({ agents, readings, now, isOpen, onToggle }: GroupProps) {
  const top = topAgent(agents, readings, now);
  const percent = top === undefined ? undefined : highestPercent(readings[top], now);
  const more = agents.length - GROUP_MARKS;
  return (
    <button type="button" aria-label={t('usage.panel.title')} aria-expanded={isOpen} onClick={onToggle} className={CHIP}>
      <span className="flex items-center">
        {agents.slice(0, GROUP_MARKS).map((agent, i) => (
          <span key={agent} className={`flex rounded-full bg-background ring-2 ring-background ${i > 0 ? '-ml-1' : ''}`}><AgentMark agent={agent} /></span>
        ))}
      </span>
      {more > 0 && <span className="text-muted-foreground">{`+${more}`}</span>}
      {top !== undefined && (
        <span className={percent === undefined ? 'text-muted-foreground' : percentTone(percent)}>{`${top} ${percent === undefined ? '—' : `${percent}%`}`}</span>
      )}
      <ChevronDownIcon aria-hidden="true" className="size-3 text-muted-foreground" />
    </button>
  );
}

interface AgentUsageProps { state: Pick<State, 'rateLimits'>; form: UsageForm; agents?: readonly AgentId[] } // agents: the tests' seam

/** The footer's usage group (#223): a chip per agent with plan limits, with or without a reading, or the group form's one button. It owns
 * the clock, the agents being read and whether the panel is open, so a chip's ↻ and the panel's spin together.
 * A click toggles the usage panel, rendered here so it anchors to the footer (relative), not to the group. */
export function AgentUsage({ state, form, agents = PLAN_AGENTS }: AgentUsageProps) {
  const [now, setNow] = useState(() => Date.now());
  const [isOpen, setIsOpen] = useState(false);
  const [refreshing, setRefreshing] = useState<ReadonlySet<AgentId>>(() => new Set());
  // Ticks the countdowns and the readings' ages between the 5-minute readings, and flips a window to reset at its reset time (#557)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);
  const toggle = (): void => setIsOpen((open) => !open);
  const close = useCallback(() => setIsOpen(false), []); // stable: the panel's listeners and focus hand-back hang on it
  // #557: sendJson, not act, so a failure toasts our copy; the server's reason is in hive.log. A cancel (#469) says nothing; the ↻ stops
  // either way
  const refresh = (agent?: AgentId): void => {
    const asked = agent === undefined ? agents : [agent];
    setRefreshing((current) => new Set([...current, ...asked]));
    void sendJson('POST', '/plan-limits/refresh', agent === undefined ? {} : { agent })
      .catch((err: unknown) => {
        if (err instanceof WriteCancelled) return;
        toast.error(agent === undefined ? t('usage.refresh.failedAll') : t('usage.refresh.failed', { agent: AGENTS[agent].label }));
      })
      .finally(() => setRefreshing((current) => new Set([...current].filter((a) => !asked.includes(a)))));
  };
  const readings = shownReadings(state.rateLimits ?? {}, now);
  return (
    <div data-usage-group="" className="flex shrink-0 items-center gap-2">
      {form === 'group'
        ? <UsageGroupButton agents={agents} readings={readings} now={now} isOpen={isOpen} onToggle={toggle} />
        : agents.map((agent) => (
          <UsageChip key={agent} agent={agent} reading={readings[agent]} now={now} form={form} isOpen={isOpen} isSpinning={refreshing.has(agent)} onToggle={toggle} onRefresh={refresh} />
        ))}
      {isOpen && <UsagePanel agents={agents} readings={readings} now={now} refreshing={refreshing} onRefresh={refresh} onClose={close} />}
    </div>
  );
}
