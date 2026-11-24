import { expect, test } from 'vitest';
import { parseTemplate } from '../../src/template';
import { addVariable, type EditResult, removeVariable, setHeadingLevel } from '../../src/template-edit';
import { type LintAnnotation, lintTemplate } from '../../src/template-lint';
import type { AgentAnnotation, AgentFix } from '../../src/reviewer';
import { agentFixOf, fixOf, hasFix, kindOf } from '@/lib/annotation-fix';

// Lines: depth declared on 4, the fence 5, an undeclared reviewer on 6, ## A on 7, an h4 on 8, an unknown reference on 9
const TEXT = ['---', 'name: x', 'variables:', '  depth: { default: full }', '---', 'Ask {{ reviewer }}.', '## A', '#### B', 'Run `/nowhere`.', ''].join('\n');
const annotations = lintTemplate(parseTemplate(TEXT), { self: { origin: 'hive', kind: 'skill', name: 'x' }, catalogue: [], workspaces: [{ name: 'hive', variables: {} }], scripts: [] });
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

const ADVICE: AgentAnnotation = { line: 1, severity: 'yellow', title: 'vague', body: 'say what runs', source: 'agent', kind: 'advice' };
// Lines: the step 1, a stop 2, the same step again 3
const STEPS = 'Run it.\nStop.\nRun it.\n';
const FIX: AgentFix = { line: 3, severity: 'yellow', title: 'vague', body: 'say what runs', source: 'agent', kind: 'fix', span: 'Run it.', replacement: 'Run the tests.' };
const CHECKS: LintAnnotation['check'][] = ['parse', 'render', 'undeclared', 'unused', 'required', 'reference', 'callRequired', 'heading', 'taskCondition'];

test("kindOf: a lint finding is a fix when hasFix holds and an advice otherwise, for every check; an agent finding's kind is its own (#981)", () => {
  expect(annotations.filter((a) => kindOf(a) === 'fix').map((a) => a.check)).toEqual(['unused', 'undeclared', 'heading']);
  expect(annotations.filter((a) => kindOf(a) === 'advice').map((a) => a.check)).toContain('reference');
  // without the variable or the level a fix needs, every check is an advice
  expect(CHECKS.map((check) => kindOf({ line: 1, severity: 'yellow', check, title: 't', body: 'b' }))).toEqual(CHECKS.map(() => 'advice'));
  expect([kindOf(ADVICE), kindOf(FIX), hasFix(ADVICE), hasFix(FIX)]).toEqual(['advice', 'fix', false, true]);
});

test("agentFixOf replaces the span's occurrence on its line, not an earlier identical one, over several lines too, and answers nothing once the span left its line (#981)", () => {
  expect(agentFixOf(FIX, STEPS)).toBe('Run it.\nStop.\nRun the tests.\n');
  expect(agentFixOf({ ...FIX, line: 1, span: 'Run it.\nStop.', replacement: 'Stop.' }, STEPS)).toBe('Stop.\nRun it.\n');
  expect(agentFixOf(FIX, 'Run it.\nStop.\nRun now.\n')).toBeUndefined();
  expect(agentFixOf(FIX, 'Run it.\nStop.\n')).toBeUndefined(); // its line is gone
});
