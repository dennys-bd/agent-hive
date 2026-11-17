import type { JiraCredential } from '../../src/credentials.js';
import { openReadModel, type ReadModel } from '../../src/read-model/db.js';
import { createJiraSource, type JiraSourceConfig } from '../../src/sources/jira.js';
import type { JiraCall, JiraIssue } from '../../src/sources/jira-queries.js';
import { syncProject } from '../../src/sources/jira-sync.js';
import type { Citation } from '../../src/tasks.js';
import type { Source } from '../../src/types.js';
import { JIRA_ENTRY } from '../fakes.js';

// The fakes of the jira adapter's tests (#820, #823): jira.test.ts and jira-actions.test.ts share them
export const ROWS = 'jira:acme.example:acc-1';
export const CRED: JiraCredential = { email: 'ana@example.com', token: 'fake-token-820', accountId: 'acc-1', displayName: 'Ana Lima' };
export const CITED: Citation[] = [{ column: 'To Do', by: 'fila' }, { column: 'In Progress', by: 'fila' }];
const NAMES = { components: 'Components' };
const SCHEMA = { components: { type: 'array', items: 'component' } };
export const STATUSES = [{ name: 'Story', statuses: ['To Do', 'In Progress', 'Done'].map((name) => ({ name, statusCategory: { key: 'new' } })) }];
export const doc = (text: string) => ({ version: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

export const issue = (n: number, status: string, fields: Record<string, unknown> = {}): JiraIssue => ({
  id: String(10000 + n), key: `ABC-${n}`,
  fields: {
    summary: `Issue ${n}`, updated: '2026-11-16T10:00:00.000+0000', created: '2026-11-01T10:00:00.000+0000', description: doc(`Body ${n}`),
    status: { name: status, statusCategory: { key: 'new' } }, project: { key: 'ABC' }, assignee: { displayName: 'Ana Lima' }, labels: ['api'],
    components: [{ name: 'Core' }, { name: 'Web' }], ...fields,
  },
});
export const read = (i: JiraIssue) => ({ ...i, names: NAMES, schema: SCHEMA }); // what readIssue reads from

// The read model a 5.6 round would leave: the issues synced under ROWS, the listing in key order
export async function seeded(issues: JiraIssue[]): Promise<ReadModel> {
  const { db } = await openReadModel(':memory:');
  const call: JiraCall = async (path) => {
    if (path === '/search/jql') return { issues, names: NAMES, schema: SCHEMA, isLast: true };
    if (path === '/field') return [];
    if (path === '/project/ABC/statuses') return STATUSES;
    throw new Error(`unexpected ${path}`);
  };
  await syncProject({ call, db, source: ROWS, project: 'ABC' });
  return db;
}

export interface Fake { call: JiraCall; sent: string[]; paths: string[]; bodies: unknown[] }
// Each `METHOD path` (query left out) answers its queue in order; an Error answer is thrown, as the transport would. paths keeps each query.
export function fakeJira(answers: Record<string, unknown[]> = {}): Fake {
  const sent: string[] = [];
  const paths: string[] = [];
  const bodies: unknown[] = [];
  const call: JiraCall = async (path, init = {}) => {
    const key = `${init.method ?? 'GET'} ${path.split('?')[0]}`;
    sent.push(key);
    paths.push(path);
    if (typeof init.body === 'string') bodies.push(JSON.parse(init.body));
    const queue = answers[key];
    if (queue === undefined || queue.length === 0) throw new Error(`unexpected ${key}`);
    const answer = queue.shift();
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { call, sent, paths, bodies };
}

export interface Setup { call?: JiraCall; db?: ReadModel; cred?: JiraCredential | null; source?: Partial<JiraSourceConfig>; renamed?: string[] }
export const adapter = ({ call = fakeJira().call, db, cred = CRED, source = {}, renamed = [] }: Setup): Source =>
  createJiraSource({ ...JIRA_ENTRY, ...source }, CITED, {
    call, credential: async () => cred ?? undefined, renewName: async (name) => { renamed.push(name); }, ...(db === undefined ? {} : { items: { db } }),
  });
