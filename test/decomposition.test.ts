import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  anchorOf, CHECK_LINKS, decompositionPending, decompositionWritten, designComment, designLink, fileAddress, issueBody, parseDecomposition, recordedIssues, rootBody,
} from '../src/decomposition.js';
import { initialState } from '../src/orchestrator.js';
import type { DecompositionNode, DecompositionProblem, Task } from '../src/types.js';
import { createsIssues } from '../src/ui/lib/task-state.js';
import { EXAMPLE } from './fixtures/decomposition.js';
import { withWork } from './fixtures/work.js';

// decomposition.md as the Hive reads it (#865): the goal, the root's design, the nodes in file order, every problem at its line, and the
// bodies the issues get.

const F = '```';
const file = (...lines: string[]): string => lines.join('\n');
const LEAF = ['### Scope', 'In: a. Out: b.', '### Acceptance criteria', '- it works'];
const leaf = (id: string, title: string, extra: Partial<DecompositionNode>): DecompositionNode => ({
  id, title, body: '', scope: '', openPoints: [], criteria: [], delivers: [], consumes: [], blockedBy: [], touches: [], ...extra,
});
const ADDRESS = 'https://github.com/acme/docs/blob/main/agent/specs/2026-10-11-site-decomposition.md';

test('the spec\'s example parses with no problem: the goal without its mermaid view, the root\'s design, the nodes in order with every part; the suggestions are only counted (#865)', () => {
  const { decomposition, problems, suggestions } = parseDecomposition(EXAMPLE);
  assert.deepEqual([problems, suggestions], [[], 1]);
  assert.ok(decomposition);
  assert.deepEqual([decomposition.title, decomposition.goal], ['Site for XPTO', 'A marketing site with a contact form.']);
  assert.equal(decomposition.design, 'Static pages served by the CDN; one serverless function for the form. Errors as RFC 7807.');
  assert.deepEqual(decomposition.nodes, [
    leaf('1', 'Backend', { scope: "In: the form's endpoint and its storage. Out: any admin view.", design: 'Submissions are stored in a single table; no queue.' }),
    leaf('1.1', 'Submissions table', { scope: 'In: the table and its migration. Out: any read API.', criteria: ['the migration creates the table and `pnpm test` inserts and reads a row'], delivers: ['db.submissions'] }),
    leaf('1.2', 'Contact API', {
      scope: 'In: POST /contact with validation. Out: spam filtering.', openPoints: ['rate limit per IP or per session'],
      criteria: ['a valid POST /contact answers 201 and stores the row', 'an invalid one answers 400 with the RFC 7807 body'],
      delivers: ['api.contact'], consumes: ['db.submissions'], blockedBy: ['1.1'],
    }),
    leaf('2', 'Pages', { scope: "In: the site's pages. Out: a blog.", consumes: ['api.contact'], blockedBy: ['1'] }),
    leaf('2.1', 'Contact page', { scope: 'In: the form and its states. Out: other pages.', criteria: ['submitting the form shows the success state with the API mocked'], consumes: ['api.contact'], blockedBy: ['1.2'] }),
    leaf('2.2', 'Home page', { scope: 'In: the landing page. Out: the contact form.', criteria: ['the home page renders its hero and links to the contact page'] }),
  ]);
});

test('fenced blocks hide headings and markers; only the first mermaid block is dropped, any other stays in the text it sits in (#865)', () => {
  const { decomposition, problems } = parseDecomposition(file(
    '# G', 'goal text', `${F}mermaid`, 'graph TD', F,
    '## 1 A', `${F}mermaid`, 'kept', F, '### Scope', 'In: a.', `${F}md`, '## not a heading', 'Delivers: not.a.marker', F,
    '### Acceptance criteria', '- it works', '## 2 B', ...LEAF,
  ));
  assert.deepEqual(problems, []);
  assert.equal(decomposition?.goal, 'goal text');
  assert.deepEqual(decomposition?.nodes.map((n) => [n.body, n.scope, n.delivers]), [
    [`${F}mermaid\nkept\n${F}`, `In: a.\n${F}md\n## not a heading\nDelivers: not.a.marker\n${F}`, []],
    ['', 'In: a. Out: b.', []],
  ]);
});

