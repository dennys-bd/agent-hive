import { beforeEach, expect, test } from 'vitest';
import { proposalHunk } from '../../src/assist';
import { parseTemplate } from '../../src/template';
import { buildMap, type Catalogue } from '../../src/template-map';
import { setLanguage } from '@/i18n';
import { markedLines, proposalLook } from '@/lib/assist-view';
import { type TextLook, templateLook } from '@/lib/template-view';
import { BUILD_TEXT } from './plugins-fixtures';

const CATALOGUE: Catalogue = { skills: ['hive:new-pr'], agents: [] };
const parsed = parseTemplate(BUILD_TEXT);
// visual: hides the header 1–6 and the markers 14, 16, 18; a ref on line 9, a pill on 13, the chain's background on 14–18, chips on 14, 16
const base = templateLook({ text: BUILD_TEXT, parsed, map: buildMap(parsed, CATALOGUE), catalogue: CATALOGUE, mode: 'visual' });
const TWO_LINES = { from: 9, to: 9, text: 'Intro.\nThen /hive:new-pr.' }; // line 9 becomes two
const proposals = (look: TextLook) => look.decorations.filter((d) => d.className.startsWith('template-proposal')).map((d) => [d.line, d.className, d.isBackground]);

beforeEach(() => setLanguage('en'));

test('proposalLook puts the deleted lines above the added ones, each on its whole-line class, with the chip on the first added line (#331)', () => {
  const hunk = proposalHunk(BUILD_TEXT, TWO_LINES);
  const look = proposalLook(base, hunk);
  expect(look.text.split('\n').slice(7, 12)).toEqual(['', 'Intro, then /hive:new-pr.', 'Intro.', 'Then /hive:new-pr.', '']);
  expect(proposals(look)).toEqual([[9, 'template-proposal-old', true], [10, 'template-proposal-new', true], [11, 'template-proposal-new', true]]);
  expect(look.chips.at(-1)).toEqual({ line: 10, label: 'agent proposal' });
  expect(markedLines(hunk)).toEqual({ from: 9, to: 11 });
});

test('a pure deletion keeps the text, marks the deleted lines and puts the chip on the first of them (#331)', () => {
  const hunk = proposalHunk(BUILD_TEXT, { from: 9, to: 10, text: '' });
  const look = proposalLook(base, hunk);
  expect(look.text).toBe(BUILD_TEXT);
  expect(proposals(look)).toEqual([[9, 'template-proposal-old', true], [10, 'template-proposal-old', true]]);
  expect(look.chips.at(-1)).toEqual({ line: 9, label: 'agent proposal' });
  expect(markedLines(hunk)).toEqual({ from: 9, to: 10 });
});

test('the hidden ranges, marks and chips after the hunk move down by the added lines, the ones on a deleted line go; lineOf follows; dimmed stays (#331)', () => {
  const look = proposalLook(base, proposalHunk(BUILD_TEXT, TWO_LINES));
  expect(look.hidden).toEqual([{ from: 1, to: 6 }, { from: 16, to: 16 }, { from: 18, to: 18 }, { from: 20, to: 20 }]);
  expect(look.decorations.filter((d) => !d.className.startsWith('template-proposal')).map((d) => [d.line, d.className])).toEqual([
    ...[16, 17, 18, 19, 20].map((line) => [line, 'template-branch']), [15, 'template-pill'],
  ]);
  expect(look.chips).toEqual([{ line: 16, label: 'if delivery == "stacked"' }, { line: 18, label: 'else' }, { line: 10, label: 'agent proposal' }]);
  expect([look.lineOf(7), look.lineOf(16), look.lineOf(20)]).toEqual([7, 19, 22]);
  expect(look.dimmed).toBe(base.dimmed);
});
