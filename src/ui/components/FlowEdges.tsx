import { useId } from 'react';
import { t } from '@/i18n';
import { END_SIZE, type Layout } from '@/lib/flow-layout';

interface FlowEdgesProps { layout: Layout; labels: Record<string, string>; pills?: ReadonlySet<string>; selected?: string; onSelect?(id: string): void }

const PILL = 'absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-[9px] border bg-background px-2 text-muted-foreground text-xs leading-[18px]';

/** The flowchart's arrows (#134): one SVG under the nodes, each arrow 1.5px in border with a triangular head, dashed (4 4) when automatic and
 * going back; each pill on its arrow in background, so it covers the line behind it; the end circle when the layout has one. `pills` (the flow
 * view, #908) names the arrows that carry one; without it every arrow does. With onSelect (Settings) a pill is a button and the selected arrow
 * is drawn in foreground. */
export function FlowEdges({ layout, labels, pills, selected, onSelect }: FlowEdgesProps) {
  const marker = `flow-arrow-${useId().replace(/[^A-Za-z0-9-]/g, '')}`; // useId's colons are no valid url(#…) fragment
  return (
    <>
      <svg aria-hidden="true" className="pointer-events-none absolute top-0 left-0" width={layout.width} height={layout.height}>
        <defs>
          <marker id={marker} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 0 L 8 4 L 0 8 z" fill="var(--border)" /></marker>
        </defs>
        {layout.edges.map((e) => (
          <path
            key={e.id} data-edge={e.id} data-kind={e.kind} d={e.path} fill="none" markerEnd={`url(#${marker})`}
            stroke={e.id === selected ? 'var(--foreground)' : 'var(--border)'} strokeWidth={e.id === selected ? 1.75 : 1.5} strokeDasharray={e.dashed ? '4 4' : undefined}
          />
        ))}
      </svg>
      {layout.edges.map((e) => {
        if (pills !== undefined && !pills.has(e.id)) return null;
        const style = { left: e.label.x, top: e.label.y };
        if (onSelect === undefined) return <span key={e.id} className={PILL} style={style}>{labels[e.id] ?? ''}</span>;
        const isSelected = e.id === selected;
        return (
          <button key={e.id} type="button" aria-pressed={isSelected} className={`${PILL} hover:text-foreground ${isSelected ? 'border-foreground text-foreground' : ''}`} style={style} onClick={() => onSelect(e.id)}>
            {labels[e.id] ?? ''}
          </button>
        );
      })}
      {layout.end && (
        <span className="absolute flex items-center justify-center rounded-full border bg-background text-muted-foreground text-xs" style={{ left: layout.end.x, top: layout.end.y, width: END_SIZE, height: END_SIZE }}>
          {t('flow.end')}
        </span>
      )}
    </>
  );
}
