import { afterEach, expect, test, vi } from 'vitest';
import { groupByPhrase, relationChoices } from '@/lib/relation-groups';
import { editRelation, readRelationTypes } from '@/lib/relations-api';
import type { Relation, RelationChange } from '../../src/types';

const CHANGE: RelationChange = { action: 'add', type: 'Relates', direction: 'outward', ref: 'ABC-2' };
const rel = (id: string, phrase: string): Relation => ({ id, title: `Issue ${id}`, state: 'open', type: 'T', direction: 'outward', phrase });
const answer = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => { vi.restoreAllMocks(); });

test('editRelation posts the change to the item\'s relations route and answers its relations; a refusal rejects with the route\'s code (#829)', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(answer({ relations: [rel('ABC-2', 'relates to')] }))
    .mockResolvedValueOnce(answer({ error: 'no such item or task to relate', code: 'blockers.unknownRef' }, 404));
  expect(await editRelation('tickets', 'tickets:10001', CHANGE)).toEqual([rel('ABC-2', 'relates to')]);
  expect(fetchMock.mock.calls[0]?.[0]).toBe('/sources/tickets/items/tickets%3A10001/relations');
  expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual(CHANGE);
  await expect(editRelation('tickets', 'tickets:10001', CHANGE)).rejects.toMatchObject({ status: 404, code: 'blockers.unknownRef' });
});

test('readRelationTypes asks the source\'s link types with relations=1 (#829)', async () => {
  const types = [{ name: 'Relates', inward: 'relates to', outward: 'relates to' }];
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(answer({ linkTypes: types }));
  expect(await readRelationTypes('tickets')).toEqual(types);
  expect(fetchMock.mock.calls[0]?.[0]).toBe('/sources/tickets/link-types?relations=1');
});

test('groupByPhrase keeps each phrase\'s first-seen order and every relation under it; relationChoices offers each type per direction, a same-phrase type once (#829)', () => {
  const groups = groupByPhrase([rel('ABC-2', 'relates to'), rel('ABC-3', 'clones'), rel('ABC-4', 'relates to')]);
  expect(groups.map((g) => [g.phrase, g.relations.map((r) => r.id)])).toEqual([['relates to', ['ABC-2', 'ABC-4']], ['clones', ['ABC-3']]]);
  expect(groupByPhrase([])).toEqual([]);
  expect(relationChoices([{ name: 'Relates', inward: 'relates to', outward: 'relates to' }, { name: 'Cloners', inward: 'is cloned by', outward: 'clones' }])).toEqual([
    { type: 'Relates', direction: 'outward', phrase: 'relates to' },
    { type: 'Cloners', direction: 'outward', phrase: 'clones' },
    { type: 'Cloners', direction: 'inward', phrase: 'is cloned by' },
  ]);
});
