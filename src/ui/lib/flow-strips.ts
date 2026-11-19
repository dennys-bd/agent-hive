import type { LayoutEdge } from './flow-layout.js';
import type { EmptyStages } from './flow-view.js';

// The flowchart's drawn row (#914): what exibir's etapas vazias makes of the flow's stages, recomputed on every render, so a stage opens as soon
// as a task enters and collapses as soon as the last one leaves. Pure: FlowChart hands layoutFlow one node per entry.

/** A stage drawn as a node, or a strip of one or more empty stages in the flow's order. `id` is the first stage's name either way. */
export interface RowEntry { id: string; stages: readonly string[]; isStrip: boolean }

/** The row: under 'open' every stage a node; under 'collapse' each empty stage a strip; under 'merge' a run of empty neighbours one strip. */
export function stripsOf(stages: readonly string[], isEmpty: (stage: string) => boolean, mode: EmptyStages): RowEntry[] {
  const row: { id: string; stages: string[]; isStrip: boolean }[] = [];
  for (const stage of stages) {
    const last = row.at(-1);
    if (mode !== 'open' && isEmpty(stage)) {
      if (mode === 'merge' && last?.isStrip === true) last.stages.push(stage);
      else row.push({ id: stage, stages: [stage], isStrip: true });
    } else row.push({ id: stage, stages: [stage], isStrip: false });
  }
  return row;
}

/** Each edge with its ends on the row's ids. END and an unknown stage keep their names, which layoutFlow leaves out or routes as before. An
 * edge between two different stages of one strip, neighbours or not, either way, feedback too, is inner (the spec's user answer) and
 * carries its segments; a loop on one stage stays a loop on the strip's top. */
export function drawnEdgesOf<E extends LayoutEdge>(row: readonly RowEntry[], edges: readonly E[]): E[] {
  const at = new Map(row.flatMap((entry) => entry.stages.map((stage, k) => [stage, { entry, k }] as const)));
  return edges.map((e) => {
    const [a, b] = [at.get(e.from), at.get(e.to)];
    const ends = { from: a?.entry.id ?? e.from, to: b?.entry.id ?? e.to };
    if (a === undefined || b === undefined || a.entry !== b.entry || a.k === b.k) return { ...e, ...ends };
    return { ...e, ...ends, inner: true, segments: { from: a.k, to: b.k, count: a.entry.stages.length } };
  });
}
