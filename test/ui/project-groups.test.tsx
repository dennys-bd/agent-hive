import { beforeEach, expect, test } from 'vitest';
import { setLanguage } from '@/i18n';
import { groupItems, hiveGroups } from '@/lib/project-groups';
import { hiveProject } from '../../src/hive-project';
import type { Flow, Stage, Task } from '../../src/types';
import { VIEW } from './project-harness';

beforeEach(() => setLanguage('pt'));

// #583: build holds spec and dev, ship holds review; HIVE-2 has no stage, dev has no task
const stage = (name: string): Stage => ({ name, from: {}, prompt: 'x' });
const FLOWS: Flow[] = [{ name: 'build', stages: [stage('spec'), stage('dev')], transitions: [] }, { name: 'ship', stages: [stage('review')], transitions: [] }];
const task = (n: number, at?: string): Task => ({
  item: { itemId: `local:${n}`, id: `HIVE-${n}`, title: `Task ${n}`, body: '', url: '' }, ...(at === undefined ? {} : { stage: at }), boardColumn: '', auto: false, created: true,
});
const HIVE = hiveProject({ flows: FLOWS, tasks: [task(1, 'review'), task(2), task(3, 'spec')], activityRecords: [] });

test('the hive\'s groups follow the flows\' stage order, name the stage once with no → stage, hide an empty stage and close with sem fluxo (#583)', () => {
  const groups = hiveGroups(HIVE.items, HIVE);
  expect(groups.map((g) => [g.key, g.label, g.items.map((i) => i.id), g.stage])).toEqual([
    ['spec', 'spec', ['HIVE-3'], undefined], ['review', 'review', ['HIVE-1'], undefined], ['', 'sem fluxo', ['HIVE-2'], undefined],
  ]);
  setLanguage('en');
  expect(hiveGroups(HIVE.items, HIVE).at(-1)?.label).toBe('no flow');
});

test('a source\'s status groups keep the Project\'s Status order, each with the stage it enters (#756, #583 decision 13)', () => {
  const groups = groupItems(VIEW.items, { key: 'status', label: 'status' }, VIEW);
  expect(groups.map((g) => [g.label, g.stage])).toEqual([['Todo', 'sem etapa'], ['Ready', '→ dev'], ['Done', 'sem etapa']]);
});
