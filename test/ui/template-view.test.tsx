import { beforeEach, expect, test } from 'vitest';
import { parseTemplate, renderTemplate } from '../../src/template';
import { parseCondition } from '../../src/template-condition';
import { buildMap, type Catalogue, type MapBranch } from '../../src/template-map';
import { previewTemplate } from '../../src/template-preview';
import { setLanguage } from '@/i18n';
import { blockAt, branchSentence, type EditorMode, isMarkdown, plainLook, previewLook, templateLook } from '@/lib/template-view';
import { BUILD_TEXT } from './plugins-fixtures';

const CATALOGUE: Catalogue = { skills: ['hive:new-pr'], agents: [] };
const parsed = parseTemplate(BUILD_TEXT);
const map = buildMap(parsed, CATALOGUE);
beforeEach(() => setLanguage('pt'));
const look = (mode: EditorMode) => templateLook({ text: BUILD_TEXT, parsed, map, catalogue: CATALOGUE, mode });

test('visual hides the header and every marker line, text hides nothing; a hidden line reveals on the line after it (#319, decisions 15, 19)', () => {
  expect(look('visual').hidden).toEqual([{ from: 1, to: 6 }, { from: 14, to: 14 }, { from: 16, to: 16 }, { from: 18, to: 18 }]);
  expect(look('text').hidden).toEqual([]);
  expect([look('visual').lineOf(16), look('visual').lineOf(20), look('text').lineOf(16)]).toEqual([17, 20, 16]);
});

test("the marks: the chain's lines on the branch background, the markers grey in text mode only, a pill per declared variable or workspace, an underline per reference; a chip per branch (#319, decisions 15–17)", () => {
  const marks = (mode: EditorMode) => look(mode).decorations.map((d) => [d.line, d.className, d.from, d.to, d.isBackground]);
  const background = [14, 15, 16, 17, 18].map((line) => [line, 'template-branch', undefined, undefined, true]);
  const body = [[9, 'template-ref', 14, 25, undefined], [13, 'template-pill', 19, 34, undefined]];
  expect(marks('visual')).toEqual([...background, ...body]);
  expect(marks('text')).toEqual([...background, ...[14, 16, 18].map((line) => [line, 'template-marker', undefined, undefined, undefined]), ...body]);
  expect(look('visual').chips).toEqual([{ line: 14, label: 'só quando delivery = stacked' }, { line: 16, label: 'senão' }]);
  const other = parseTemplate('---\nvariables:\n  a: { default: x }\n---\n{{ a }} {{ b }} {{ workspace | upcase }}\n');
  const pills = templateLook({ text: '---\nvariables:\n  a: { default: x }\n---\n{{ a }} {{ b }} {{ workspace | upcase }}\n', parsed: other, map: buildMap(other), catalogue: CATALOGUE, mode: 'text' });
  expect(pills.decorations.map((d) => [d.line, d.from, d.to])).toEqual([[5, 1, 8], [5, 17, 41]]); // b is not declared: no pill
});

test("the preview's look: the delivered header and the resolved lines, the markers hidden, the lines of a branch that does not hold dimmed, and the rest is the render (#319, decision 23)", () => {
  const preview = previewTemplate(parsed, map, { name: 'hive-site', variables: {} });
  if (!preview.ok) throw new Error('no preview');
  const shown = previewLook(preview);
  // the delivered header is 4 lines, so source line n is model line n - 2
  expect(shown.hidden).toEqual([{ from: 12, to: 12 }, { from: 14, to: 14 }, { from: 16, to: 16 }]);
  expect(shown.decorations).toEqual([{ line: 14, className: 'template-dim' }, { line: 15, className: 'template-dim' }]);
  expect([[...shown.dimmed], shown.chips, shown.lineOf(20), shown.lineOf(16)]).toEqual([[16, 17], [], 18, 15]);
  const render = renderTemplate(parsed, { name: 'hive-site', variables: {} });
  const kept = shown.text.split('\n').filter((_, i) => !shown.decorations.some((d) => d.line === i + 1)).join('\n');
  expect(render.ok && kept).toBe(render.ok && render.text);
});

test('a markdown file is .md or .md.liquid; any other file looks plain (#319, decision 14)', () => {
  expect(['SKILL.md', 'SKILL.md.liquid', 'slice_index.py', 'notes.liquid'].map(isMarkdown)).toEqual([true, true, false, false]);
  const plain = plainLook('print(1)\n');
  expect([plain.text, plain.hidden, plain.decorations, plain.chips, plain.lineOf(3)]).toEqual(['print(1)\n', [], [], [], 3]);
});

test('a branch\'s sentence reads its condition in words; a condition the form cannot read stays Liquid (#492)', () => {
  setLanguage('pt');
  const branch = (marker: MapBranch['marker'], conditionText: string): MapBranch =>
    ({ marker, conditionText, condition: marker === 'else' ? null : parseCondition(conditionText), line: 1, references: [], children: [] });
  expect(branchSentence(branch('if', 'delivery == "stacked"'))).toBe('só quando delivery = stacked');
  expect(branchSentence(branch('elsif', 'a != "x" or quick'))).toBe('só quando a ≠ x ou quick tem valor');
  expect(branchSentence(branch('unless', 'quick'))).toBe('só quando quick é não');
  expect(branchSentence(branch('unless', 'a == "x"'))).toBe('unless a == "x"');
  expect(branchSentence(branch('if', 'a contains "x" and b == blank and c == false and d == true'))).toBe('só quando a contém x e b está vazia e c é não e d = sim');
  expect(branchSentence(branch('else', ''))).toBe('senão');
  expect(branchSentence(branch('if', 'a == "x" and b or c'))).toBe('if a == "x" and b or c');
  setLanguage('en');
  expect(branchSentence(branch('if', 'delivery == "stacked"'))).toBe('only when delivery = stacked');
});

test('blockAt answers the map row at or above a line, nested rows included (#492)', () => {
  const built = buildMap(parseTemplate(BUILD_TEXT));
  expect([blockAt(built, 9), blockAt(built, 12), blockAt(built, 15), blockAt(built, 17), blockAt(built, 22)]).toEqual([9, 11, 14, 16, 20]);
  expect(blockAt(built, 3)).toBeUndefined(); // the header holds no row
});
