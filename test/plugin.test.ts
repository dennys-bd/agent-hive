import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pluginSource } from '../src/hooks-settings.js';
import { parseTemplate, renderTemplate } from '../src/template.js';

const PLUGIN = pluginSource(); // the very directory the Hive copies into the home: one resolution, no drift
const SKILLS = ['decomposition', 'new-build', 'new-plan', 'new-pr', 'new-spec'];
// #430: the decomposition skill declares its own variables and reads no reference; the new-* skills still read conventions.md
const CONVENTIONS_SKILLS = SKILLS.filter((skill) => skill !== 'decomposition');
const AGENTS = ['architect', 'build-fixer', 'code-reviewer', 'decomposition-reviewer', 'design-reviewer', 'designer', 'plan-reviewer', 'planner', 'security-reviewer', 'spec-reviewer', 'tdd', 'template-reviewer'];

const skillText = (skill: string): Promise<string> => readFile(join(PLUGIN, 'skills', skill, 'SKILL.md.liquid'), 'utf8');
// #416: an agent that reads a Hive convention is a template; the rest stay plain Markdown
const TEMPLATE_AGENTS: readonly string[] = ['designer'];
// #446: an agent reviewed since names no model; the older ones still route to one
const NO_MODEL: readonly string[] = ['decomposition-reviewer', 'designer'];
const agentPath = (agent: string): string => `agents/${agent}${TEMPLATE_AGENTS.includes(agent) ? '.md.liquid' : '.md'}`;
const agentText = (agent: string): Promise<string> => readFile(join(PLUGIN, agentPath(agent)), 'utf8');

