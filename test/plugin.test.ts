import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pluginSource } from '../src/hooks-settings.js';

const PLUGIN = pluginSource(); // the very directory the Hive copies into the home: one resolution, no drift
const SKILLS = ['decomposition', 'new-build', 'new-plan', 'new-pr', 'new-spec'];
const AGENTS = ['architect', 'build-fixer', 'code-reviewer', 'design-reviewer', 'designer', 'plan-reviewer', 'planner', 'security-reviewer', 'spec-reviewer', 'tdd'];

const frontmatter = (text: string): Record<string, string> => {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(block, 'no frontmatter block');
  return Object.fromEntries(block[1].split('\n').map((line) => {
    const at = line.indexOf(':');
    return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
  }));
};

test('the plugin ships the manifest, the five skills, the ten agents and the two references, and nothing else', async () => {
  const manifest = JSON.parse(await readFile(join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8')) as { name: string; description: string };
  assert.equal(manifest.name, 'hive', 'the namespace: /hive:new-spec and hive:tdd are built from it');
  assert.ok(manifest.description.length > 0);
  assert.deepEqual((await readdir(PLUGIN)).sort(), ['.claude-plugin', 'CREDITS.md', 'agents', 'reference', 'skills']);
  assert.deepEqual((await readdir(join(PLUGIN, 'reference'))).sort(), ['conventions.md', 'design.md'], 'reference/ holds the conventions every new-* skill reads first and the design rules the designer and its reviewer read');
  assert.deepEqual((await readdir(join(PLUGIN, 'skills'))).sort(), SKILLS);
  assert.deepEqual((await readdir(join(PLUGIN, 'agents'))).sort(), AGENTS.map((a) => `${a}.md`));
  for (const skill of SKILLS) assert.deepEqual(await readdir(join(PLUGIN, 'skills', skill)), ['SKILL.md'], `skills/${skill} is one file`);
});

test('every skill and agent declares the frontmatter Claude Code reads, with the name of its own file', async () => {
  for (const skill of SKILLS) {
    const front = frontmatter(await readFile(join(PLUGIN, 'skills', skill, 'SKILL.md'), 'utf8'));
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
    ...SKILLS.map((s) => join(PLUGIN, 'skills', s, 'SKILL.md')),
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
    const text = await readFile(join(PLUGIN, 'skills', skill, 'SKILL.md'), 'utf8');
    for (const [, name] of text.matchAll(/`hive:([a-z-]+)`/g)) {
      assert.ok(AGENTS.includes(name) || SKILLS.includes(name), `skills/${skill} names hive:${name}, which this plugin does not ship`);
    }
  }
});

test('every new-* skill resolves the conventions from the one reference text', async () => {
  for (const skill of SKILLS) {
    const text = await readFile(join(PLUGIN, 'skills', skill, 'SKILL.md'), 'utf8');
    assert.match(text, /reference\/conventions\.md/, `skills/${skill} does not read reference/conventions.md`);
  }
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
  const text = await readFile(join(PLUGIN, 'skills', 'new-pr', 'SKILL.md'), 'utf8');
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
