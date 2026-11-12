import { type Box, SPREAD } from './flow-layout.js';

// #691: Settings' arrows out of the open flow into another flow's stage, and other flows' arrows into one of its stages. Neither end has a
// node in this chart, so each arrow ends in a pill under its stage, as settings.hv.html draws them. Kept off layoutFlow, which the flow view shares.
export const LABEL_DROP = 36; // the trigger pill on an outgoing arrow, under the node's bottom
export const PILL_DROP = 100; // the <flow> · <stage> pill's centre, under the node's bottom
export const PILL_HALF = 10; // about half a pill's height: the arrow stops on its edge
// ponytail: a stage's next crossing goes one lane further down, its arrow behind the first one's pills; a fan-out if a stage ever has several
export const LANE = PILL_DROP;

export interface CrossingEdge { id: string; stage: string; kind: 'out' | 'in' }
export interface Crossing extends CrossingEdge { path: string; label: { x: number; y: number }; pill: { x: number; y: number } }

/** Each crossing under its stage's node (#691): the k-th of n at a stage SPREAD apart around the node's centre and k lanes lower. An outgoing
 * arrow runs down from the node's bottom to its pill; an incoming one runs up from its pill into the node. A stage the layout lacks is left
 * out. bottom: the lowest pill's edge, 0 with none. */
export function placeCrossings(nodes: readonly Box[], edges: readonly CrossingEdge[]): { crossings: Crossing[]; bottom: number } {
  const crossings = edges.flatMap((e): Crossing[] => {
    const node = nodes.find((n) => n.id === e.stage);
    if (node === undefined) return [];
    const shared = edges.filter((o) => o.stage === e.stage);
    const k = shared.indexOf(e);
    const x = node.x + node.width / 2 + SPREAD * (k - (shared.length - 1) / 2);
    const base = node.y + node.height;
    const pill = { x, y: base + PILL_DROP + k * LANE };
    const [from, to] = e.kind === 'out' ? [base, pill.y - PILL_HALF] : [pill.y - PILL_HALF, base];
    return [{ ...e, path: `M ${x} ${from} L ${x} ${to}`, label: { x, y: base + LABEL_DROP + k * LANE }, pill }];
  });
  return { crossings, bottom: Math.max(0, ...crossings.map((c) => c.pill.y + PILL_HALF)) };
}
