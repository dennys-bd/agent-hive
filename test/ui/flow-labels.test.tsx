import { beforeEach, expect, test } from 'vitest';
import { setLanguage } from '@/i18n';
import { executorLine, showsPill, transitionLabel, verdictLabel } from '@/lib/flow-labels';
import type { Stage } from '../../src/types';

// Which transitions the flow view labels (#908, handoff §2).
beforeEach(() => setLanguage('pt'));

test('the default path has no pill: a done, approved or passed forward arrow without a label, a forward skip included (#908)', () => {
  expect(showsPill({ from: 'dev', to: 'review', when: 'done' }, false)).toBe(false);
  expect(showsPill({ from: 'ci', to: 'review', when: 'verdict', verdict: 'passed' }, false)).toBe(false);
  expect(showsPill({ from: 'review', to: 'pr', when: 'approved' }, false)).toBe(false);
  expect(showsPill({ from: 'dev', to: 'pr', when: 'done' }, false)).toBe(false);
});

test('a labelled arrow, a verdict, feedback, a back edge and a loop keep their pill; a back edge with tries reads · 3x (#908)', () => {
  expect(showsPill({ from: 'dev', to: 'review', when: 'done', label: 'design' }, false)).toBe(true);
  expect(showsPill({ from: 'dev', to: 'review', when: 'verdict', verdict: 'failed' }, false)).toBe(true);
  expect(showsPill({ from: 'ci', to: 'dev', when: 'verdict', verdict: 'passed' }, true)).toBe(true);
  expect(showsPill({ from: 'dev', to: 'review', when: 'feedback' }, false)).toBe(true);
  expect(showsPill({ from: 'review', to: 'dev', when: 'done' }, true)).toBe(true);
  expect(showsPill({ from: 'dev', to: 'dev', when: 'approved' }, false)).toBe(true);
  expect(transitionLabel({ when: 'verdict', verdict: 'failed', maxTries: 3 })).toBe('falhou · 3x');
});

test('an evaluate stage\'s fixed verdicts read aprovou / reprovou; every other stage\'s passou / falhou; its node names its reviewers and judge (#877)', () => {
  expect([verdictLabel('passed', 'evaluate'), verdictLabel('failed', 'evaluate'), verdictLabel('failed', 'commands'), verdictLabel('failed')]).toEqual(['aprovou', 'reprovou', 'falhou', 'falhou']);
  expect(transitionLabel({ when: 'verdict', verdict: 'failed', maxTries: 3 }, 'evaluate')).toBe('reprovou · 3x');
  const stage: Stage = { name: 'eval', from: {}, action: 'evaluate', reviewers: [{ agent: 'claude', focus: 'x' }], judge: { agent: 'claude' }, threshold: 7, rubric: 'a' };
  expect(executorLine(stage)).toBe('1 revisor e um juiz');
  expect(executorLine({ ...stage, reviewers: [] })).toBe('só o juiz');
});
