import type { FilterRule, Stage, State, Task } from '../../types';
import { STRIP_WIDTH, stripHeight } from '@/components/FlowChart';
import { StageMenu } from '@/components/StageMenu';
import { type DragRef, useStageDrag } from '@/components/task-drag';
import { t } from '@/i18n';

/** One stage of a strip (#914): what its segment shows, and its whole order, which a drop at its end is read in (#366). */
export interface StripSegment { stage: Stage; order: Task[]; count: number; rules: FilterRule[]; onFilter(): void; onClearFilter(): void; onList(): void }

interface SegmentProps { segment: StripSegment; state: State; drag: DragRef; isFirst: boolean }

// A segment is its stage's drop target: useStageDrag's drop at the end of its order, under the same canMoveToStage rules (#366, #708). While a
// card it takes is over it, it shows accent with an inset ring and the tip naming where the card goes
function Segment({ segment, state, drag, isFirst }: SegmentProps) {
  const { stage, order, count, rules, onFilter, onClearFilter, onList } = segment;
  const { dropBefore, dropAtEnd, dragOverEnd, onListDragLeave } = useStageDrag(drag, stage, order, state);
  const isOver = dropBefore !== undefined;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would bring a border and a legend; the group only names its segment (#914)
    <div
      role="group" aria-label={t('flow.strip.label', { stage: stage.name })} title={t('flow.strip.tip', { stage: stage.name })} data-segment={stage.name}
      data-drop={isOver ? 'over' : undefined} onDragOver={dragOverEnd} onDrop={dropAtEnd} onDragLeave={onListDragLeave}
      className={`relative flex min-h-0 flex-1 basis-0 flex-col items-center gap-1.5 py-2 text-muted-foreground text-xs first:rounded-t-xl last:rounded-b-xl data-[drop=over]:bg-accent data-[drop=over]:ring-1 data-[drop=over]:ring-ring data-[drop=over]:ring-inset ${isFirst ? '' : 'border-t border-dashed'}`}
    >
      <span className="tabular-nums">{count}</span>
      <span className="min-h-0 flex-1 truncate [writing-mode:vertical-rl]">{stage.name}</span>
      <StageMenu stage={stage.name} state={state} filtered={rules.length > 0} onFilter={onFilter} onClearFilter={onClearFilter} onList={onList} />
      {isOver && <span className="absolute top-1 left-full z-10 ml-1 whitespace-nowrap rounded-md border bg-popover px-2 py-0.5 text-foreground">{t('flow.strip.moveTo', { stage: stage.name })}</span>}
    </div>
  );
}

/** One or more empty stages collapsed (#914): STRIP_WIDTH wide, stripHeight tall (#1001), one segment per stage of equal height, top to bottom
 * the count, the name written down and the stage's ⋯. Not clipped, so a segment's drop tip shows beside it; the corner segments round instead. */
export function FlowStrip({ segments, state, drag, maxHeight }: { segments: readonly StripSegment[]; state: State; drag: DragRef; maxHeight: number }) {
  return (
    <div data-strip={segments[0]?.stage.name} style={{ width: STRIP_WIDTH, height: stripHeight(maxHeight, segments.length) }} className="flex flex-col rounded-xl border bg-card">
      {segments.map((s, i) => <Segment key={s.stage.name} segment={s} state={state} drag={drag} isFirst={i === 0} />)}
    </div>
  );
}
