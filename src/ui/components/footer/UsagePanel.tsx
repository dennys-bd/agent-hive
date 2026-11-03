import { XIcon } from 'lucide-react';
import { type RefObject, useEffect, useRef } from 'react';
import { agentName } from '../../../agents';
import type { AgentId, PlanReadings, RateLimits } from '../../../types';
import { AgentMark, RefreshButton, UsageMeter } from '@/components/footer/UsageParts';
import { t, tPlural } from '@/i18n';
import { readAgo, resetText, usageWindows } from '@/lib/agent-usage';

interface UsagePanelProps { agents: readonly AgentId[]; readings: PlanReadings; now: number; refreshing: ReadonlySet<AgentId>; onRefresh(agent?: AgentId): void; onClose(): void }
interface RowProps { agent: AgentId; reading?: RateLimits; now: number; isSpinning: boolean; onRefresh(agent: AgentId): void }

// One agent: mark, name, the reading's age and its ↻; then a line per window whose bar fills the row
function PanelRow({ agent, reading, now, isSpinning, onRefresh }: RowProps) {
  return (
    <li className="flex flex-col gap-1.5 px-3 py-2">
      <div className="flex items-center gap-2">
        <AgentMark agent={agent} />
        <span className="text-foreground">{agentName(agent)}</span>
        {reading !== undefined && <span className="text-muted-foreground">{t('usage.read', { ago: readAgo(reading.at, now) })}</span>}
        <span className="flex-1" />
        <RefreshButton agent={agent} reading={reading} now={now} isSpinning={isSpinning} onRefresh={onRefresh} />
      </div>
      {reading === undefined
        ? <span className="text-muted-foreground">{t('usage.noReading')}</span>
        : usageWindows(reading, now).map((w) => (
          <UsageMeter key={w.key} label={w.long} percent={w.percent} barClassName="flex-1" reset={resetText(w)} />
        ))}
    </li>
  );
}

// Escape and a click outside the group (its chips and this panel, both under [data-usage-group]) close it. Focus comes in on open, so
// Escape works without a mouse first, and goes back to the opener on close. onClose must be stable, or every render re-runs this
function useDismiss(ref: RefObject<HTMLDialogElement | null>, onClose: () => void): void {
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    const onPointer = (e: Event): void => { if (!(e.target instanceof Element && e.target.closest('[data-usage-group]'))) onClose(); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
      opener?.focus();
    };
  }, [ref, onClose]);
}

/** The usage panel (#223, handoff §3.2): flush with the window's left edge, above the footer, so only its top-right corner rounds. Every
 * agent with plan limits, its windows, resets and ↻; the place the reset times and ↻ stay within reach in the footer's smaller forms. */
export function UsagePanel({ agents, readings, now, refreshing, onRefresh, onClose }: UsagePanelProps) {
  const ref = useRef<HTMLDialogElement>(null);
  useDismiss(ref, onClose);
  const title = t('usage.panel.title');
  const button = 'text-muted-foreground hover:text-foreground disabled:opacity-50';
  return (
    <dialog
      open ref={ref} aria-label={title} tabIndex={-1}
      className="absolute bottom-full left-0 z-50 m-0 flex max-h-[440px] w-[440px] flex-col rounded-tr-[8px] border border-b-0 bg-popover p-0 text-xs text-popover-foreground outline-none"
    >
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <span className="font-medium">{title}</span>
        <span className="text-muted-foreground">{tPlural('usage.panel.count', agents.length, { n: agents.length })}</span>
        <span className="flex-1" />
        <button type="button" disabled={refreshing.size > 0} onClick={() => onRefresh()} className={button}>{t('usage.refreshAll')}</button>
        <button type="button" aria-label={t('usage.close')} title={t('usage.close')} onClick={onClose} className={button}>
          <XIcon aria-hidden="true" className="size-3.5" />
        </button>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto">{/* the design system's thin scrollbar is global (index.css) */}
        {agents.map((agent) => (
          <PanelRow key={agent} agent={agent} reading={readings[agent]} now={now} isSpinning={refreshing.has(agent)} onRefresh={onRefresh} />
        ))}
      </ul>
    </dialog>
  );
}
