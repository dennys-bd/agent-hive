import { BotIcon, ListChecksIcon, type LucideIcon, ScaleIcon, Trash2Icon, UserCheckIcon, WorkflowIcon } from 'lucide-react';
import { isAutomatic } from '../../../transitions';
import type { AgentId } from '../../../types';
import { FlowEdges } from '@/components/FlowEdges';
import { type CrossingText, FlowCrossings } from '@/components/settings/FlowCrossings';
import { t } from '@/i18n';
import { type CrossingEdge, placeCrossings } from '@/lib/flow-crossings';
import { layoutFlow, MARGIN } from '@/lib/flow-layout';
import { enteringFlow, type FlowsDraft } from '@/lib/settings-flows';
import { isGateDraft, type StageDraft, stageMeta } from '@/lib/settings-stages';
import { draftLabel, flowName, flowOfStage, isCrossFlow, routeName, stageNameIn, type TransitionDraft } from '@/lib/settings-transitions';

/** What the editor shows (#134): a stage's or a transition's, by draft id. back (#887): the stage whose saídas opened the transition; a pick on the chart sets none. */
export type ChartSelection = { kind: 'stage' | 'transition'; id: string; back?: string };

const NODE_WIDTH = 150;
const NODE_HEIGHT = 64; // 6b's node (#887)
// 6b's canvas (#887): 1px dots of --border on a 16px grid, inline so they follow the theme's token
export const CANVAS = { backgroundImage: 'radial-gradient(color-mix(in srgb, var(--border) 90%, transparent) 1px, transparent 1px)', backgroundSize: '16px 16px' };

/** The action's icon (#134, 6b's table): bot, list-checks, workflow, scale, user-check, trash-2. */
export const actionIcon = (s: StageDraft): LucideIcon =>
  (s.action === 'commands' ? ListChecksIcon : s.action === 'waitForCi' ? WorkflowIcon : s.action === 'evaluate' ? ScaleIcon : s.action === 'deleteActivity' ? Trash2Icon : isGateDraft(s) ? UserCheckIcon : BotIcon);

interface StageChartProps { flow: string; comb: FlowsDraft; stages: StageDraft[]; transitions: TransitionDraft[]; selection: ChartSelection; defaultAgent: AgentId; onSelect(selection: ChartSelection): void }

// #691: the open flow's arrows into another flow, then other flows' arrows into it, and what their pills say
function crossingsOf(flow: string, transitions: readonly TransitionDraft[], comb: FlowsDraft): { edges: CrossingEdge[]; texts: Record<string, CrossingText> } {
  const out = transitions.filter((d) => isCrossFlow(d, comb.stages));
  const into = enteringFlow(comb, flow);
  const name = (id: string): string => stageNameIn(comb.stages, comb.flows, id, flow);
  const texts = Object.fromEntries([
    ...out.map((d): [string, CrossingText] => [d.id, { pill: name(d.to), label: draftLabel(d, comb.stages), name: t('settings.transitions.outgoing', { route: routeName(d, comb.stages, comb.flows, flow) }) }]),
    ...into.map((d): [string, CrossingText] => [d.id, {
      pill: name(d.from), label: '', name: t('settings.transitions.incoming', { from: name(d.from), when: t(`settings.transitions.when.${d.when}`), flow: flowName(comb.flows, flowOfStage(comb.stages, d.from)) }),
    }]),
  ]);
  return { edges: [...out.map((d) => ({ id: d.id, stage: d.from, kind: 'out' as const })), ...into.map((d) => ({ id: d.id, stage: d.to, kind: 'in' as const }))], texts };
}

/** Settings' flowchart (#134, 6b): the flow view's layout and arrows over fixed-size node buttons, each with its action's icon and summary;
 * a node or a pill selects what the editor below shows. The wrapper is the canvas (#887): it bleeds to the card body's edges and scrolls
 * sideways when the chart is wider; the chart is centred. */
export function StageChart({ flow, comb, stages, transitions, selection, defaultAgent, onSelect }: StageChartProps) {
  const layout = layoutFlow(stages.map((s) => ({ id: s.id, height: NODE_HEIGHT })), transitions.map((d) => ({ id: d.id, from: d.from, to: d.to, automatic: isAutomatic(d.when) })), NODE_WIDTH, { end: true });
  const labels = Object.fromEntries(transitions.map((d) => [d.id, draftLabel(d, stages)]));
  const { edges, texts } = crossingsOf(flow, transitions, comb);
  const placed = placeCrossings(layout.nodes, edges);
  const height = Math.max(layout.height, placed.bottom + MARGIN); // #691: room for the crossing pills under the row
  // -mx-5 undoes SettingsGroup's body p-5, so the canvas reaches the card's edges as in 6b
  return (
    <div className="-mx-5 overflow-x-auto py-4" style={CANVAS}>
      <div className="relative mx-auto" style={{ width: layout.width, height }}>
        <FlowEdges layout={layout} labels={labels} selected={selection.kind === 'transition' ? selection.id : undefined} onSelect={(id) => onSelect({ kind: 'transition', id })} />
        <FlowCrossings
          crossings={placed.crossings} texts={texts} width={layout.width} height={height} selected={selection.kind === 'transition' ? selection.id : undefined}
          stage={selection.kind === 'stage' ? selection.id : undefined} onSelect={(id) => onSelect({ kind: 'transition', id })}
        />
        {layout.nodes.map((box) => {
          const s = stages.find((x) => x.id === box.id);
          if (s === undefined) return null;
          const Icon = actionIcon(s);
          const isSelected = selection.kind === 'stage' && selection.id === s.id;
          return (
            <button
              key={s.id} type="button" aria-pressed={isSelected} onClick={() => onSelect({ kind: 'stage', id: s.id })} style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
              className={`absolute flex flex-col items-start gap-1 rounded-lg border px-3 py-2 text-left ${isSelected ? 'border-foreground bg-accent' : 'bg-card'}`}
            >
              <span className="flex max-w-full items-center gap-1.5 font-medium text-sm"><Icon aria-hidden="true" className="size-3.5 shrink-0" /><span className="truncate">{s.name.trim() || t('settings.stages.unnamed')}</span></span>
              <span className="w-full truncate text-muted-foreground text-xs">{stageMeta(s, defaultAgent)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
