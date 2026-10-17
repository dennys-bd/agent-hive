import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pluginSource } from '../src/hooks-settings.js';
import { parseTemplate, renderTemplate } from '../src/template.js';

const PLUGIN = pluginSource(); // the very directory the Hive copies into the home: one resolution, no drift
const SKILLS = ['decomposition', 'new-build', 'new-plan', 'new-pr', 'new-spec'];
const AGENTS = ['architect', 'build-fixer', 'code-reviewer', 'design-reviewer', 'designer', 'plan-reviewer', 'planner', 'security-reviewer', 'spec-reviewer', 'tdd'];

const skillText = (skill: string): Promise<string> => readFile(join(PLUGIN, 'skills', skill, 'SKILL.md.liquid'), 'utf8');

// #317: the variables each skill declares, confirmed against its text and the reference sections it follows
const VARIABLES: Record<string, string[]> = {
  'new-spec': ['docsRepo', 'specsDir', 'docsLanguage', 'chatLanguage', 'sliceMin', 'sliceMax', 'featureFlags'],
  'new-plan': ['docsRepo', 'specsDir', 'plansDir', 'designsDir', 'docsLanguage', 'chatLanguage', 'delivery', 'sliceMin', 'sliceMax', 'featureFlags', 'testCommand'],
  'new-build': ['docsRepo', 'specsDir', 'plansDir', 'walkthroughsDir', 'designsDir', 'docsLanguage', 'chatLanguage', 'delivery', 'uiCheck', 'testCommand'],
  'new-pr': ['docsRepo', 'specsDir', 'plansDir', 'walkthroughsDir', 'designsDir', 'docsLanguage', 'chatLanguage', 'delivery', 'testCommand'],
  decomposition: ['docsRepo', 'specsDir', 'docsLanguage', 'chatLanguage', 'decompositionLabel'],
};
// What a skill's list says for a workspace with no value: the default, or today's behaviour without one. Also reference/conventions.md's default column
const NO_VALUE: Record<string, string> = {
  docsRepo: 'none: the docs live in this repository',
  specsDir: '`docs/hive/specs`', plansDir: '`docs/hive/plans`', walkthroughsDir: '`docs/hive/walkthroughs`', designsDir: '`docs/hive/designs`',
  docsLanguage: '`English`', chatLanguage: 'the Hive\'s `hiveLanguage`, else the language the user writes in',
  delivery: '`single`', sliceMin: '`300`', sliceMax: '`550`', featureFlags: '`none`',
  uiCheck: 'none: no automatic visual check', testCommand: 'the test gate the repository\'s agent instructions file names', decompositionLabel: '`decomposed`',
};

// A template rendered for `workspace`; a failure names its first error
function renderedFor(text: string, workspace = 'a'): string {
  const result = renderTemplate(parseTemplate(text), workspace);
  if (!result.ok) return assert.fail(`${result.errors[0]?.line}: ${result.errors[0]?.message}`);
  return result.text;
}

// A version's header for workspace a, as the plugins view keeps it: each named declaration's own line gains a workspaces: entry
function valued(text: string, values: Record<string, string>): string {
  return Object.entries(values).reduce((acc, [name, value]) => {
    const next = acc.replace(new RegExp(`^( {2}${name}: \\{ .*) \\}$`, 'm'), `$1, workspaces: { a: ${value} } }`);
    assert.notEqual(next, acc, `${name} is declared on a line of its own`);
    return next;
  }, text);
}

const frontmatter = (text: string): Record<string, string> => {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(block, 'no frontmatter block');
  return Object.fromEntries(block[1].split('\n').map((line) => {
    const at = line.indexOf(':');
    return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
  }));
};

