import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createServer } from '../src/server.js';
import { tempHive } from './fakes.js';
import { hiveFetch, SECRET } from './secret-client.js';

// GET /settings/nested-repos (#653): what the card shows, read with the real git on a folder not saved yet.

const run = promisify(execFile);

test('GET /settings/nested-repos reads each listed path (its repository and base, or its problem) and suggests the ignored repositories not listed; a folder that is not a repository\'s top level is 400 (#653)', async (t) => {
  const { home, repo } = await tempHive(t);
  await writeFile(join(repo, '.gitignore'), 'docs/\nsite/\n');
  for (const [path, url] of [['docs', 'https://github.com/acme/docs.git'], ['site', 'git@github.com:acme/site.git']] as const) {
    await run('git', ['-C', repo, 'init', '--quiet', path]);
    await run('git', ['-C', join(repo, path), 'remote', 'add', 'origin', url]);
  }
  await mkdir(join(repo, 'docs', 'agent'));
  const server = createServer({ secret: SECRET, home, exec: async () => ({ stdout: '' }) });
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}/settings/nested-repos`;
  const read = await hiveFetch(`${base}?${new URLSearchParams({ path: repo, repos: 'docs,docs/agent' })}`);
  assert.deepEqual(await read.json(), {
    repos: [{ path: 'docs', repository: 'acme/docs', base: 'origin/main' }, { path: 'docs/agent', problem: { cause: 'notTopLevel', root: 'docs' } }],
    suggested: [{ path: 'site', repository: 'acme/site' }],
  });
  assert.equal((await hiveFetch(`${base}?${new URLSearchParams({ path: 'relative' })}`)).status, 400);
  assert.equal((await hiveFetch(base)).status, 400);
});
