import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AFTER_MESSAGE, headerKeyMessage, passageAnchor, passageErrors, renderPassages } from '../src/protocol-inserts.js';
import type { RenderWorkspace } from '../src/template.js';

// The user's protocol passages (#336): what a save refuses, and the render one workspace's protocol files receive
const PLAIN = '---\nafter: ask\n---\nCheck the docs first.\n';
const SITE_ONLY = [
  '---', 'after: ask', 'variables:', '  docsRepo: { default: null, workspaces: { hive-site: site-docs } }', '---',
  '{% if workspace == "hive-site" %}', "Before asking, check hive-site's open design questions in {{ docsRepo }}.", '{% endif %}', '',
].join('\n');
const REQUIRED = '---\nafter: done\nvariables:\n  team: { required: true, workspaces: { a: core } }\n---\nAsk {{ team }}.\n';

const at = (name: string, variables: RenderWorkspace['variables'] = {}): RenderWorkspace => ({ name, variables });

test('renderPassages answers the body alone, its blank edges trimmed, for a passage with only after and for one with variables; one whose if does not hold renders empty (#336)', () => {
  assert.deepEqual(renderPassages([{ id: 'p1', text: PLAIN }], at('hive')), [{ id: 'p1', after: 'ask', orphan: false, text: 'Check the docs first.', errors: [] }]);
  assert.deepEqual(renderPassages([{ id: 'p2', text: SITE_ONLY }], at('hive-site')),
    [{ id: 'p2', after: 'ask', orphan: false, text: "Before asking, check hive-site's open design questions in site-docs.", errors: [] }]);
  assert.deepEqual(renderPassages([{ id: 'p2', text: SITE_ONLY }], at('hive')), [{ id: 'p2', after: 'ask', orphan: false, text: '', errors: [] }]);
});

test('renderPassages keeps the order given, fails one workspace alone on a required variable it has no value for, and marks an anchor no block has as an orphan (#336)', () => {
  const passages = [{ id: 'p1', text: REQUIRED }, { id: 'p2', text: '---\nafter: gone\n---\nlast\n' }];
  assert.deepEqual(renderPassages(passages, at('a')).map((p) => [p.id, p.text, p.orphan]), [['p1', 'Ask core.', false], ['p2', 'last', true]]);
  const [failed] = renderPassages(passages, at('b'));
  assert.deepEqual(failed, { id: 'p1', after: 'done', orphan: false, errors: [{ line: 4, variable: 'team', message: 'variable "team" is required and has no value for workspace "b"' }] });
  assert.deepEqual(passageAnchor('---\nafter: gone\n---\nx'), { after: 'gone', orphan: true });
  assert.deepEqual(passageAnchor('no header'), { after: '', orphan: true });
});

test('passageErrors accepts after plus variables and refuses a bad or missing after, any other header key (basedOn included), broken YAML and a Liquid syntax error (#336)', () => {
  assert.deepEqual(passageErrors(PLAIN), []);
  assert.deepEqual(passageErrors(SITE_ONLY), []);
  assert.deepEqual(passageErrors('---\nafter: nowhere\n---\nx\n'), [{ line: 2, message: AFTER_MESSAGE }]);
  assert.deepEqual(passageErrors('just text\n'), [{ line: 2, message: AFTER_MESSAGE }]);
  assert.deepEqual(passageErrors('---\nafter: ask\ntitle: mine\n---\nx\n'), [{ line: 3, message: headerKeyMessage('title') }]);
  const credited = '---\nafter: ask\nbasedOn: { name: x, repo: o/r, ref: main, license: MIT, url: https://example.com }\n---\nx\n';
  assert.deepEqual(passageErrors(credited), [{ line: 3, message: headerKeyMessage('basedOn') }]);
  const yaml = passageErrors('---\nafter: [ask\n---\nx\n');
  assert.ok(yaml.length > 0 && yaml.every((e) => e.line >= 2), JSON.stringify(yaml));
  const liquid = passageErrors('---\nafter: ask\n---\n{% if workspace %}open\n');
  assert.equal(liquid.length, 1);
  assert.equal(liquid[0].line, 4);
});

test('passageErrors does not take a body line for a header key (#336)', () => {
  assert.deepEqual(passageErrors('---\nafter: nowhere\n---\nafter: this is body text\n'), [{ line: 2, message: AFTER_MESSAGE }]);
});

test('renderPassages renders a workspace\'s value where the passage has no entry of its own (#621)', () => {
  const [rendered] = renderPassages([{ id: 'p1', text: REQUIRED }], at('b', { team: 'ops' }));
  assert.equal(rendered?.text, 'Ask ops.');
});
