import { expect, test } from 'vitest';
import { NO_BUILT_INS } from '../../src/template';
import { renderFor } from '@/lib/workspace-values';

test('renderFor gives a workspace its values and built-ins from the lint input, none for a name the read does not hold (#742)', () => {
  const builtIns = { fork: { remote: 'upstream', pr: 'ask' as const, baseRemote: 'upstream' }, baseBranch: 'develop', nestedRepos: ['docs'], gitlabHosts: ['gitlab.com'] };
  const values = { variables: { a: { x: 'y' } }, builtIns: { a: builtIns } };
  expect(renderFor(values, 'a')).toEqual({ name: 'a', variables: { x: 'y' }, builtIns });
  expect(renderFor(values, 'b')).toEqual({ name: 'b', variables: {}, builtIns: NO_BUILT_INS });
});
