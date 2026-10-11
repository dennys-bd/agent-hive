import { execFile } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs, promisify } from 'node:util';
import { parseConfig, readConfig, workspaceScope } from '../../src/config.js';
import { hiveHome } from '../../src/home.js';
import { openReadModel } from '../../src/read-model/db.js';
import { syncRepository } from '../../src/read-model/loop.js';
import { sourceOf } from '../../src/read-model/open.js';
import { ghRest, type RestGet, type RestQuota } from '../../src/read-model/rest.js';
import { listRepositories } from '../../src/repos/repositories.js';
import { cliGqlJson } from '../../src/sources/github-gql.js';
import { VIEWER, type ViewerData } from '../../src/sources/github-queries.js';
import { loadState } from '../../src/state-store.js';
import type { Exec } from '../../src/types.js';
import { graphqlArm } from './graphql-arm.js';

// #765: the hybrid sync against GraphQL alone over the same window, on the repositories the Hive lists. Run with the Hive stopped, so its
// own sync does not share the window; x-ratelimit-used still counts every other use of the login (a worker's gh), the 200/304 counts do not.
const execFileAsync: Exec = promisify(execFile);
const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60_000;

interface RestTally { ok: number; notModified: number; first?: RestQuota; last?: RestQuota }

// Every answer counted as it comes: its status, and the first and the last quota reading
function counting(rest: RestGet): { rest: RestGet; tally(): RestTally } {
  let tally: RestTally = { ok: 0, notModified: 0 };
  const counted: RestGet = async (path, etag) => {
    const answer = await rest(path, etag);
    tally = {
      ok: tally.ok + (answer.status === 200 ? 1 : 0), notModified: tally.notModified + (answer.status === 304 ? 1 : 0),
      first: tally.first ?? answer.quota, last: answer.quota ?? tally.last,
    };
    return answer;
  };
  return { rest: counted, tally: () => tally };
}

async function hybridArm(repositories: string[], source: string, rounds: number, intervalMs: number): Promise<{ fill: RestTally; total: RestTally; errors: number }> {
  const counted = counting(ghRest());
  const deps = { db: openReadModel(':memory:'), rest: counted.rest, source, now: () => new Date() };
  let fill: RestTally | undefined;
  let errors = 0;
  for (let round = 0; round < rounds; round++) {
    const started = Date.now();
    for (const repository of repositories) {
      try {
        await syncRepository(deps, repository, false);
      } catch {
        errors += 1;
      }
    }
    fill ??= counted.tally();
    await sleep(Math.max(0, intervalMs - (Date.now() - started)));
  }
  return { fill: fill ?? counted.tally(), total: counted.tally(), errors };
}

async function listedRepositories(home: string): Promise<string[]> {
  const raw = await readConfig(home);
  if (raw === undefined) throw new Error('no hive.config.json in the Hive home');
  const config = parseConfig(raw);
  const state = await loadState(home, workspaceScope(config));
  return (await listRepositories(config, state, execFileAsync)).map((ref) => ref.repository);
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { minutes: { type: 'string', default: '60' }, interval: { type: 'string', default: '60' } } });
  const minutes = Number(values.minutes ?? '60');
  const intervalMs = Number(values.interval ?? '60') * MS_PER_SECOND;
  if (!(minutes > 0) || !(intervalMs > 0)) throw new Error('usage: node dist/scripts/spike/measure.js [--minutes 60] [--interval 60]');
  const rounds = Math.ceil((minutes * MS_PER_MINUTE) / intervalMs);
  const repositories = await listedRepositories(hiveHome());
  const gql = cliGqlJson();
  const login = ((await gql(VIEWER, {})) as ViewerData | null)?.viewer?.login;
  if (!login) throw new Error('gh answered no login');
  const hybrid = await hybridArm(repositories, sourceOf(login), rounds, intervalMs);
  const graphql = await graphqlArm(gql, repositories, rounds, intervalMs);
  process.stdout.write(`${JSON.stringify({ minutes, intervalSeconds: intervalMs / MS_PER_SECOND, repositories: repositories.length, rounds, hybrid, graphql }, null, 2)}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
