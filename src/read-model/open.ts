import { join } from 'node:path';
import type { Logger } from '../log.js';
import { cliGqlJson } from '../sources/github-gql.js';
import { VIEWER, type ViewerData } from '../sources/github-queries.js';
import { openReadModel, READ_MODEL_FILE, type ReadModel } from './db.js';

/** The data's origin (#765): provider, host and login, so two accounts, or a GitHub Enterprise host whose ids may collide, never read each
 * other's rows. github.com only: the repository routes know no other host. */
export const sourceOf = (login: string): string => `github:github.com:${login}`;

/** The daemon's read model (#765): `<home>/read-model.sqlite`, opened under the hive.lock bootHive already holds, for gh's login, the one
 * the repository routes read and write with. Any failure leaves none, and the routes then read GitHub as before. */
export async function openDaemonReadModel(home: string, log: Pick<Logger, 'error'>): Promise<{ db: ReadModel; source: string } | undefined> {
  try {
    const login = ((await cliGqlJson()(VIEWER, {})) as ViewerData | null)?.viewer?.login;
    if (!login) throw new Error('gh answered no login');
    return { db: openReadModel(join(home, READ_MODEL_FILE)), source: sourceOf(login) };
  } catch (err) {
    log.error(`read model: not opened: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}
