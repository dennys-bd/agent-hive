import { beforeEach, expect, test } from 'vitest';
import { setLanguage } from '@/i18n';
import { showsPill, transitionLabel } from '@/lib/flow-labels';

// Which transitions the flow view labels (#908, handoff §2).
beforeEach(() => setLanguage('pt'));

test('the default path has no pill: a done or approved forward arrow without a label, a forward skip included (#908)', () => {
  expect(showsPill({ from: 'dev', to: 'review', when: 'done' }, false)).toBe(false);
  expect(showsPill({ from: 'review', to: 'pr', when: 'approved' }, false)).toBe(false);
  expect(showsPill({ from: 'dev', to: 'pr', when: 'done' }, false)).toBe(false);
});

test('a labelled arrow, a verdict, feedback, a back edge and a loop keep their pill; a back edge with tries reads · 3x (#908)', () => {
  expect(showsPill({ from: 'dev', to: 'review', when: 'done', label: 'design' }, false)).toBe(true);
  expect(showsPill({ from: 'dev', to: 'review', when: 'verdict' }, false)).toBe(true);
  expect(showsPill({ from: 'dev', to: 'review', when: 'feedback' }, false)).toBe(true);
  expect(showsPill({ from: 'review', to: 'dev', when: 'done' }, true)).toBe(true);
  expect(showsPill({ from: 'dev', to: 'dev', when: 'approved' }, false)).toBe(true);
  expect(transitionLabel({ when: 'verdict', verdict: 'failed', maxTries: 3 })).toBe('falhou · 3x');
});
