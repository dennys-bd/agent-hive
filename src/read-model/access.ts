import { readCredentials } from '../credentials.js';
import type { Logger } from '../log.js';
import { gqlFor } from '../sources/github-gql.js';
import type { Credentials, Exec, GithubAuth, Gql } from '../types.js';
import { ghRest, ghRun, type GhRun, type RestGet } from './rest.js';
import { sourceOf } from './rows.js';

const GITHUB_HOST = 'github.com'; // the repository routes know no other host

/** Who reads, and through what (#180): the rows' source, the REST transport and the refetch's GraphQL, all as one login. */
export interface ReadAccess { source: string; rest: RestGet; gql: Gql }

export interface AccessDeps {
  exec: Exec; // gh config get, the cli transport's login
  log?: Logger; // gqlFor's debug lines
  credentials?: () => Promise<Credentials>; // tests inject; default the credential store
  run?: GhRun; // tests inject; default gh
}

// gh's login from its own config: no request. No gh, or no login, reads as none
async function ghLogin(exec: Exec): Promise<string> {
  return exec('gh', ['config', 'get', 'user', '--host', GITHUB_HOST]).then(({ stdout }) => stdout.trim(), () => '');
}

/** The read model's access for `auth.github` (#180). cli: gh's login and gh as is. api: the stored login; gh stays the REST transport, with the
 * stored token as GH_TOKEN in its env only. GraphQL through gqlFor, the one place that choice is made. No login: undefined. */
export async function accessFor(auth: GithubAuth, deps: AccessDeps): Promise<ReadAccess | undefined> {
  const run = deps.run ?? ghRun;
  const gql = gqlFor(auth, deps.log);
  if (auth === 'cli') {
    const login = await ghLogin(deps.exec);
    return login === '' ? undefined : { source: sourceOf(GITHUB_HOST, login), rest: ghRest(run), gql };
  }
  const { github } = await (deps.credentials ?? (() => readCredentials()))();
  if (github === undefined || github.token === '' || github.login === '') return undefined;
  return { source: sourceOf(GITHUB_HOST, github.login), rest: ghRest(run, { GH_TOKEN: github.token }), gql };
}
