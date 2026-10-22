import type { ReactNode } from 'react';
import type { Experiment } from '../../../types';
import type { MessageKey } from '@/i18n';

export type TabId = 'arms' | 'config' | 'compare' | 'execution' | 'report';
/** One tab of an experiment (#461): its label, its body and the header's primary action for it. A tab leaf (2.2–2.7) fills its own entry;
 * without `render` the view shows the placeholder, without `primary` the header has no primary action. */
export interface BenchmarkTab { id: TabId; label: MessageKey; render?(experiment: Experiment): ReactNode; primary?(experiment: Experiment): ReactNode }

export const TABS: readonly BenchmarkTab[] = [
  { id: 'arms', label: 'benchmark.header.tab.arms' },
  { id: 'config', label: 'benchmark.header.tab.config' },
  { id: 'compare', label: 'benchmark.header.tab.compare' },
  { id: 'execution', label: 'benchmark.header.tab.execution' },
  { id: 'report', label: 'benchmark.header.tab.report' },
];
