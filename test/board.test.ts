import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBoard } from '../src/board.js';
import { listProjects, listStatusOptions } from '../src/boards/github.js';
import { parseConfig } from '../src/config.js';

const REPO = '/repo'; // the github adapter never reads it

const config = parseConfig({ board: { type: 'github', owner: 'acme', number: 6 } });

function fakeExec(responses: Record<string, unknown>) {
  const calls: string[][] = [];
  const exec = async (args: string[]) => {
    calls.push(args);
    const key = args.slice(0, 3).join(' ');
    if (!(key in responses)) throw new Error(`unexpected gh call: ${args.join(' ')}`);
    const value = responses[key];
    return typeof value === 'string' ? value : JSON.stringify(value);
  };
  return { calls, exec };
}

const fields = {
  fields: [
    { id: 'F_title', name: 'Title', type: 'ProjectV2Field' },
    { id: 'F_status', name: 'Status', type: 'ProjectV2SingleSelectField',
      options: [{ id: 'O_ready', name: 'Ready' }, { id: 'O_prog', name: 'In progress' }, { id: 'O_rev', name: 'In review' }, { id: 'O_done', name: 'Done' }] },
  ],
};

test('resolveFields maps configured status names to option ids and stores the project id', async () => {
  const { exec, calls } = fakeExec({
    'project view 6': { id: 'PVT_1' },
    'project field-list 6': fields,
    'project item-edit --id': '',
  });
  const board = createBoard(config, { repo: REPO, exec });
  await board.resolveFields();
  await board.setStatus('ITEM_1', 'review');
  const edit = calls.find((c) => c[1] === 'item-edit');
  assert.deepEqual(edit, ['project', 'item-edit', '--id', 'ITEM_1', '--project-id', 'PVT_1', '--field-id', 'F_status', '--single-select-option-id', 'O_rev']);
  for (const c of calls.filter((c) => c[1] !== 'item-edit')) assert.ok(c.includes('--owner') && c.includes('acme'), c.join(' '));
});

test('resolveFields fails naming the missing option and listing the available ones', async () => {
  const bad = parseConfig({ board: { type: 'github', owner: 'acme', number: 6 }, status: { queue: 'Todo' } });
  const board = createBoard(bad, { repo: REPO, exec: fakeExec({ 'project view 6': { id: 'PVT_1' }, 'project field-list 6': fields }).exec });
  await assert.rejects(board.resolveFields(), /"Todo".*Ready, In progress, In review, Done/s);
});

test('setStatus before resolveFields throws', async () => {
  const board = createBoard(config, { repo: REPO, exec: fakeExec({}).exec });
  await assert.rejects(board.setStatus('x', 'queue'), /not resolved/);
});

test('listQueue returns only issues in the queue column, in board order', async () => {
  const items = {
    items: [
      { id: 'I1', status: 'Ready', title: 'A', content: { type: 'Issue', number: 1, title: 'A', body: 'a', url: 'https://github.com/acme/r/issues/1' } },
      { id: 'I2', status: 'In progress', title: 'B', content: { type: 'Issue', number: 2, title: 'B', body: 'b', url: 'https://github.com/acme/r/issues/2' } },
      { id: 'I3', status: 'Ready', title: 'Draft', content: { type: 'DraftIssue', title: 'Draft', body: '' } },
      { id: 'I4', status: 'Ready', title: 'C', content: { type: 'Issue', number: 4, title: 'C', body: null, url: 'https://github.com/acme/r/issues/4' } },
      { id: 'I5', title: 'No status', content: { type: 'Issue', number: 5, title: 'E', body: '', url: 'https://github.com/acme/r/issues/5' } },
    ],
  };
  const board = createBoard(config, { repo: REPO, exec: fakeExec({ 'project item-list 6': items, 'api graphql -f': { data: {} } }).exec });
  const queue = await board.listQueue();
  assert.deepEqual(queue, [
    { itemId: 'I1', id: '1', title: 'A', body: 'a', url: 'https://github.com/acme/r/issues/1' },
    { itemId: 'I4', id: '4', title: 'C', body: '', url: 'https://github.com/acme/r/issues/4' },
  ]);
});

test('listProjects lists only open projects as { number, title, url }', async () => {
  const { exec, calls } = fakeExec({
    'project list --owner': {
      projects: [
        { id: 'PVT_1', number: 6, title: 'Roadmap', url: 'https://github.com/users/acme/projects/6', closed: false },
        { id: 'PVT_0', number: 2, title: 'Antigo', url: 'https://github.com/users/acme/projects/2', closed: true },
      ],
      totalCount: 2,
    },
  });
  assert.deepEqual(await listProjects('acme', exec), [
    { number: 6, title: 'Roadmap', url: 'https://github.com/users/acme/projects/6' },
  ]);
  assert.deepEqual(calls[0], ['project', 'list', '--owner', 'acme', '--limit', '100', '--format', 'json']);
});

test('listStatusOptions returns the Status option names in board order without resolveFields', async () => {
  const { exec, calls } = fakeExec({ 'project field-list 6': fields });
  assert.deepEqual(await listStatusOptions('acme', 6, exec), ['Ready', 'In progress', 'In review', 'Done']);
  assert.deepEqual(calls[0], ['project', 'field-list', '6', '--owner', 'acme', '--format', 'json']);
});

test('listStatusOptions fails when the board has no single-select Status field', async () => {
  const { exec } = fakeExec({ 'project field-list 6': { fields: [{ id: 'F_title', name: 'Title', type: 'ProjectV2Field' }] } });
  await assert.rejects(listStatusOptions('acme', 6, exec), /"Status"/);
});