const CASES: [string, string[], DecompositionProblem[]][] = [
  ['a duplicate id', ['# G', '## 1 A', ...LEAF, '## 1 B', ...LEAF], [{ line: 7, message: 'duplicate id "1"' }]],
  ['an absent parent', ['# G', '## 1.1 A', ...LEAF], [{ line: 2, message: 'parent "1" is absent' }]],
  ['a marker repeated, an id twice in a list', ['# G', '## 1 A', ...LEAF, '## 2 B', ...LEAF, 'Blocked by: 1, 1', 'Blocked by: 1'],
    [{ line: 12, message: '"1" repeated in "Blocked by:"' }, { line: 13, message: '"Blocked by:" repeated' }]],
  ['a subsection repeated', ['# G', '## 1 A', ...LEAF, '### Scope', 'again', '## 2 Z', ...LEAF], [{ line: 7, message: '"### Scope" repeated' }]],
  ['an empty title and a long one', ['# G', '## 1', ...LEAF, `## 2 ${'x'.repeat(201)}`, ...LEAF],
    [{ line: 2, message: 'the title must be 1 to 200 characters' }, { line: 7, message: 'the title must be 1 to 200 characters' }]],
  ['no scope', ['# G', '## 1 A', '### Acceptance criteria', '- it works', '## 2 Z', ...LEAF], [{ line: 2, message: 'no "### Scope"' }]],
  ['a leaf with no criteria and a design', ['# G', '## 1 A', '### Scope', 'In: a.', '### Design', 'one table', '## 2 Z', ...LEAF],
    [{ line: 2, message: 'a leaf needs "### Acceptance criteria"' }, { line: 5, message: 'a leaf has no "### Design": its decisions are open points' }]],
  ['a node with children holding open points and criteria', ['# G', '## 1 A', '### Scope', 'In: a.', '### Open points', '- which db', '### Acceptance criteria', '- it works', '## 1.1 B', ...LEAF, '## 1.2 Z', ...LEAF, '## 2 Y', ...LEAF], [
    { line: 5, message: 'a node with children has no "### Open points": a crossing decision belongs in its design' },
    { line: 7, message: 'a node with children has no "### Acceptance criteria"' },
  ]],
  ['a malformed contract and one delivered twice', ['# G', '## 1 A', ...LEAF, 'Delivers: api.login, Api.Bad', '## 2 B', ...LEAF, 'Delivers: api.login'],
    [{ line: 7, message: 'malformed contract id "Api.Bad"' }, { line: 13, message: '"api.login" is already delivered by 1' }]],
  ['blockers that name no node, the node itself, an ancestor or a descendant', ['# G', '## 1 A', '### Scope', 'In: a.', 'Blocked by: 1.1, 9', '## 1.1 B', ...LEAF, 'Blocked by: 1, 1.1', '## 1.2 Z', ...LEAF, '## 2 Y', ...LEAF], [
    { line: 5, message: 'blocked by its descendant "1.1"' }, { line: 5, message: 'blocked by "9", which is no node' },
    { line: 11, message: 'blocked by its ancestor "1"' }, { line: 11, message: 'blocked by itself' },
  ]],
  ['a cycle', ['# G', '## 1 A', ...LEAF, 'Blocked by: 2', '## 2 B', ...LEAF, 'Blocked by: 1'], [{ line: 13, message: 'this "Blocked by:" closes a cycle' }]],
  ['an unknown section, no title and no node', ['Some text', '## Notes', 'x'], [
    { line: 1, message: 'the goal has no "# " title' }, { line: 1, message: 'no nodes: the file has no "## <id> <title>" heading' },
    { line: 2, message: 'unknown section "## Notes"' },
  ]],
  ['an unknown subsection, text after a list and a fence left open', ['# G', '## 2 Z', ...LEAF, '## 1 A', '### Scope', 'In: a.', '### Acceptance criteria', '- it works', 'not an item', '### Notes', 'x', `${F}ts`, 'open'], [
    { line: 12, message: 'text after the list in "### Acceptance criteria"' }, { line: 13, message: 'unknown subsection "### Notes"' },
    { line: 15, message: 'fenced block left open' },
  ]],
  ['Touches: on a node with children, and paths that leave the repository', ['# G', '## 1 A', '### Scope', 'In: a.', 'Touches: src', '## 1.1 B', ...LEAF, 'Touches: ../x, /abs', '## 1.2 Z', ...LEAF, '## 2 Y', ...LEAF], [
    { line: 5, message: 'a node with children has no "Touches:": only a leaf touches files' },
    { line: 11, message: '"../x" in "Touches:" must be a relative path without ".."' },
    { line: 11, message: '"/abs" in "Touches:" must be a relative path without ".."' },
  ]],
  ['a node before its parent', ['# G', '## 1.1 B', ...LEAF, '## 1 A', '### Scope', 'In: a.', '## 1.2 Z', ...LEAF, '## 2 Y', ...LEAF],
    [{ line: 2, message: '"1.1" comes before its parent "1"' }]],
  ['a label over 50 characters, and a second Label: line', ['# G', `Label: ${'x'.repeat(51)}`, 'Label: b', '## 1 A', ...LEAF, '## 2 B', ...LEAF], [
    { line: 2, message: 'the label must be 1 to 50 characters' }, { line: 3, message: '"Label:" repeated' },
  ]],
];