// #317: the variables each skill declares, confirmed against its text and the reference sections it follows
const VARIABLES: Record<string, string[]> = {
  'new-spec': ['docsRepo', 'specsDir', 'docsLanguage', 'chatLanguage', 'sliceMin', 'sliceMax', 'featureFlags'],
  'new-plan': ['docsRepo', 'specsDir', 'plansDir', 'designsDir', 'docsLanguage', 'chatLanguage', 'delivery', 'sliceMin', 'sliceMax', 'featureFlags', 'testCommand'],
  'new-build': ['docsRepo', 'specsDir', 'plansDir', 'walkthroughsDir', 'designsDir', 'docsLanguage', 'chatLanguage', 'delivery', 'uiCheck', 'testCommand'],
  'new-pr': ['docsRepo', 'specsDir', 'plansDir', 'walkthroughsDir', 'designsDir', 'docsLanguage', 'chatLanguage', 'delivery', 'testCommand'],
  decomposition: ['specsDir', 'docsLanguage', 'chatLanguage', 'decompositionLabel'],
};
// What a skill's list says for a workspace with no value: the default, or today's behaviour without one. Also reference/conventions.md's default column
const NO_VALUE: Record<string, string> = {
  docsRepo: 'none: the docs live in this repository',
  specsDir: '`docs/hive/specs`', plansDir: '`docs/hive/plans`', walkthroughsDir: '`docs/hive/walkthroughs`', designsDir: '`docs/hive/design`',
  docsLanguage: '`English`', chatLanguage: 'the Hive\'s `hiveLanguage`, else the language the user writes in',
  delivery: '`single`', sliceMin: '`300`', sliceMax: '`550`', featureFlags: '`none`',
  designSystem: 'none: no design system',
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

// #338, decisions 3–8: each shipped item's origins in header order; [] is an original, whose header opens with ORIGINAL
const ORIGINAL = '# original: written for the Hive, no external source';
const SOURCES: Record<string, { ref: string; license: string }> = {
  'affaan-m/ECC': { ref: 'v2.2.1', license: 'MIT' },
  'obra/superpowers': { ref: 'v6.4.1', license: 'MIT' },
  'pbakaus/impeccable': { ref: 'c63b8dd7dd5a5f3c32eaabe1af76d0694f863ed2', license: 'Apache-2.0' },
};
const CREDITED: Record<string, string[]> = {
  'agents/architect.md': ['ecc:architect'],
  'agents/build-fixer.md': ['ecc:build-error-resolver'],
  'agents/code-reviewer.md': ['ecc:code-reviewer'],
  'agents/decomposition-reviewer.md': [],
  'agents/design-reviewer.md': ['impeccable', 'ecc:frontend-design-direction'],
  'agents/designer.md.liquid': ['impeccable', 'ecc:frontend-design-direction'],
  'agents/plan-reviewer.md': ['superpowers:writing-plans'],
  'agents/planner.md': ['ecc:planner', 'superpowers:writing-plans'],
  'agents/security-reviewer.md': ['ecc:security-reviewer'],
  'agents/spec-reviewer.md': ['superpowers:brainstorming'],
  'agents/tdd.md': ['ecc:tdd-guide'],
  'agents/template-reviewer.md': [],
  'skills/decomposition/SKILL.md.liquid': [],
  'skills/new-build/SKILL.md.liquid': [],
  'skills/new-plan/SKILL.md.liquid': ['superpowers:writing-plans'],
  'skills/new-pr/SKILL.md.liquid': ['ecc:pr'],
  'skills/new-spec/SKILL.md.liquid': ['superpowers:brainstorming'],
};

test('the plugin ships the manifest, the five skills, the twelve agents and the three references, the skeleton and the scripts, and nothing else', async () => {
  const manifest = JSON.parse(await readFile(join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8')) as { name: string; description: string };
  assert.equal(manifest.name, 'hive', 'the namespace: /hive:new-spec and hive:tdd are built from it');
  assert.ok(manifest.description.length > 0);
  assert.deepEqual((await readdir(PLUGIN)).sort(), ['.claude-plugin', 'CREDITS.md', 'agents', 'reference', 'scripts', 'skills']);
  assert.deepEqual((await readdir(join(PLUGIN, 'reference'))).sort(), ['conventions.md', 'decomposition.md', 'design.md', 'hv-kit.js', 'hv-tokens.css', 'skeleton.hv.html'], 'reference/ holds the conventions every new-* skill reads first, the decomposition file the skill writes and its reviewer reads, the design rules the designer and its reviewer read, the skeleton of a screen and the kit and tokens a design folder shares');
  assert.deepEqual((await readdir(join(PLUGIN, 'scripts'))).sort(), ['check-hv.mjs', 'import-dc.mjs'], 'scripts/ holds the plugin\'s checks and imports');
  assert.deepEqual((await readdir(join(PLUGIN, 'skills'))).sort(), SKILLS);
  assert.deepEqual((await readdir(join(PLUGIN, 'agents'))).sort(), AGENTS.map((a) => agentPath(a).slice('agents/'.length)));
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
    const front = frontmatter(await agentText(agent));
    assert.equal(front.name, agent);
    assert.ok((front.description ?? '').length > 40, `agents/${agent} has a description`);
    if (NO_MODEL.includes(agent)) assert.equal(front.model, undefined, `${agent} names no model: a session's or a stage's model is set in the Hive, for any agent runner (#446)`);
    else assert.ok(['sonnet', 'opus'].includes(front.model), `agents/${agent} routes to a model: ${front.model}`);
    assert.ok((front.tools ?? '').includes('Read'), `agents/${agent} declares its tools`);
    if (front.model === 'opus') opus.push(agent);
  }
  assert.deepEqual(opus, ['architect', 'planner'], 'the model table: sonnet everywhere, opus for the architect and the planner, none for the agents reviewed since #446');
});

test('every shipped skill and agent credits its origins in basedOn, each a file at its source\'s ref, or opens its header with the original comment (#338)', async () => {
  const items = [...SKILLS.map((s) => `skills/${s}/SKILL.md.liquid`), ...AGENTS.map(agentPath)].sort();
  assert.deepEqual(Object.keys(CREDITED).sort(), items, 'every shipped item has a row');
  for (const path of items) {
    const text = await readFile(join(PLUGIN, path), 'utf8');
    const parsed = parseTemplate(text);
    const names = CREDITED[path] ?? [];
    assert.deepEqual(parsed.errors, [], path);
    assert.deepEqual(parsed.basedOn?.map((origin) => origin.name), names.length === 0 ? undefined : names, path);
    assert.equal(text.split('\n')[1] === ORIGINAL, names.length === 0, `${path}: the original comment is line 2 exactly when it has no origin`);
    for (const origin of parsed.basedOn ?? []) {
      const source = SOURCES[origin.repo];
      assert.ok(source, `${path}: unknown repository ${origin.repo}`);
      assert.deepEqual([origin.ref, origin.license], [source.ref, source.license], path);
      assert.ok(origin.url.startsWith(`https://github.com/${origin.repo}/blob/${origin.ref}/`), `${path}: ${origin.url}`);
    }
  }
});

test('the plugin depends on no other plugin: no ecc: or superpowers: reference anywhere it delivers', async () => {
  const others = ['CREDITS.md', 'reference/conventions.md', 'reference/decomposition.md', 'reference/design.md', 'reference/skeleton.hv.html', 'scripts/check-hv.mjs', 'scripts/import-dc.mjs'];
  const items = [...SKILLS.map((s) => `skills/${s}/SKILL.md.liquid`), ...AGENTS.map(agentPath)];
  for (const [file, isItem] of [...others.map((f): [string, boolean] => [f, false]), ...items.map((f): [string, boolean] => [f, true])]) {
    const raw = await readFile(join(PLUGIN, file), 'utf8');
    // #338: an item's basedOn names its upstream (ecc:planner) on purpose and is never delivered, so an item is checked as delivered
    const text = isItem ? renderedFor(raw) : raw;
    assert.doesNotMatch(text, /ecc:/, `${file} dispatches or cites the ecc plugin`);
    assert.doesNotMatch(text, /superpowers:/, `${file} dispatches or cites the superpowers plugin`);
    assert.doesNotMatch(raw, /\$ARGUMENTS/, `${file} still uses the command-only $ARGUMENTS placeholder`);
    assert.doesNotMatch(raw, /\/Users\/|\$HOME|~\/\.claude/, `${file} carries a machine-specific path`);
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
  for (const skill of CONVENTIONS_SKILLS) {
    const text = await skillText(skill);
    assert.match(text, /reference\/conventions\.md/, `skills/${skill} does not read reference/conventions.md`);
  }
});

const DECOMPOSITION_VALUES: Record<string, string> = { specsDir: 'design/specs', docsLanguage: 'Spanish', chatLanguage: 'Portuguese', decompositionLabel: 'tree' };

test('/hive:decomposition declares its own four variables, interpolated where used, and reads no reference, no Hive tool but hive_task (#7) and no runner tool (#430)', async () => {
  const text = await skillText('decomposition');
  assert.doesNotMatch(text, /docsRepo|conventions\.md|CLAUDE\.md|AGENTS\.md|hiveLanguage/, 'no docsRepo (a nested docs repo is reached through specsDir), no reference, no agent instructions file by name');
  for (const tool of ['hive_done', 'hive_ask', 'hive_conventions', 'hive_stop', 'AskUserQuestion']) assert.ok(!text.includes(tool), `the skill names ${tool}: the protocol says when to call the Hive's tools`);
  assert.match(text, /^## Rules$/m);
  assert.match(text, /When rules disagree, the most specific wins: what the user says; the\ninstructions at `\{\{ specsDir \}\}`/, 'the repository and its specs folder win over the skill');
  const reference = await readFile(join(PLUGIN, 'reference', 'decomposition.md'), 'utf8');
  assert.match(reference, /-\.->\|db\.submissions\|/, 'a labelled dotted edge is written with pipes: the `-. id .->` form breaks on a hyphen');
  for (const heading of ['## Contracts and blockers', '## Files touched', '## The file', '### The diagram', '### Check before you end']) assert.ok(reference.includes(heading), `reference/decomposition.md lacks ${heading}`);
  for (const heading of ['## Contracts and blockers', '## Files touched', '### Check before you end']) assert.ok(!text.includes(heading), `the skill still carries ${heading}: it is the reference's`);
  assert.doesNotMatch(reference, /\{\{|\{%/, 'the reference is plain Markdown: a .md never renders');
  // #430: the reviewer is a separate pass the skill dispatches before every end, two rounds at most, and never edits or orders by Touches
  assert.match(text, /## Review\n\nOnce the check passes, dispatch the reviewer with the file's path:\n`Use the hive:decomposition-reviewer agent on <path>`/);
  for (const part of ['Two rounds at most', 'it never edits the file', 'a run resumed by feedback included']) assert.ok(text.includes(part), part);
  const reviewer = await readFile(join(PLUGIN, 'agents', 'decomposition-reviewer.md'), 'utf8');
  assert.ok(reviewer.includes(`${'$'}{CLAUDE_PLUGIN_ROOT}/reference/decomposition.md`), 'the reviewer reads the shared file rules');
  for (const part of ['never derive a `Blocked by` from the files two leaves touch', '**Verdict:** clean | changes needed', '### Blocking', '### Advisory', 'Unwritten dependency']) assert.ok(reviewer.includes(part), part);
  assert.ok(!frontmatter(reviewer).tools?.split(', ').some((tool) => ['Write', 'Edit', 'Bash'].includes(tool)), 'the reviewer only reads');
  const rendered = renderedFor(text);
  assert.doesNotMatch(rendered, /## Conventions/, 'no list of values: each is interpolated where it is used');
  for (const part of ['`docs/hive/specs/<YYYY-MM-DD>-<slug>-decomposition.md`', 'in English, and committed there', '`Label: decomposed`', "A `docs/hive/specs` that git\nignores is a stop"]) assert.ok(rendered.includes(part), part);
  assert.doesNotMatch(rendered, /Talk to the user in/, 'with chatLanguage unset, no language is imposed');
  const mine = renderedFor(valued(text, DECOMPOSITION_VALUES));
  for (const part of ['`design/specs/<YYYY-MM-DD>-<slug>-decomposition.md`', 'in Spanish, and committed there', 'Talk to the user in Portuguese.', 'Label: tree', 'the nested\none that holds `design/specs`']) assert.ok(mine.includes(part), part);
  assert.ok(renderedFor(valued(text, DECOMPOSITION_VALUES), 'b').includes('Label: decomposed'), 'another workspace keeps the defaults');
});

test('every shipped skill parses with no error, declares the variables its text reads, and renders for a workspace with no value to the defaults (#317)', async () => {
  for (const skill of SKILLS) {
    const text = await skillText(skill);
    const parsed = parseTemplate(text);
    assert.deepEqual(parsed.errors, [], skill);
    assert.deepEqual(parsed.variables.map((v) => v.name), VARIABLES[skill], skill);
    const rendered = renderedFor(text);
    if (CONVENTIONS_SKILLS.includes(skill)) for (const name of VARIABLES[skill]) assert.ok(rendered.includes(`\n- \`${name}\`: ${NO_VALUE[name]}\n`), `${skill}: ${name}`);
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

// #416: the designer's conventions; #439: no docsRepo, no conventions list: each value is interpolated where it is used
const DESIGNER_VARIABLES = ['designsDir', 'docsLanguage', 'chatLanguage', 'designSystem'];
const DESIGNER_VALUES: Record<string, string> = { designsDir: 'design/screens', docsLanguage: 'Spanish', chatLanguage: 'Portuguese', designSystem: 'docs/design-system.md' };

test('hive:designer is a template: it declares its four conventions, and a workspace with no value gets each default where it is used, no Liquid, no list and no variables in its header (#416, #439)', async () => {
  const text = await agentText('designer');
  const parsed = parseTemplate(text);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.variables.map((v) => v.name), DESIGNER_VARIABLES);
  const rendered = renderedFor(text);
  assert.doesNotMatch(rendered, /\{\{|\{%/, 'no Liquid is left');
  assert.doesNotMatch(rendered, /## Conventions/, 'no list of values: each is interpolated where it is used');
  const delivered = parseTemplate(rendered);
  assert.deepEqual([Object.hasOwn(delivered.header, 'variables'), Object.hasOwn(delivered.header, 'basedOn')], [false, false]);
  assert.equal(delivered.header.name, 'designer');
  for (const part of ['`docs/hive/design/<folder>/handoff.md`', 'in English (its headings too, except the first line']) assert.ok(rendered.includes(part), part);
  const body = rendered.replace(/^---\n[\s\S]*?\n---\n/, '');
  assert.doesNotMatch(body, /design.system/i, 'with designSystem unset, nothing about a design system is said (#439)');
  assert.doesNotMatch(body, /Talk in/, 'with chatLanguage unset, no language is imposed (#439)');
  assert.doesNotMatch(text, /docsRepo|conventions\.md/, 'the designer has no docsRepo and reads no conventions.md: a nested docs repo is reached through designsDir (#439)');
});

test('hive:designer rendered with a value for each convention carries each where it is used; another workspace keeps the defaults (#416, #439)', async () => {
  const text = valued(await agentText('designer'), DESIGNER_VALUES);
  const mine = renderedFor(text);
  for (const part of ['`design/screens/<YYYY-MM-DD>-<slug>/<screen>.hv.html`', '`design/screens/<folder>/handoff.md`', 'in Spanish (its headings too, except the first line', 'Talk in Portuguese.',
    'The design system, `docs/design-system.md`, then each file it names', "the design system's, `docs/design-system.md`;", "the design system's path, `docs/design-system.md`,", 'writes `hv-tokens.css` from the token files']) {
    assert.ok(mine.includes(part), part);
  }
  const other = renderedFor(text, 'b');
  assert.ok(other.includes('`docs/hive/design/<folder>/handoff.md`') && !other.includes('Talk in') && !/design.system/i.test(other.replace(/^---\n[\s\S]*?\n---\n/, '')), 'b keeps the defaults');
});

test('hive:designer works in rounds: a round ends with what changed, the commit is offered and made only when asked, the handoff only on request (#439)', async () => {
  const text = await agentText('designer');
  assert.ok(text.includes('| handoff |'), 'handoff is a mode');
  for (const part of ['## How a round ends', 'Never commit unasked', 'offer the commit in one line', 'A request for the design handoff is also a request to commit it']) {
    assert.ok(text.includes(part), part);
  }
  assert.doesNotMatch(text, /on every run/, 'nothing is written on every run');
  assert.match(text, /```markdown\n## Design handoff: /, 'the handoff model is inline, its first line the one later stages look for');
  assert.match(text, /are the repository's rules, in its agent instructions file/, 'where and how the commit is made is the repository\'s');
  assert.ok(text.includes('## Existing screens first') && text.includes("wait for the user's answer before writing it"), 'a new file is proposed, never written on its own');
  assert.match(text, /When rules disagree, the most specific wins: what the user says in the round; the instructions at `\{\{ designsDir \}\}`;/, 'the repository and its designs folder win over the plugin\'s rules (#439)');
});

test('hive:designer carries no Hive MCP instruction: the protocol says when to call hive_done, and a design comment says how to answer it (#439)', async () => {
  const text = await agentText('designer');
  for (const tool of ['hive_done', 'hive_reply', 'hive_ask', 'hive_conventions', 'hive_stop']) assert.ok(!text.includes(tool), `the designer names ${tool}`);
  const { description = '' } = frontmatter(text);
  for (const name of ['SendMessage', 'hive:design-reviewer']) assert.ok(description.includes(name), `its description does not name ${name}`);
  for (const name of ['in part <path>', 'hive:design-reviewer', 'handoff.md']) assert.ok(text.includes(name), `its text does not name ${name}`);
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
  assert.equal(text.includes('`conventions` key'), false, 'hive_conventions answers no conventions key (#318)');
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
  for (const folder of ['docs/hive/specs', 'docs/hive/plans', 'docs/hive/walkthroughs', 'docs/hive/design']) {
    assert.ok(conventions.includes(`\`${folder}\``), `reference/conventions.md does not name ${folder} as a default`);
  }
});

test('no plugin file names a Hive conventions section, and neither hive:designer nor reference/conventions.md resolves a convention from CLAUDE.md or AGENTS.md (#416)', async () => {
  const entries = await readdir(PLUGIN, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
  assert.ok(files.length > 0, 'the plugin directory was read');
  for (const file of files) assert.doesNotMatch(await readFile(file, 'utf8'), /Hive conventions/, file);
  for (const path of [agentPath('designer'), 'reference/conventions.md']) {
    assert.doesNotMatch(await readFile(join(PLUGIN, path), 'utf8'), /CLAUDE\.md|AGENTS\.md/, path);
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

test('every section the design agents and the decomposition reviewer quote by name is a heading of a reference or of the agent itself', async () => {
  const headings = new Set<string>();
  for (const file of ['design.md', 'conventions.md', 'decomposition.md']) {
    const text = await readFile(join(PLUGIN, 'reference', file), 'utf8');
    for (const [, heading] of text.matchAll(/^#{2,3} (.+)$/gm)) headings.add(heading.trim());
  }
  for (const agent of ['designer', 'design-reviewer', 'decomposition-reviewer']) {
    const text = await agentText(agent);
    const own = new Set([...text.matchAll(/^#{2,3} (.+)$/gm)].map(([, heading]) => heading.trim()));
    for (const [, name] of text.matchAll(/"([A-Z][^"]*)"/g)) assert.ok(headings.has(name) || own.has(name), `agents/${agent} quotes "${name}", which no reference heading nor its own carries`);
  }
});

test('no agent description holds ": ", which strict YAML reads as a nested mapping', async () => {
  for (const agent of AGENTS) {
    const { description = '' } = frontmatter(await agentText(agent));
    assert.ok(!description.includes(': '), `agents/${agent}'s description holds ": "`);
  }
});

test('CREDITS.md credits every source with its repository, ref and licence, and Impeccable and ecc\'s frontend-design-direction for reference/design.md (#338)', async () => {
  const text = await readFile(join(PLUGIN, 'CREDITS.md'), 'utf8');
  for (const source of ['Impeccable', 'frontend-design-direction', 'reference/design.md']) assert.ok(text.includes(source), `CREDITS.md does not name ${source}`);
  for (const heading of ['## ecc — MIT', '## superpowers — MIT', '## Impeccable — Apache 2.0']) assert.ok(text.includes(heading), heading);
  for (const [repo, { ref }] of Object.entries(SOURCES)) assert.ok(text.includes(`\`${repo}\``) && text.includes(`\`${ref}\``), `${repo} at ${ref}`);
  assert.doesNotMatch(text, /superpowers — Apache/, 'superpowers is MIT');
});

// Claude Code expands this in an agent's text; the Hive's PLUGIN path is where it points at run time
const PLUGIN_ROOT = '$' + '{CLAUDE_PLUGIN_ROOT}';

test('the design agents read the references through the plugin root variable, since an agent is not told its plugin\'s directory', async () => {
  for (const agent of ['designer', 'design-reviewer']) {
    const text = await agentText(agent);
    assert.ok(text.includes(`${PLUGIN_ROOT}/reference/design.md`), `agents/${agent} does not read the design rules from the plugin root`);
  }
});

test('the design check is the plugin\'s script, the designer imports through import-dc.mjs and starts from the skeleton, and the reviewer runs the check (#241)', async () => {
  const design = await readFile(join(PLUGIN, 'reference', 'design.md'), 'utf8');
  assert.ok(design.includes(`node "${PLUGIN_ROOT}/scripts/check-hv.mjs" "<folder>"`), 'design.md runs the check script');
  assert.doesNotMatch(design, /grep -nEi/, 'the grep check is gone');
  assert.ok(design.includes('### Tweaks'), 'design.md has ### Tweaks');
  for (const heading of ['### The skeleton', '## Polish', '## Distill', '## Normalize']) assert.ok(!design.includes(heading), `${heading} is the designer's alone, not in the shared rules (#439)`);
  const designer = await agentText('designer');
  for (const part of [`${PLUGIN_ROOT}/scripts/import-dc.mjs`, `${PLUGIN_ROOT}/reference/skeleton.hv.html`, '| import |']) assert.ok(designer.includes(part), `designer.md names ${part}`);
  // the first imports came out as static markup: the export's clicks were dropped and a sidebar's section became a tweak (#232)
  assert.match(designer, /Port every interaction of the export/, 'an import ports the export\'s clicks');
  assert.match(designer, /reached by clicking through `data-hv-set`, never a tweak/, 'a prop the export\'s clicks change is not a tweak');
  // a screen made from nothing has no export to carry its clicks: both modes declare them with the kit (#232)
  for (const part of [`${PLUGIN_ROOT}/reference/hv-kit.js`, `${PLUGIN_ROOT}/reference/hv-tokens.css`, "declare each one with the kit's attributes"]) assert.ok(designer.includes(part), `designer.md names ${part}`);
  assert.ok(design.includes('### Interactions'), 'design.md has ### Interactions');
  const reviewer = await readFile(join(PLUGIN, 'agents', 'design-reviewer.md'), 'utf8');
  assert.ok(reviewer.includes(`${PLUGIN_ROOT}/scripts/check-hv.mjs`), 'the reviewer may run the check script');
});

test('the design rules describe parts, their markers and the check\'s findings; the designer extracts and edits parts; the reviewer flags repeated markup (#421)', async () => {
  const design = await readFile(join(PLUGIN, 'reference', 'design.md'), 'utf8');
  assert.ok(design.includes('### Parts'), 'design.md has ### Parts');
  for (const part of ['<hv-include src=', '<hv-slot name=', '<template data-hv-slot=', 'data-hv-source', 'a slot fill the part does not declare']) assert.ok(design.includes(part), `design.md names ${part}`);
  const designer = await agentText('designer');
  assert.match(designer, /two or more screens of the folder/, 'the designer extracts repeated markup');
  assert.match(designer, /in part <path>/, 'a comment on a part edits the part');
  assert.match(designer, /includes the part instead/, 'an import uses the folder\'s parts');
  const reviewer = await readFile(join(PLUGIN, 'agents', 'design-reviewer.md'), 'utf8');
  assert.match(reviewer, /should be a part/, 'the reviewer flags repeated markup');
});

test('/hive:new-pr opens each nested repo\'s PR on that repository: every gh call for it passes -R <nested repo>, and the reference skips the docsRepo path (#653)', async () => {
  const text = await skillText('new-pr');
  const calls = text.match(/gh pr \w+[^`\n]*<nested (?:PR|head)>[^`\n]*/g) ?? [];
  assert.ok(calls.length >= 4, 'new-pr lists, creates, edits and views the nested repo PRs');
  for (const call of calls) assert.match(call, /-R <nested repo>/, `${call} does not pass -R <nested repo>`);
  const reference = await readFile(join(PLUGIN, 'reference', 'conventions.md'), 'utf8');
  assert.ok(reference.includes('## Nested repo PRs'), 'the rule sits next to Docs PR');
  assert.match(reference, /whose `path` is the `docsRepo` path is skipped/);
});
