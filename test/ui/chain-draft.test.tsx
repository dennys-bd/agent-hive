import { expect, test } from 'vitest';
import { parseTemplate } from '../../src/template';
import { chainMarkers } from '../../src/template-condition';
import { buildMap } from '../../src/template-map';
import { chainsOf } from '../../src/template-preview';
import { addTerm, appendLine, type Draft, draftOf, type DraftTerm, formVariables, offeredOps, opsFor, rawMarkers, specOf, withConnective } from '@/lib/chain-draft';

const HEADER = ['---', 'variables:', '  delivery: { values: [pr, stacked, x], default: pr }', '  quick: { type: boolean }', '  testCommand: { default: null }', '---'];
// A body under the header: its chains and the form's variables
function read(body: string[]) {
  const parsed = parseTemplate([...HEADER, ...body, ''].join('\n'));
  return { chains: chainsOf(buildMap(parsed).blocks), variables: formVariables(parsed.variables, ['agent-hive', 'hive-site']) };
}
// What ok writes for a chain read into the form and left as it is
function rewritten(markers: string[]): string[] | undefined {
  const { chains: [chain], variables } = read(markers);
  const draft = chain && draftOf(chain, variables);
  const spec = draft && specOf(draft, variables);
  return spec ? chainMarkers(spec) : undefined;
}

test('a chain read into the form and written back gives its markers again: list, text and yes/no terms, an and over two variables, an or run, workspace (#322, decisions 4–6, 8)', () => {
  for (const markers of [
    ['{% if delivery == "pr" %}', '{% elsif delivery != "x" %}', '{% else %}', '{% endif %}'],
    ['{% if testCommand contains "pnpm" %}', '{% elsif testCommand == blank %}', '{% elsif testCommand %}', '{% endif %}'],
    ['{% unless quick %}', '{% else %}', '{% endunless %}'],
    ['{% if quick and delivery == "stacked" %}', '{% elsif quick == false and testCommand != "x" %}', '{% endif %}'],
    ['{% if delivery == "pr" or delivery == "stacked" %}', '{% endif %}'],
    ['{% if workspace == "hive-site" %}', '{% endif %}'],
  ]) expect(rewritten(markers), markers[0]).toEqual(markers);
});

test('an or run of is on a list variable folds into one "is one of…" at its first place; one value writes a plain is (#322, decision 5)', () => {
  const { chains: [chain], variables } = read(['{% if delivery == "pr" or quick or delivery == "x" %}', '{% endif %}']);
  expect(chain && draftOf(chain, variables)).toEqual({ else: false, blocks: [{ connective: 'or', terms: [{ variable: 'delivery', op: 'isOneOf', values: ['pr', 'x'] }, { variable: 'quick', op: 'hasValue', values: [] }] }] });
  const one: Draft = { else: false, blocks: [{ connective: 'and', terms: [{ variable: 'delivery', op: 'isOneOf', values: ['pr'] }] }] };
  expect(specOf(one, variables)).toEqual({ else: false, branches: [{ connective: 'and', terms: [{ variable: 'delivery', op: 'is', value: 'pr' }] }] });
});

test('a condition the form cannot show reads as null: parentheses, a mixed and/or, an undeclared variable, an operator its kind does not offer, a list value it does not declare (#322, decision 14)', () => {
  for (const marker of ['{% if (quick) %}', '{% if quick and delivery == "pr" or testCommand %}', '{% if ghost %}', '{% if delivery contains "p" %}', '{% if quick == "yes" %}', '{% if delivery == "old" %}', '{% if delivery == "pr" or delivery == "old" %}']) {
    const { chains: [chain], variables } = read([marker, '{% endif %}']);
    expect(chain && draftOf(chain, variables), marker).toBeNull();
  }
});

test('an incomplete or refused draft writes nothing: no variable, no operator, no value, a Liquid delimiter in a value, "is one of…" in an and of two terms (#322, decisions 5, 7, 9)', () => {
  const { variables } = read([]);
  const draftWith = (...terms: DraftTerm[]): Draft => ({ else: false, blocks: [{ connective: 'and', terms }] });
  for (const draft of [
    draftWith({ values: [] }),
    draftWith({ variable: 'delivery', values: [] }),
    draftWith({ variable: 'delivery', op: 'is', values: [] }),
    draftWith({ variable: 'testCommand', op: 'is', values: [''] }),
    draftWith({ variable: 'testCommand', op: 'contains', values: ['{{ x }}'] }),
    draftWith({ variable: 'delivery', op: 'isOneOf', values: ['pr', 'x'] }, { variable: 'quick', op: 'hasValue', values: [] }),
  ]) expect(specOf(draft, variables)).toBeNull();
});

test('the operators per kind; "is one of…" only alone or in an or; the raw markers; the line after the body (#322, decisions 4–6, 10, 14)', () => {
  expect([opsFor('text'), opsFor('list'), opsFor('boolean')]).toEqual([['is', 'isNot', 'contains', 'hasValue', 'isBlank'], ['is', 'isNot', 'isOneOf'], ['hasValue', 'isNo']]);
  const oneOf = { connective: 'and' as const, terms: [{ variable: 'delivery', op: 'isOneOf' as const, values: ['pr', 'x'] }] };
  expect(addTerm(oneOf).connective).toBe('or');
  expect(withConnective(addTerm(oneOf), 'and').terms).toEqual([{ variable: 'delivery', values: [] }, { values: [] }]);
  expect(offeredOps('list', withConnective(addTerm(oneOf), 'and'))).toEqual(['is', 'isNot']);
  const { chains: [chain] } = read(['{% unless (quick) %}', '{% else %}', '{% endunless %}']);
  expect(chain && rawMarkers(chain)).toEqual(['{% unless (quick) %}', '{% else %}', '{% endunless %}']);
  expect([appendLine(parseTemplate('---\nname: x\n---\nA\n')), appendLine(parseTemplate('A\nB')), appendLine(parseTemplate(''))]).toEqual([5, 3, 1]);
});