test('Label: is a line of the goal\'s head, taken out of its text; Touches: lists a leaf\'s paths, a trailing / dropped (#936)', () => {
  const { decomposition, problems } = parseDecomposition(file('# G', 'Label: decomposed', 'goal text', '## 1 A', ...LEAF, 'Touches: src/a.ts, db/migrations/', '## 2 B', ...LEAF));
  assert.deepEqual(problems, []);
  assert.deepEqual([decomposition?.label, decomposition?.goal], ['decomposed', 'goal text']);
  assert.deepEqual(decomposition?.nodes.map((n) => n.touches), [['src/a.ts', 'db/migrations'], []]);
  assert.equal(parseDecomposition(EXAMPLE).decomposition?.label, undefined, 'no Label: line, no label');
});

test('Label: none, in any case, is no label; and it is never a length problem (#936)', () => {
  for (const value of ['none', 'None', 'NONE']) {
    const { decomposition, problems } = parseDecomposition(file('# G', `Label: ${value}`, '## 1 A', ...LEAF, '## 2 B', ...LEAF));
    assert.deepEqual([problems, decomposition?.label], [[], undefined], value);
  }
});

test('Touches: drops a leading ./, and an entry that is . or empty once normalised (#936)', () => {
  const { decomposition, problems } = parseDecomposition(file('# G', '## 1 A', ...LEAF, 'Touches: ./src/a.ts, ., ./, ././db/, src/', '## 2 B', ...LEAF));
  assert.deepEqual(problems, []);
  assert.deepEqual(decomposition?.nodes[0].touches, ['src/a.ts', 'db', 'src']);
});

test('a top-level node\'s Design: link has no anchor when the goal has no "## Design" (#936)', () => {
  const { decomposition } = parseDecomposition(file('# G', '## 1 A', ...LEAF, '## 2 B', ...LEAF));
  assert.ok(decomposition);
  assert.equal(designLink(decomposition, decomposition.nodes[0], ADDRESS), ADDRESS);
});

test('every problem is reported at its line, and a file with one returns no tree (#865)', () => {
  for (const [name, lines, expected] of CASES) {
    const parsed = parseDecomposition(file(...lines));
    assert.deepEqual(parsed.problems, expected, name);
    assert.equal(parsed.decomposition, undefined, name);
  }
});

