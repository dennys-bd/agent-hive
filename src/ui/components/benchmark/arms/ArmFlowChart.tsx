import { isAutomatic, transitionKey } from '../../../../transitions';
import type { BenchStage, BenchTransition } from '../../../../types';
import { nodeLine } from '@/components/benchmark/arms/stage-lines';
import { FlowEdges } from '@/components/FlowEdges';
import { CANVAS } from '@/components/settings/StageChart';
import { t } from '@/i18n';
import { transitionLabel } from '@/lib/flow-labels';
import { layoutFlow } from '@/lib/flow-layout';

export const NODE_WIDTH = 100;
export const NODE_HEIGHT = 56;

interface ArmFlowChartProps {
  stages: readonly BenchStage[]; transitions: readonly BenchTransition[]; picked: string; marked: ReadonlySet<string>; isArm: boolean; onPick(name: string): void;
}

/** The copied flow, compact (#536): the flow view's layout and arrows over 100x56 node buttons. A node click picks the stage its editor shows; the
 * dot marks a stage the arm overrides. */
export function ArmFlowChart({ stages, transitions, picked, marked, isArm, onPick }: ArmFlowChartProps) {
  const layout = layoutFlow(
    stages.map((s) => ({ id: s.name, height: NODE_HEIGHT })),
    transitions.map((tr) => ({ id: transitionKey(tr), from: tr.from, to: tr.to, automatic: isAutomatic(tr.when) })),
    NODE_WIDTH, { end: true },
  );
  const labels = Object.fromEntries(transitions.map((tr) => [transitionKey(tr), transitionLabel(tr, stages.find((s) => s.name === tr.from)?.action)]));
  return (
    <div className="flex flex-col gap-1.5 pt-2">
      <div className="h-[150px] max-w-[768px] overflow-auto rounded-md border" style={CANVAS}>
        <div className="relative" style={{ width: layout.width, height: layout.height }}>
          <FlowEdges layout={layout} labels={labels} />
          {layout.nodes.map((box) => {
            const stage = stages.find((s) => s.name === box.id);
            if (stage === undefined) return null;
            return (
              <button
                key={stage.name} type="button" aria-current={picked === stage.name ? 'true' : undefined} onClick={() => onPick(stage.name)}
                style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
                className={`absolute flex flex-col items-start gap-1 rounded-lg border px-2.5 py-1.5 text-left ${picked === stage.name ? 'border-foreground bg-accent' : 'bg-card'}`}
              >
                <b className="flex max-w-full items-center gap-1.5 font-medium text-[13px]">
                  <span className="truncate">{stage.name}</span>
                  {marked.has(stage.name) && <span role="img" aria-label={t('benchmark.arms.settings.node.overridden')} className="size-1.5 flex-none rounded-full bg-foreground" />}
                </b>
                <small className="w-full truncate text-[11px] text-muted-foreground">{nodeLine(stage)}</small>
              </button>
            );
          })}
        </div>
      </div>
      <p className="m-0 text-muted-foreground text-xs">
        {t('benchmark.arms.settings.flowNote')}
        {isArm && <>{' · '}<span aria-hidden="true" className="inline-block size-1.5 rounded-full bg-foreground align-middle" />{` ${t('benchmark.arms.settings.node.overridden')}`}</>}
      </p>
    </div>
  );
}
