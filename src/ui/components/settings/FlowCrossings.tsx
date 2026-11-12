import { ArrowUpIcon, ArrowUpRightIcon } from 'lucide-react';
import { Fragment, useId } from 'react';
import { ArrowHead, PILL } from '@/components/FlowEdges';
import type { Crossing } from '@/lib/flow-crossings';

/** What a crossing's pills say (#691): the <flow> · <stage> pill, the trigger pill (outgoing only) and the accessible name. */
export interface CrossingText { pill: string; label: string; name: string }

interface FlowCrossingsProps { crossings: readonly Crossing[]; texts: Readonly<Record<string, CrossingText>>; width: number; height: number; selected?: string; stage?: string; onSelect(id: string): void }

// The design's flow pill: the fim exit's 1.5px outline. No twMerge here, so each state names its own colour pair rather than overriding PILL's
const FLOW_PILL = 'absolute inline-flex -translate-x-1/2 -translate-y-1/2 items-center gap-1 whitespace-nowrap rounded-[9px] border-[1.5px] bg-background pr-2 pl-1.5 text-xs leading-[18px]';

/** Settings' arrows into and out of another flow (#691). An outgoing one, its arrow and both pills select it, drawn in foreground when
 * selected. An incoming one is no pick (its transition is edited in its own flow) and is lit while its stage is selected. Always solid: a
 * crossing never goes back. */
export function FlowCrossings({ crossings, texts, width, height, selected, stage, onSelect }: FlowCrossingsProps) {
  const marker = `flow-cross-${useId().replace(/[^A-Za-z0-9-]/g, '')}`;
  const isLit = (c: Crossing): boolean => (c.kind === 'out' ? c.id === selected : c.stage === stage);
  return (
    <>
      <svg aria-hidden="true" className="pointer-events-none absolute top-0 left-0" width={width} height={height}>
        <defs><ArrowHead id={marker} fill="var(--border)" /><ArrowHead id={`${marker}-lit`} fill="var(--foreground)" /></defs>
        {crossings.map((c) => (
          // biome-ignore lint/a11y/noStaticElementInteractions: the arrow is a click target for the pointer; the pills beside it are the keyboard's way to the same pick
          <path
            key={c.id} data-crossing={c.id} d={c.path} fill="none" stroke={isLit(c) ? 'var(--foreground)' : 'var(--border)'} strokeWidth={isLit(c) ? 1.75 : 1.5}
            markerEnd={`url(#${isLit(c) ? `${marker}-lit` : marker})`} pointerEvents={c.kind === 'out' ? 'stroke' : 'none'}
            className={c.kind === 'out' ? 'cursor-pointer' : undefined} onClick={c.kind === 'out' ? () => onSelect(c.id) : undefined}
          />
        ))}
      </svg>
      {crossings.map((c) => <CrossingPills key={c.id} crossing={c} text={texts[c.id]} isLit={isLit(c)} onSelect={onSelect} />)}
    </>
  );
}

function CrossingPills({ crossing: c, text, isLit, onSelect }: { crossing: Crossing; text?: CrossingText; isLit: boolean; onSelect(id: string): void }) {
  if (text === undefined) return null;
  const at = { left: c.pill.x, top: c.pill.y };
  if (c.kind === 'in') {
    return <span role="img" aria-label={text.name} className={`${FLOW_PILL} cursor-default ${isLit ? 'border-foreground text-foreground' : 'border-border text-muted-foreground'}`} style={at}><ArrowUpIcon aria-hidden="true" className="size-3" />{text.pill}</span>;
  }
  return (
    <Fragment>
      <button type="button" aria-pressed={isLit} className={`${PILL} hover:text-foreground ${isLit ? 'border-foreground text-foreground' : ''}`} style={{ left: c.label.x, top: c.label.y }} onClick={() => onSelect(c.id)}>{text.label}</button>
      <button type="button" aria-pressed={isLit} aria-label={text.name} className={`${FLOW_PILL} ${isLit ? 'border-foreground text-foreground' : 'border-muted-foreground text-muted-foreground hover:text-foreground'}`} style={at} onClick={() => onSelect(c.id)}>
        <ArrowUpRightIcon aria-hidden="true" className="size-3" />{text.pill}
      </button>
    </Fragment>
  );
}