test('GitHub\'s limits are problems before anything is written: more than 8 levels, more than 100 children under one parent (#865)', () => {
  const chain = Array.from({ length: 9 }, (_, k) => Array.from({ length: k + 1 }, () => '1').join('.'));
  const deep = ['# G', ...chain.slice(0, 8).flatMap((id) => [`## ${id} N`, '### Scope', 'In: a.']), `## ${chain[8]} N`, ...LEAF];
  // a sibling leaf for every level, appended so the lines of the chain stay put
  const siblings = ['2', ...chain.slice(0, 8).map((id) => `${id}.2`)].flatMap((id) => [`## ${id} S`, ...LEAF]);
  assert.deepEqual(parseDecomposition(file(...deep, ...siblings)).problems, [
    { line: 26, message: 'more than 8 levels below the goal' }, { line: 71, message: 'more than 8 levels below the goal' }, // the level-9 sibling of the chain's last node
  ]);
  const wide = ['# G', ...Array.from({ length: 101 }, (_, k) => [`## ${k + 1} N`, ...LEAF]).flat()];
  assert.deepEqual(parseDecomposition(file(...wide)).problems, [{ line: 502, message: 'more than 100 children under the goal' }]);
});

test('a node or the goal split into a single child is a problem: one child is the parent\'s own work, so it stays a leaf', () => {
  const single = ['# G', '## 1 A', '### Scope', 'In: a.', '## 1.1 B', ...LEAF, '## 2 C', ...LEAF];
  assert.deepEqual(parseDecomposition(file(...single)).problems, [{ line: 2, message: '"1" has a single child: split it into two or more, or keep it a leaf' }]);
  const lone = ['# G', '## 1 A', ...LEAF];
  assert.deepEqual(parseDecomposition(file(...lone)).problems, [{ line: 1, message: 'the goal has a single node: split it into two or more, or the goal is a leaf itself' }]);
});

test('issueBody: free text, Scope, Design (inner) or Acceptance criteria (leaf), then one ## Decomposition block with only the lines it has (#936)', () => {
  const { decomposition } = parseDecomposition(EXAMPLE);
  assert.ok(decomposition);
  const [backend, , api] = decomposition.nodes;
  assert.equal(issueBody(backend, { parent: 7, design: `${ADDRESS}#design` }), [
    "## Scope\n\nIn: the form's endpoint and its storage. Out: any admin view.",
    '## Design\n\nSubmissions are stored in a single table; no queue.',
    `## Decomposition\n\nParent: #7\nDesign: ${ADDRESS}#design`,
  ].join('\n\n'));
  const feasibility = "feasibility: the CDN's edge function accepts a POST body over 10 KB";
  const touched = { ...api, touches: ['functions/contact.ts', 'db/migrations'], openPoints: [...api.openPoints, feasibility] };
  assert.equal(issueBody(touched, { parent: 101, design: `${ADDRESS}#1-backend` }), [
    '## Scope\n\nIn: POST /contact with validation. Out: spam filtering.',
    '## Acceptance criteria\n\n- a valid POST /contact answers 201 and stores the row\n- an invalid one answers 400 with the RFC 7807 body',
    [
      '## Decomposition', '', 'Parent: #101', `Design: ${ADDRESS}#1-backend`, 'Delivers: api.contact', 'Consumes: db.submissions',
      'Touches: functions/contact.ts, db/migrations', 'Open points:', '- rate limit per IP or per session', `- ${feasibility}`,
    ].join('\n'),
  ].join('\n\n'));
  assert.equal(issueBody({ ...api, body: 'Why it exists.' }, { parent: 1, design: ADDRESS }).split('\n\n')[0], 'Why it exists.');
  const design = '## Design\n\nStatic pages served by the CDN; one serverless function for the form. Errors as RFC 7807.';
  assert.equal(rootBody(decomposition), `A marketing site with a contact form.\n\n${design}`);
  assert.equal(designComment(decomposition), design);
  assert.equal(rootBody({ ...decomposition, design: undefined }), 'A marketing site with a contact form.');
});

test('anchorOf is GitHub\'s heading slug; designLink points at the parent\'s heading, or #design for a top-level node (#936)', () => {
  assert.equal(anchorOf('1.2 Contact API'), '12-contact-api');
  assert.equal(anchorOf('Design'), 'design');
  assert.equal(anchorOf("2 Pages & the user's flow_x"), '2-pages--the-users-flow_x');
  assert.equal(fileAddress('acme/docs', 'main', 'agent/specs/2026-10-11-site xpto-decomposition.md'), 'https://github.com/acme/docs/blob/main/agent/specs/2026-10-11-site%20xpto-decomposition.md');
  const { decomposition } = parseDecomposition(EXAMPLE);
  assert.ok(decomposition);
  assert.equal(designLink(decomposition, decomposition.nodes[2], ADDRESS), `${ADDRESS}#1-backend`);
  assert.equal(designLink(decomposition, decomposition.nodes[0], ADDRESS), `${ADDRESS}#design`);
});

