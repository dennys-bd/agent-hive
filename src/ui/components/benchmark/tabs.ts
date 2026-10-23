import { createElement, type ReactNode } from 'react';
import type { Experiment, PlanReadings } from '../../../types';
import { ArmsTab } from '@/components/benchmark/arms/ArmsTab';
import type { Benchmark } from '@/components/benchmark/benchmark-dock';
import { CompareTab } from '@/components/benchmark/compare/CompareTab';
import { ConfigTab } from '@/components/benchmark/config/ConfigTab';
import type { MessageKey } from '@/i18n';

export type TabId = 'arms' | 'config' | 'compare' | 'execution' | 'report';
/** What a tab's body reads beside its experiment (#463): the dock's selection, which a seed fork moves, and the Hive's latest rate-limit reading. */
export interface TabContext { select(id: string): void; rateLimits?: PlanReadings }
/** One tab of an experiment (#461): its label, its body and the header's primary action for it. A tab leaf (2.2–2.7) fills its own entry;
 * without `render` the view shows the placeholder, without `primary` the header has no primary action. `render` gets the view's state so a tab can
 * switch tabs (#462: ver em comparar) and hold the execution tab's picked run (#465), and the context a tab reads beside it (#463); `result` is
 * the execution tab's run result (2.6), the placeholder until it is filled. */
export interface BenchmarkTab {
  id: TabId; label: MessageKey;
  render?(experiment: Experiment, benchmark: Benchmark, context: TabContext): ReactNode; primary?(experiment: Experiment): ReactNode;
  result?(experiment: Experiment, token: string): ReactNode;
}

export const TABS: readonly BenchmarkTab[] = [
  { id: 'arms', label: 'benchmark.header.tab.arms', render: (experiment, benchmark) => createElement(ArmsTab, { experiment, benchmark }) },
  // #463: keyed by the experiment, so another selection (a fork's included) starts with no section in edit; no primary action (node 2.5)
  { id: 'config', label: 'benchmark.header.tab.config', render: (experiment, _benchmark, context) => createElement(ConfigTab, { key: experiment.id, experiment, context }) },
  { id: 'compare', label: 'benchmark.header.tab.compare', render: (experiment, benchmark) => createElement(CompareTab, { experiment, benchmark }) },
  { id: 'execution', label: 'benchmark.header.tab.execution' },
  { id: 'report', label: 'benchmark.header.tab.report' },
];
