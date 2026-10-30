import { type BenchFlow, type BenchStage, type BenchTransition, END } from '../../../../types';
import { plural } from '@/components/benchmark/arms/arm-rows';
import { t } from '@/i18n';
import { executorLine, triggerLabel, verdictLabel } from '@/lib/flow-labels';
import { listOf } from '@/lib/settings-languages';

// What a stage's editor says about its verdicts, exits and entries (#536), over the copied flow. Pure, so the chart and the editor share it.
type FlowShape = Pick<BenchFlow, 'stages' | 'transitions'>;
export interface ExitLine { trigger: string; to: string; isBack: boolean; tries?: number } // trigger: transitionLabel's text without tries

const TRIGGERS_WITH_SUFFIX: readonly BenchTransition['when'][] = ['verdict', 'approved', 'feedback'];

const triggerOf = (transition: BenchTransition, flow: FlowShape): string =>
  transition.label ?? triggerLabel(transition.when, transition.verdict, flow.stages.find((s) => s.name === transition.from)?.action);

export function verdictsText(stage: BenchStage): string {
  if (stage.action === 'commands') return t('benchmark.arms.settings.verdicts.commands');
  if (stage.action === 'evaluate') return t('benchmark.arms.settings.verdicts.evaluate');
  if (stage.approval === true) return t('benchmark.arms.settings.verdicts.approval');
  const own = stage.verdicts ?? [];
  return own.length === 0 ? t('benchmark.arms.settings.verdicts.none') : own.map((v) => verdictLabel(v, stage.action)).join(', ');
}

export function exitsOf(flow: FlowShape, name: string): ExitLine[] {
  const index = (stageName: string): number => flow.stages.findIndex((s) => s.name === stageName);
  return flow.transitions.filter((tr) => tr.from === name).map((tr) => ({
    trigger: triggerOf(tr, flow),
    to: tr.to === END ? t('flow.end') : tr.to,
    // a loop counts as going back; the end never does
    isBack: tr.to !== END && index(tr.to) <= index(tr.from),
    ...(tr.maxTries === undefined ? {} : { tries: tr.maxTries }),
  }));
}

export function entriesText(flow: FlowShape, name: string): string {
  const incoming = flow.transitions.filter((tr) => tr.to === name);
  if (incoming.length === 0) return t('benchmark.arms.settings.entries.start');
  const from = incoming.map((tr) => (TRIGGERS_WITH_SUFFIX.includes(tr.when) ? `${tr.from} (${triggerOf(tr, flow)})` : tr.from));
  return t('benchmark.arms.settings.entries.from', { list: listOf(from, t('settings.formatters.and')) });
}

export function nodeLine(stage: BenchStage): string {
  if (stage.action === 'commands') return plural(stage.commands?.length ?? 0, 'benchmark.arms.settings.node.commands.one', 'benchmark.arms.settings.node.commands.other');
  if (stage.action === 'evaluate') return t('benchmark.arms.settings.node.judge', { who: stage.judge?.model ?? stage.judge?.agent ?? '' });
  return executorLine({ ...stage, from: {} });
}