test('setupOptions on a github board lists the Status option names in board order', async () => {
  const { exec, calls } = fakeExec({ 'project field-list 6': fields });
  assert.deepEqual(await createBoard(config, { repo: REPO, exec }).setupOptions(), ['Ready', 'In progress', 'In review', 'Done']);
  assert.equal(calls.length, 1);
});

test('createBoard picks the markdown adapter by type and resolves the path against the repo', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'hive-'));
  await writeFile(join(repo, 'board.md'), '| id | título | status |\n|---|---|---|\n| T-1 | Exemplo | Ready |\n');
  const board = createBoard(parseConfig({ board: { type: 'markdown', path: 'board.md' } }), { repo });
  await board.resolveFields();
  assert.deepEqual((await board.listQueue()).map((t) => [t.id, t.url]), [['T-1', join(repo, 'board.md')]]);
});

const issue = (n: number, status = 'Ready') => ({
  id: `I${n}`, status, title: `T${n}`,
  content: { type: 'Issue', number: n, title: `T${n}`, body: '', url: `https://github.com/acme/r/issues/${n}` },
});
const relations = (blockedBy: [number, string][], subIssues: [number, string][] = []) => ({
  issue: {
    blockedBy: { nodes: blockedBy.map(([number, state]) => ({ number, state })) },
    subIssues: { nodes: subIssues.map(([number, state]) => ({ number, state })) },
  },
});

test('listQueue resolves open blockers with one graphql call, one alias per queued issue, OPEN only and deduped', async () => {
  const { exec, calls } = fakeExec({
    'project item-list 6': { items: [issue(1), issue(2, 'In progress'), issue(3), issue(4)] },
    'api graphql -f': {
      data: {
        i0: relations([[7, 'OPEN'], [8, 'CLOSED']], [[7, 'OPEN'], [9, 'OPEN']]),
        i1: relations([[10, 'CLOSED']], [[11, 'CLOSED']]),
        i2: relations([], []),
      },
    },
  });
  const queue = await createBoard(config, { repo: REPO, exec }).listQueue();
  assert.deepEqual(queue.map((t) => [t.id, t.blockedBy]), [['1', ['7', '9']], ['3', undefined], ['4', undefined]]);
  assert.ok(!('blockedBy' in queue[1]), 'field omitted when there is no open blocker');
  const graphql = calls.filter((c) => c[0] === 'api');
  assert.equal(graphql.length, 1);
  assert.deepEqual(graphql[0].slice(0, 3), ['api', 'graphql', '-f']);
  const query = graphql[0][3];
  assert.match(query, /^query=query \{ i0: repository\(owner: "acme", name: "r"\) \{ issue\(number: 1\) \{ blockedBy\(first: 50\) \{ nodes \{ number state \} \} subIssues\(first: 50\) \{ nodes \{ number state \} \} \} \} i1: /);
  assert.match(query, /i1: repository\(owner: "acme", name: "r"\) \{ issue\(number: 3\)/);
  assert.match(query, /i2: repository\(owner: "acme", name: "r"\) \{ issue\(number: 4\)/);
  assert.ok(!query.includes('i3:'), 'no alias for issues outside the queue column');
});

test('listQueue with nothing in the queue column makes no graphql call', async () => {
  const { exec, calls } = fakeExec({ 'project item-list 6': { items: [issue(2, 'In progress')] } });
  assert.deepEqual(await createBoard(config, { repo: REPO, exec }).listQueue(), []);
  assert.deepEqual(calls.map((c) => c[1]), ['item-list']);
});

test('listQueue treats issue: null, a null repository or a missing alias as no blockers', async () => {
  const { exec, calls } = fakeExec({
    'project item-list 6': { items: [issue(1), issue(2), issue(3)] },
    'api graphql -f': { data: { i0: { issue: null }, i1: null } },
  });
  const queue = await createBoard(config, { repo: REPO, exec }).listQueue();
  assert.deepEqual(queue.map((t) => t.blockedBy), [undefined, undefined, undefined]);
  assert.equal(calls.filter((c) => c[0] === 'api').length, 1);
});

test('quota reads gh api rate_limit for the graphql resource and converts reset (epoch seconds) to ISO', async () => {
  const { exec, calls } = fakeExec({ 'api rate_limit --jq': { limit: 5000, used: 680, remaining: 4320, reset: 1789563600 } });
  const before = Date.now();
  const quota = await createBoard(config, { repo: REPO, exec }).quota!();
  assert.deepEqual(calls, [['api', 'rate_limit', '--jq', '.resources.graphql']]);
  assert.equal(quota?.limit, 5000);
  assert.equal(quota?.remaining, 4320);
  assert.equal(quota?.resetsAt, '2026-09-16T13:00:00.000Z');
  assert.ok(quota && Date.parse(quota.at) >= before && Date.parse(quota.at) <= Date.now(), 'at is when it was read');
});

test('quota is undefined for an unexpected shape, and a markdown board has no quota at all', async () => {
  const shapes: unknown[] = [
    null, 5, {}, { limit: '5000', remaining: 1, reset: 1789563600 }, { limit: 5000, remaining: 1 },
    { limit: 5000, remaining: 1, reset: 'soon' }, { limit: 5000, remaining: null, reset: 1789563600 },
  ];
  for (const shape of shapes) {
    const { exec } = fakeExec({ 'api rate_limit --jq': shape });
    assert.equal(await createBoard(config, { repo: REPO, exec }).quota!(), undefined, JSON.stringify(shape));
  }
  await assert.rejects(createBoard(config, { repo: REPO, exec: fakeExec({}).exec }).quota!(), /unexpected gh call/, 'a failing gh rejects: the server logs it');
  assert.equal(createBoard(parseConfig({ board: { type: 'markdown', path: 'board.md' } }), { repo: REPO }).quota, undefined);
});
