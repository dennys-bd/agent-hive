import { readCredentials } from '../credentials.js';
import { GITHUB_HOST, type GhToken } from '../github-token.js';
import type { Logger } from '../log.js';
import { gqlFor } from '../sources/github-gql.js';
import type { Credentials, GithubAuth, Gql } from '../types.js';
import { httpRest, type RestGet } from './rest.js';
import { sourceOf } from './rows.js';

/** Who reads, and through what (#180): the rows' source, the REST transport and the refetch's GraphQL, all as one login. */
export interface ReadAccess { source: string; rest: RestGet; gql: Gql }

export interface AccessDeps {
  ghToken: GhToken; // cli (#503): gh's login from hosts.yml and its token, held once per daemon
  log?: Logger; // gqlFor's debug lines
  credentials?: () => Promise<Credentials>; // tests inject; default the credential store
  fetch?: typeof fetch; // tests inject; default Node's
}

/** The read model's access for `auth.github` (#180, #503). cli: hosts.yml's login, and gh's token over HTTP. api: the stored login and token
 * over HTTP. GraphQL through gqlFor, the one place that choice is made. No login: undefined. */
export async function accessFor(auth: GithubAuth, deps: AccessDeps): Promise<ReadAccess | undefined> {
  const { ghToken, log, fetch } = deps;
  if (auth === 'cli') {
    const login = await ghToken.login();
    if (login === '') return undefined;
    return { source: sourceOf(GITHUB_HOST, login), rest: httpRest({ token: ghToken.token, onUnauthorized: ghToken.invalidate, fetch }), gql: gqlFor('cli', { log, ghToken, fetch }) };
  }
  const { github } = await (deps.credentials ?? (() => readCredentials()))();
  if (github === undefined || github.token === '' || github.login === '') return undefined;
  return { source: sourceOf(GITHUB_HOST, github.login), rest: httpRest({ token: async () => github.token, fetch }), gql: gqlFor('api', { log, fetch }) };
}