test('the plugin ships the manifest, the five skills, the ten agents and the two references, the skeleton and the scripts, and nothing else', async () => {
  const manifest = JSON.parse(await readFile(join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8')) as { name: string; description: string };
  assert.equal(manifest.name, 'hive', 'the namespace: /hive:new-spec and hive:tdd are built from it');
  assert.ok(manifest.description.length > 0);
  assert.deepEqual((await readdir(PLUGIN)).sort(), ['.claude-plugin', 'CREDITS.md', 'agents', 'reference', 'scripts', 'skills']);
  assert.deepEqual((await readdir(join(PLUGIN, 'reference'))).sort(), ['conventions.md', 'design.md', 'skeleton.hv.html'], 'reference/ holds the conventions every new-* skill reads first, the design rules the designer and its reviewer read, and the skeleton of a screen');
  assert.deepEqual((await readdir(join(PLUGIN, 'scripts'))).sort(), ['check-hv.mjs', 'import-dc.mjs'], 'scripts/ holds the plugin\'s checks and imports');
  assert.deepEqual((await readdir(join(PLUGIN, 'skills'))).sort(), SKILLS);
  assert.deepEqual((await readdir(join(PLUGIN, 'agents'))).sort(), AGENTS.map((a) => `${a}.md`));
  for (const skill of SKILLS) assert.deepEqual(await readdir(join(PLUGIN, 'skills', skill)), ['SKILL.md.liquid'], `skills/${skill} is one file`);
});

test('every skill and agent declares the frontmatter Claude Code reads, with the name of its own file', async () => {
  for (const skill of SKILLS) {
    const front = frontmatter(await skillText(skill));
    assert.equal(front.name, skill, `skills/${skill} declares its own name`);
    assert.ok((front.description ?? '').length > 40, `skills/${skill} has a description worth dispatching on`);
  }
  const opus: string[] = [];
  for (const agent of AGENTS) {
    const front = frontmatter(await readFile(join(PLUGIN, 'agents', `${agent}.md`), 'utf8'));
    assert.equal(front.name, agent);
    assert.ok((front.description ?? '').length > 40, `agents/${agent} has a description`);
    assert.ok(['sonnet', 'opus'].includes(front.model), `agents/${agent} routes to a model: ${front.model}`);
    assert.ok((front.tools ?? '').includes('Read'), `agents/${agent} declares its tools`);
    if (front.model === 'opus') opus.push(agent);
  }
  assert.deepEqual(opus, ['architect', 'designer', 'planner'], 'the model table: sonnet everywhere, opus for the architect, the designer and the planner');
});

test('the plugin depends on no other plugin: no ecc: or superpowers: reference anywhere in it', async () => {
  const files = [
    join(PLUGIN, 'CREDITS.md'),
    join(PLUGIN, 'reference', 'conventions.md'),
    join(PLUGIN, 'reference', 'design.md'),
    join(PLUGIN, 'reference', 'skeleton.hv.html'),
    join(PLUGIN, 'scripts', 'check-hv.mjs'),
    join(PLUGIN, 'scripts', 'import-dc.mjs'),
    ...SKILLS.map((s) => join(PLUGIN, 'skills', s, 'SKILL.md.liquid')),
    ...AGENTS.map((a) => join(PLUGIN, 'agents', `${a}.md`)),
  ];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    assert.doesNotMatch(text, /ecc:/, `${file} dispatches or cites the ecc plugin`);
    assert.doesNotMatch(text, /superpowers:/, `${file} dispatches or cites the superpowers plugin`);
    assert.doesNotMatch(text, /\$ARGUMENTS/, `${file} still uses the command-only $ARGUMENTS placeholder`);
    assert.doesNotMatch(text, /\/Users\/|\$HOME|~\/\.claude/, `${file} carries a machine-specific path`);
  }
  // every agent the skills name is one this plugin ships
  for (const skill of SKILLS) {
    const text = await skillText(skill);
    for (const [, name] of text.matchAll(/`hive:([a-z-]+)`/g)) {
      assert.ok(AGENTS.includes(name) || SKILLS.includes(name), `skills/${skill} names hive:${name}, which this plugin does not ship`);
    }
  }
});

test('every new-* skill resolves the conventions from the one reference text', async () => {
  for (const skill of SKILLS) {
    const text = await skillText(skill);
    assert.match(text, /reference\/conventions\.md/, `skills/${skill} does not read reference/conventions.md`);
  }
});

test('every shipped skill parses with no error, declares the variables its text reads, and renders for a workspace with no value to the defaults (#317)', async () => {
  for (const skill of SKILLS) {
    const text = await skillText(skill);
    const parsed = parseTemplate(text);
    assert.deepEqual(parsed.errors, [], skill);
    assert.deepEqual(parsed.variables.map((v) => v.name), VARIABLES[skill], skill);
    const rendered = renderedFor(text);
    for (const name of VARIABLES[skill]) assert.ok(rendered.includes(`\n- \`${name}\`: ${NO_VALUE[name]}\n`), `${skill}: ${name}`);
    assert.doesNotMatch(rendered, /\{\{|\{%/, `${skill}: no Liquid is left`);
  }
});

test('new-build rendered with delivery stacked and testCommand pnpm test for its workspace carries both; another workspace keeps the defaults (#317)', async () => {
  const text = valued(await skillText('new-build'), { delivery: 'stacked', testCommand: 'pnpm test' });
  const mine = renderedFor(text);
  assert.ok(mine.includes('\n- `delivery`: `stacked`\n'), mine);
  assert.ok(mine.includes('\n- `testCommand`: `pnpm test`\n'), mine);
  assert.ok(renderedFor(text, 'b').includes(`\n- \`delivery\`: ${NO_VALUE.delivery}\n`));
});

test('no shipped skill, raw or rendered, resolves a convention through hive_conventions or the agent instructions file (#317)', async () => {
  for (const skill of SKILLS) {
    const raw = await skillText(skill);
    for (const text of [raw, renderedFor(raw)]) {
      assert.doesNotMatch(text, /resolve the conventions as it says/, skill);
      assert.doesNotMatch(text, /`conventions`/, skill);
      assert.doesNotMatch(text, /## Hive conventions/, skill);
      assert.doesNotMatch(text, /sliceSize\.max|`sliceSize` only/, `${skill}: sliceSize is sliceMin and sliceMax`);
    }
  }
});

test('reference/conventions.md names every variable with its default, the variables panel that sets it, and what hive_conventions is still read for (#317)', async () => {
  const text = await readFile(join(PLUGIN, 'reference', 'conventions.md'), 'utf8');
  for (const [name, fallback] of Object.entries(NO_VALUE)) {
    assert.ok(text.includes(`| \`${name}\` |`), `${name} has a row`);
    assert.ok(text.includes(`| ${fallback} |`), `${name}'s default`);
  }
  for (const part of ['variables panel', '`approval`, `stage`, `fork` and `hiveLanguage`', '<home>/custom/hive/<skill>/<version>/']) assert.ok(text.includes(part), part);
  assert.equal(text.includes('| `sliceSize` |'), false, 'sliceSize is sliceMin and sliceMax');
});

test('the docs folders default under docs/hive, and no plugin file names the old docs/specs, docs/plans or docs/walkthroughs', async () => {
  const entries = await readdir(PLUGIN, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
  assert.ok(files.length > 0, 'the plugin directory was read');
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    assert.doesNotMatch(text, /(?<!hive\/)docs\/(specs|plans|walkthroughs)/, `${file} names an old default docs folder`);
  }
  const conventions = await readFile(join(PLUGIN, 'reference', 'conventions.md'), 'utf8');
  for (const folder of ['docs/hive/specs', 'docs/hive/plans', 'docs/hive/walkthroughs', 'docs/hive/designs']) {
    assert.ok(conventions.includes(`\`${folder}\``), `reference/conventions.md does not name ${folder} as a default`);
  }
});

test('every gh call /hive:new-pr makes for the docs PR names the docs repository, since GH_REPO names the code one', async () => {
  const text = await skillText('new-pr');
  const calls = text.match(/gh pr \w+[^`\n]*<docs (?:PR|head|base)>[^`\n]*/g) ?? [];
  assert.ok(calls.length >= 4, 'new-pr lists, creates, edits and views the docs PR');
  for (const call of calls) assert.match(call, /-R <docs repo>/, `${call} does not pass -R <docs repo>`);
});

test('hive:design-reviewer reports and never edits: its tools hold no Write or Edit', async () => {
  const front = frontmatter(await readFile(join(PLUGIN, 'agents', 'design-reviewer.md'), 'utf8'));
  const tools = (front.tools ?? '').split(',').map((tool) => tool.trim());
  assert.ok(tools.includes('Read'), 'it reads the screens');
  for (const tool of ['Write', 'Edit']) assert.ok(!tools.includes(tool), `design-reviewer declares ${tool}`);
});

test('hive:designer tells the calling session how comments and the review reach it, and answers through hive_reply', async () => {
  const text = await readFile(join(PLUGIN, 'agents', 'designer.md'), 'utf8');
  const { description = '' } = frontmatter(text);
  for (const name of ['SendMessage', 'hive_done', 'hive:design-reviewer']) assert.ok(description.includes(name), `its description does not name ${name}`);
  const body = text.replace(/^---\n[\s\S]*?\n---\n/, '');
  for (const name of ['hive_reply', 'resolve', 'designsDir', 'handoff.md', 'hive:design-reviewer']) assert.ok(body.includes(name), `its text does not name ${name}`);
});

test('every section the design agents quote by name is a heading of reference/design.md or reference/conventions.md', async () => {
  const headings = new Set<string>();
  for (const file of ['design.md', 'conventions.md']) {
    const text = await readFile(join(PLUGIN, 'reference', file), 'utf8');
    for (const [, heading] of text.matchAll(/^#{2,3} (.+)$/gm)) headings.add(heading.trim());
  }
  for (const agent of ['designer', 'design-reviewer']) {
    const text = await readFile(join(PLUGIN, 'agents', `${agent}.md`), 'utf8');
    for (const [, name] of text.matchAll(/"([A-Z][^"]*)"/g)) assert.ok(headings.has(name), `agents/${agent} quotes "${name}", which no reference heading carries`);
  }
});

test('no agent description holds ": ", which strict YAML reads as a nested mapping', async () => {
  for (const agent of AGENTS) {
    const { description = '' } = frontmatter(await readFile(join(PLUGIN, 'agents', `${agent}.md`), 'utf8'));
    assert.ok(!description.includes(': '), `agents/${agent}'s description holds ": "`);
  }
});

test('CREDITS.md credits Impeccable and ecc\'s frontend-design-direction for reference/design.md', async () => {
  const text = await readFile(join(PLUGIN, 'CREDITS.md'), 'utf8');
  for (const source of ['Impeccable', 'frontend-design-direction', 'reference/design.md']) assert.ok(text.includes(source), `CREDITS.md does not name ${source}`);
});

// Claude Code expands this in an agent's text; the Hive's PLUGIN path is where it points at run time
const PLUGIN_ROOT = '$' + '{CLAUDE_PLUGIN_ROOT}';

test('the design agents read the references through the plugin root variable, since an agent is not told its plugin\'s directory', async () => {
  for (const agent of ['designer', 'design-reviewer']) {
    const text = await readFile(join(PLUGIN, 'agents', `${agent}.md`), 'utf8');
    assert.ok(text.includes(`${PLUGIN_ROOT}/reference/design.md`), `agents/${agent} does not read the design rules from the plugin root`);
  }
});

test('the design check is the plugin\'s script, the designer imports through import-dc.mjs and starts from the skeleton, and the reviewer runs the check (#241)', async () => {
  const design = await readFile(join(PLUGIN, 'reference', 'design.md'), 'utf8');
  assert.ok(design.includes(`node "${PLUGIN_ROOT}/scripts/check-hv.mjs" "<folder>"`), 'design.md runs the check script');
  assert.doesNotMatch(design, /grep -nEi/, 'the grep check is gone');
  for (const heading of ['### Tweaks', '### The skeleton']) assert.ok(design.includes(heading), `design.md has ${heading}`);
  const designer = await readFile(join(PLUGIN, 'agents', 'designer.md'), 'utf8');
  for (const part of [`${PLUGIN_ROOT}/scripts/import-dc.mjs`, `${PLUGIN_ROOT}/reference/skeleton.hv.html`, '| import |']) assert.ok(designer.includes(part), `designer.md names ${part}`);
  const reviewer = await readFile(join(PLUGIN, 'agents', 'design-reviewer.md'), 'utf8');
  assert.ok(reviewer.includes(`${PLUGIN_ROOT}/scripts/check-hv.mjs`), 'the reviewer may run the check script');
});
