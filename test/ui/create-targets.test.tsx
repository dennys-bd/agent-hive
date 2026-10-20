import { expect, test } from 'vitest';
import { createTargetsOf, destinations } from '@/lib/create-targets';

test('createTargetsOf keeps every source with a repository, with its type; destinations puts the default first and lists hive only while it is on (#846, #893)', () => {
  const targets = createTargetsOf({ sources: [{ name: 'roadmap', type: 'github', repository: 'me/site' }, { name: 'bare', type: 'github' }], createIn: 'roadmap' });
  expect(targets).toEqual({ hiveSource: true, createIn: 'roadmap', sources: [{ name: 'roadmap', type: 'github' }] });
  expect(destinations(targets)).toEqual([{ name: 'roadmap', type: 'github' }, { name: 'hive' }]);
  expect(destinations({ ...targets, hiveSource: false })).toEqual([{ name: 'roadmap', type: 'github' }]);
  expect(destinations({ hiveSource: true, createIn: 'hive', sources: [] })).toEqual([{ name: 'hive' }]);
});