test('the result says whether the write is pending: a decomposition path with no done recorded; recorded keys keep integer numbers only (#865)', () => {
  assert.equal(decompositionPending(undefined), false);
  assert.equal(decompositionPending({ spec: 'docs/x.md' }), false);
  assert.equal(decompositionPending({ decomposition: 'decomposition.md' }), true);
  assert.equal(decompositionPending({ decomposition: 'decomposition.md', decompositionIssues: { design: 7, '1': 12 } }), true, 'midway');
  assert.equal(decompositionPending({ decomposition: 'decomposition.md', decompositionIssues: { done: 7 } }), false);
  assert.equal(decompositionWritten({ decompositionIssues: { done: 7 } }), true);
  assert.deepEqual(recordedIssues({ decompositionIssues: { '1': 4, x: 'y', '2': 1.5, done: 9 } }), { '1': 4, done: 9 });
  assert.deepEqual(recordedIssues({ decompositionIssues: [1] }), {});
});

test('createsIssues: a decomposition not on GitHub with a source to write it to; not once written, nor with no source (#865)', () => {
  const task: Task = { item: { itemId: 'board:I1', id: '1', title: 'Site', body: '', url: 'https://github.com/acme/site/issues/1', source: 'board' }, stage: 'goal', boardColumn: 'Goals', auto: true };
  const approval = { since: '2026-10-09T10:00:00.000Z' };
  const pending = withWork({ ...initialState(0), tasks: [task], syncs: { board: {} } }, 'board:I1', { approval }, { result: { decomposition: 'decomposition.md' } });
  assert.equal(createsIssues(task, pending), true);
  assert.equal(createsIssues(task, { ...pending, syncs: {} }), false);
  const written = withWork(pending, 'board:I1', { approval }, { result: { decomposition: 'decomposition.md', decompositionIssues: { done: 1 } } });
  assert.equal(createsIssues(task, written), false);
});

test('more than 300 nodes is a problem at the first one over (#865)', () => {
  const nodes = Array.from({ length: 301 }, (_, i) => file(`## ${i + 1} N`, ...LEAF)).join('\n');
  const { problems, decomposition } = parseDecomposition(`# G\n${nodes}`);
  const over = problems.filter((p) => p.message.startsWith('more than 300 nodes'));
  assert.deepEqual([over.length, over[0]?.line, decomposition], [1, 1 + 301 * 5 - 4, undefined]);
});

test('an issue body, the root body or the design comment over 65,536 characters is a problem at its node, the title or the design (#865)', () => {
  const big = 'x'.repeat(65_536);
  const node = parseDecomposition(file('# G', '## 1 A', '### Scope', big, '### Acceptance criteria', '- ok', '## 2 B', ...LEAF)).problems;
  assert.deepEqual(node, [{ line: 2, message: 'the issue body is over 65536 characters' }]);
  const goal = parseDecomposition(file('# G', `${big}x`, '## 1 A', ...LEAF, '## 2 B', ...LEAF)).problems;
  assert.deepEqual(goal, [{ line: 1, message: 'the goal issue body is over 65536 characters' }]);
  const design = parseDecomposition(file('# G', '## Design', big, '## 1 A', ...LEAF, '## 2 B', ...LEAF)).problems;
  assert.deepEqual(design, [{ line: 2, message: 'the design comment is over 65536 characters' }]);
  // the parse renders each body with room for the parent's number and the link it cannot know yet
  const room = 65_536 - (issueBody(leaf('1', 'A', { scope: 'x', criteria: ['ok'] }), CHECK_LINKS).length - 1);
  const exactly = parseDecomposition(file('# G', '## 1 A', '### Scope', 'x'.repeat(room), '### Acceptance criteria', '- ok', '## 2 B', ...LEAF));
  assert.deepEqual(exactly.problems, []);
});
