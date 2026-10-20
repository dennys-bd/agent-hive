import { expect, test } from 'vitest';
import { parseTemplate } from '../../src/template';
import { addVariable, type EditResult, removeVariable, setHeadingLevel } from '../../src/template-edit';
import { type LintAnnotation, lintTemplate } from '../../src/template-lint';
import { fixOf, hasFix } from '@/lib/annotation-fix';

// Lines: depth declared on 4, the fence 5, an undeclared reviewer on 6, ## A on 7, an h4 on 8, an unknown reference on 9
const TEXT = ['---', 'name: x', 'variables:', '  depth: { default: full }', '---', 'Ask {{ reviewer }}.', '## A', '#### B', 'Run `/nowhere`.', ''].join('\n');
const annotations = lintTemplate(parseTemplate(TEXT), { self: { origin: 'hive', kind: 'skill', name: 'x' }, catalogue: [], workspaces: ['hive'], scripts: [] });
function of(check: LintAnnotation['check']): LintAnnotation {
  const found = annotations.find((a) => a.check === check);
  if (found === undefined) throw new Error(`no ${check} annotation`);
  return found;
}

// The parse inside an EditResult holds a yaml Document, which toEqual cannot compare across two parses: the text and the map decide.
function same(a: EditResult | undefined, b: EditResult): boolean {
  return a?.ok === true && b.ok && a.text === b.text && JSON.stringify(a.map) === JSON.stringify(b.map);
}

test('fixOf answers a removal for unused, a default: null declaration for undeclared, a level change for heading, and nothing for the rest (#327)', () => {
  expect(same(fixOf(of('unused'), TEXT), removeVariable(TEXT, 'depth'))).toBe(true);
  expect(same(fixOf(of('undeclared'), TEXT), addVariable(TEXT, { name: 'reviewer', default: null }))).toBe(true);
  expect(same(fixOf(of('heading'), TEXT), setHeadingLevel(TEXT, 8, 3))).toBe(true);
  expect(fixOf(of('reference'), TEXT)).toBeUndefined();
  expect(annotations.filter(hasFix).map((a) => a.check)).toEqual(['unused', 'undeclared', 'heading']);
});

test('an agent annotation offers no fix: the agent sends none (#329)', () => {
  expect(hasFix({ line: 1, severity: 'yellow', title: 'vague', body: 'say what runs', source: 'agent' })).toBe(false);
});
