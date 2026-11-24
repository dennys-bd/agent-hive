import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forkConventions, nestedConventions } from '../src/mcp-conventions.js';
import type { Exec, Workspace } from '../src/types.js';
import { fakeWsl } from './fake-machine.js';
import { workspacesAt } from './fakes.js';

// hive_conventions of a worker on wsl:X (#932): the distro's git, its paths joined with / on every host
const URLS: Record<string, string> = { upstream: 'https://github.com/acme/app.git\n', origin: 'git@github.com:me/app.git\n' };
const APP: Workspace = { ...workspacesAt('/home/u/app')[0], name: 'app', machine: 'wsl:X', fork: { remote: 'upstream', pr: 'original' }, nestedRepos: ['docs'] };

test('a wsl:X worker\'s conventions read git through its machine and join a nested repo with posix paths (#932)', async () => {
  const calls: string[][] = [];
  const exec: Exec = async (_file, args) => {
    calls.push(args);
    if (args[1] === '/home/u/app/docs') return { stdout: 'https://github.com/acme/docs.git\n' };
    if (args.includes('get-url')) return { stdout: URLS[args.at(-1) ?? ''] ?? '' };
    return { stdout: args.includes('symbolic-ref') ? 'upstream/master\n' : '' };
  };
  const machine = fakeWsl('X', { exec });
  assert.deepEqual(await forkConventions(machine, APP, {}), { pr: 'original', original: 'acme/app', fork: 'me/app', baseRemote: 'upstream', base: 'master' });
  assert.deepEqual(await nestedConventions(machine, APP), [{ path: 'docs', repository: 'acme/docs' }]);
  assert.ok(calls.some((args) => args[1] === '/home/u/app/docs'), JSON.stringify(calls));
});
