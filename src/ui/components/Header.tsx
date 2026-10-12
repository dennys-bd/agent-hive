import { RotateCwIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { AGENTS, agentName } from '../../agents';
import { act } from '@/components/actions';
import { AGENT_ICON } from '@/components/SessionLabel';
import { Progress } from '@/components/ui/progress';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { CenterMode } from '@/hooks/use-activity';
import { type MessageKey, t } from '@/i18n';
import { type PanelId, VIEW_SHORTCUTS } from '@/lib/dock-layout';
import { binding, isMac } from '@/lib/shortcut-bindings';
import { countdown, PERCENT_MAX, RED_AT } from '@/lib/usage';
import { WINDOW_CHROME } from '@/lib/window-chrome';
import { displayBinding } from '../../shortcuts';
import { AGENT_IDS, type AgentId, type RateLimits, type Signal, type State } from '../../types';

interface HeaderProps { state: State; signal: Signal; center: CenterMode; onView(panel: PanelId): void }

const TICK_MS = 60_000;
// The hexagon reads the effective signal at a glance, as the tray icon does
const SIGNAL_TEXT: Record<Signal, string> = { green: 'text-signal-green', yellow: 'text-signal-yellow', red: 'text-signal-red' };
const VIEW_LABEL: Record<CenterMode, MessageKey> = { automation: 'header.flow', activities: 'header.activities' };
// The limits the header shows, keyed as the agent reports them: the short label beside the bar and the long one in the tooltip
const LIMITS: ReadonlyArray<{ key: string; short: MessageKey; long: MessageKey }> = [
  { key: 'five_hour', short: 'header.fiveHour', long: 'header.fiveHour' },
  { key: 'seven_day', short: 'header.week', long: 'window.week' },
];
// Each agent's plan limits' last reading; only Claude reports any today (#516); Codex's is #929
const readingOf = (state: State): Record<AgentId, RateLimits | undefined> => ({ claude: state.rateLimits, codex: undefined });

// The agent's own colour, on its symbol in the usage group only (#669): the design system's agent-colour exception. An agent without one
// keeps currentColor
const AGENT_COLOR: Partial<Record<AgentId, string>> = { claude: 'text-agent-claude', codex: 'text-agent-codex' };

// The mark in the header is one filled hexagon, the honeycomb's centre cell (the handoff's ⬢), in the signal's colour
function HiveMark({ signal }: { signal: Signal }) {
  return (
    <svg viewBox="-88 -88 176 176" aria-hidden="true" className={`size-3 ${SIGNAL_TEXT[signal]}`} data-signal={signal} fill="currentColor">
      <polygon points="0,-88 76,-44 76,44 0,88 -76,44 -76,-44" />
    </svg>
  );
}

function ViewSwitch({ center, onView }: Pick<HeaderProps, 'center' | 'onView'>) {
  return (
    <ToggleGroup type="single" value={center} onValueChange={(value) => value && onView(value as PanelId)} spacing={0.5} className="rounded-md bg-muted p-0.5 [-webkit-app-region:no-drag]">
      {VIEW_SHORTCUTS.map(([panel, id]) => {
        const keys = binding(id);
        return (
          <ToggleGroupItem
            key={panel} value={panel}
            className="h-auto gap-1.5 rounded-sm px-2.5 py-[3px] text-[13px] font-medium data-[state=on]:bg-background data-[state=on]:text-foreground"
          >
            {t(VIEW_LABEL[panel as CenterMode])}
            {keys !== null && <span className="text-[11px] font-normal tracking-[.1em] text-muted-foreground">{displayBinding(keys, isMac())}</span>}
          </ToggleGroupItem>
        );
      })}
    </ToggleGroup>
  );
}

// Compact by default; once the header (the @container) reaches 56rem the bar widens and the reset shows inline (#669). One DOM for both
// forms: no ResizeObserver, no state. The countdown shares the percent's band, so a limit near its cap reads red as a whole
function LimitMeter({ label, percent, resetsAt, now }: { label: string; percent: number; resetsAt: string; now: number }) {
  const isHigh = percent >= RED_AT;
  const tone = isHigh ? 'text-destructive' : 'text-muted-foreground';
  return (
    <div className="flex items-center gap-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <Progress className="h-1 w-7 bg-muted @4xl:w-16" value={Math.min(percent, PERCENT_MAX)} indicatorClassName={isHigh ? 'bg-destructive' : undefined} />
      <span className={`min-w-[26px] ${tone}`}>{`${percent}%`}</span>
      <span className={`hidden @4xl:inline ${tone}`}>{countdown(resetsAt, now)}</span>
    </div>
  );
}

// Reads the plan limits now and replaces the held reading: the timer's merge keeps the higher percent inside a window, so a plan upgrade
// that lowers it only shows after the reset. The route reads the Hive's own reading, which is Claude's: the only agent with one today
function RefreshUsage() {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refresh = (): void => {
    setIsRefreshing(true);
    void act('/plan-limits/refresh').finally(() => setIsRefreshing(false)); // act never rejects: a refusal is its toast
  };
  const label = t('header.refreshUsage');
  return (
    <button type="button" aria-label={label} title={label} disabled={isRefreshing} onClick={refresh} className="text-muted-foreground hover:text-foreground disabled:opacity-50">
      <RotateCwIcon aria-hidden="true" className={`size-3 ${isRefreshing ? 'animate-spin' : ''}`} />
    </button>
  );
}

// One group per agent with a reading: its symbol, then a meter per limit it reports; the tooltip names the agent and each reset
function AgentUsage({ agent, reading, now }: { agent: AgentId; reading: RateLimits; now: number }) {
  const limits = LIMITS.flatMap((limit) => (reading.windows[limit.key] ? [{ ...limit, window: reading.windows[limit.key] }] : []));
  if (limits.length === 0) return null;
  const Icon = AGENT_ICON[agent];
  const resets = limits.map(({ long, window }) => `${t(long)} ${t('limits.resets', { time: countdown(window.resetsAt, now) })}`);
  return (
    <div className="flex items-center gap-2 rounded-md border px-2 py-[3px] [-webkit-app-region:no-drag]" title={[agent, ...resets].join(' · ')}>
      {Icon === undefined ? agentName(agent) : <Icon className={`size-3.5 ${AGENT_COLOR[agent] ?? ''}`} />}
      {limits.map(({ key, short, window }) => (
        <LimitMeter key={key} label={t(short)} percent={Math.round(window.usedPercent)} resetsAt={window.resetsAt} now={now} />
      ))}
      {AGENTS[agent].planLimits && <RefreshUsage />}{/* #925: a fact of the agent's entry, not its id */}
    </div>
  );
}

/** The window's top bar (#533): the mark, the view switcher and each agent's plan limits. The native title bar is hidden (main.ts), so the
 * left padding clears the traffic lights and the bar drags the window; its controls opt out of the drag to keep their clicks. */
export function Header({ state, signal, center, onView }: HeaderProps) {
  // Ticks the countdowns, inline and in the tooltip, between state updates, which arrive every 5 minutes for plan limits
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);
  const readings = readingOf(state);
  return (
    <header className={`@container flex shrink-0 items-center gap-4 border-b pr-3 ${WINDOW_CHROME}`}>
      <div className="flex items-center gap-1.5">
        <HiveMark signal={signal} />
        <span className="text-[13px] font-semibold">{t('header.brand')}</span>
      </div>
      <ViewSwitch center={center} onView={onView} />
      <div className="flex-1" />
      <div className="flex items-center gap-3.5">
        {AGENT_IDS.map((agent) => {
          const reading = readings[agent];
          return reading && <AgentUsage key={agent} agent={agent} reading={reading} now={now} />;
        })}
      </div>
    </header>
  );
}
