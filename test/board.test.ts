import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBoard, listProjects, listStatusOptions } from '../src/board.js';
import { parseConfig } from '../src/config.js';

const config = parseConfig({ project: { owner: 'acme', number: 6 } });

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
  const board = createBoard(config, exec);
  await board.resolveFields();
  await board.setStatus('ITEM_1', 'review');
  const edit = calls.find((c) => c[1] === 'item-edit');
  assert.deepEqual(edit, ['project', 'item-edit', '--id', 'ITEM_1', '--project-id', 'PVT_1', '--field-id', 'F_status', '--single-select-option-id', 'O_rev']);
  for (const c of calls.filter((c) => c[1] !== 'item-edit')) assert.ok(c.includes('--owner') && c.includes('acme'), c.join(' '));
});

test('resolveFields fails naming the missing option and listing the available ones', async () => {
  const bad = parseConfig({ project: { owner: 'acme', number: 6 }, status: { queue: 'Todo' } });
  const board = createBoard(bad, fakeExec({ 'project view 6': { id: 'PVT_1' }, 'project field-list 6': fields }).exec);
  await assert.rejects(board.resolveFields(), /"Todo".*Ready, In progress, In review, Done/s);
});

test('setStatus before resolveFields throws', async () => {
  const board = createBoard(config, fakeExec({}).exec);
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
  const board = createBoard(config, fakeExec({ 'project item-list 6': items }).exec);
  const queue = await board.listQueue();
  assert.deepEqual(queue, [
    { itemId: 'I1', number: 1, title: 'A', body: 'a', url: 'https://github.com/acme/r/issues/1' },
    { itemId: 'I4', number: 4, title: 'C', body: '', url: 'https://github.com/acme/r/issues/4' },
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
