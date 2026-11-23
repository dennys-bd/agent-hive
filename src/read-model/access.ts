import { refusalOf, type SelectedGithub } from '../github-account.js';
import { GITHUB_HOST, type GhToken } from '../github-token.js';
import type { Logger } from '../log.js';
import { gqlFor } from '../sources/github-gql.js';
import type { GithubAuth, Gql } from '../types.js';
import { httpRest, type RestGet } from './rest.js';
import { sourceOf } from './rows.js';

/** Who reads, and through what (#180): the rows' source, the REST transport and the refetch's GraphQL, all as one login. */
export interface ReadAccess { source: string; rest: RestGet; gql: Gql }

export interface AccessDeps {
  ghToken: GhToken | SelectedGithub; // #959: the account's selected login; gh's bare holder reads as gh's login
  log?: Logger; // gqlFor's debug lines
  fetch?: typeof fetch; // tests inject; default Node's
}

/** The read model's access (#180, #503, #959): the selected login's rows, REST and GraphQL, in cli and api alike. No login: undefined. */
export async function accessFor(auth: GithubAuth, deps: AccessDeps): Promise<ReadAccess | undefined> {
  const { ghToken, log, fetch } = deps;
  const login = await ghToken.login();
  if (login === '') return undefined;
  const rest = httpRest({ token: ghToken.token, onUnauthorized: ghToken.invalidate, refusal: refusalOf(ghToken), fetch });
  return { source: sourceOf(GITHUB_HOST, login), rest, gql: gqlFor(auth, { log, ghToken, fetch }) };
}
