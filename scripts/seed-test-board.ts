import { cliGql, ghExec } from '../src/sources/github-gql.js';
import { BOARD_COLUMNS, type BoardColumn, readBoardOwner, SANDBOX_REPO, SANDBOX_TITLE } from './test-home.js';

// Three fake issues per column (HIVE-6): the GitHub half of the test Hive's cards. A title already in the repo is not created again.
interface SeedIssue { title: string; body: string; column: BoardColumn }
const FAKE = 'Fake issue for the Agent Hive test board.';
const SEED_ISSUES: readonly SeedIssue[] = [
  { title: 'Add a search box to the board', body: FAKE, column: 'Backlog' },
  { title: 'Show the card count per stage', body: FAKE, column: 'Backlog' },
  { title: 'Remember the last opened panel', body: FAKE, column: 'Backlog' },
  { title: 'Colour the stage headers', body: FAKE, column: 'Ready' },
  { title: 'Link a card to its pull request', body: FAKE, column: 'Ready' },
  { title: 'Collapse empty stages', body: FAKE, column: 'Ready' },
  { title: 'Retry the poll after a timeout', body: FAKE, column: 'In progress' },
  { title: 'Warn when a worktree is dirty', body: FAKE, column: 'In progress' },
  { title: 'Explain a blocked card', body: FAKE, column: 'In progress' },
  { title: 'Sort cards by age', body: FAKE, column: 'In review' },
  { title: 'Trim the log on boot', body: FAKE, column: 'In review' },
  { title: 'Show the quota in the header', body: FAKE, column: 'In review' },
  { title: 'Fix the settings tab order', body: FAKE, column: 'Done' },
  { title: 'Drop the unused icon', body: FAKE, column: 'Done' },
  { title: 'Document the test board', body: FAKE, column: 'Done' },
];
const STATUS_FIELD = 'Status';
const LIST_LIMIT = '200';

interface ProjectRef { number: number; id: string; title: string }
interface Option { id: string; name: string }
interface StatusField { id: string; options: Option[] }
interface Field { id: string; name: string; options?: Option[] }
interface Issue { title: string; url: string }

const ghJson = async <T>(args: string[]): Promise<T> => JSON.parse(await ghExec(args)) as T;

// A missing repo makes `gh repo view` fail: it is created private. Any other failure (auth, network) resurfaces from `gh repo create`.
async function ensureRepo(repo: string): Promise<void> {
  try {
    await ghExec(['repo', 'view', repo, '--json', 'name']);
  } catch {
    await ghExec(['repo', 'create', repo, '--private', '--description', 'Agent Hive test board (pnpm seed:test-board)']);
  }
}

async function ensureProject(owner: string): Promise<ProjectRef> {
  const { projects } = await ghJson<{ projects: ProjectRef[] }>(['project', 'list', '--owner', owner, '--format', 'json', '--limit', LIST_LIMIT]);
  const found = projects.find((p) => p.title === SANDBOX_TITLE);
  if (found) return found;
  const created = await ghJson<ProjectRef>(['project', 'create', '--owner', owner, '--title', SANDBOX_TITLE, '--format', 'json']);
  await ghExec(['project', 'link', String(created.number), '--owner', owner, '--repo', SANDBOX_REPO]);
  return created;
}

// The options are literals from BOARD_COLUMNS, never user input: JSON.stringify of a plain string is a valid GraphQL string.
const OPTIONS = BOARD_COLUMNS.map((name) => `{ name: ${JSON.stringify(name)}, color: GRAY, description: "" }`).join(', ');
const SET_OPTIONS = `mutation($fieldId: ID!) { updateProjectV2Field(input: { fieldId: $fieldId, singleSelectOptions: [${OPTIONS}] }) {
  projectV2Field { ... on ProjectV2SingleSelectField { id options { id name } } } } }`;

// Replacing the options clears every item's Status, so it runs only when they differ; main sets every issue's Status after it anyway.
async function ensureStatus(owner: string, project: ProjectRef): Promise<StatusField> {
  const { fields } = await ghJson<{ fields: Field[] }>(['project', 'field-list', String(project.number), '--owner', owner, '--format', 'json']);
  const field = fields.find((f) => f.name === STATUS_FIELD);
  if (!field?.options) throw new Error(`o Project ${project.number} não tem o campo ${STATUS_FIELD}`);
  const names = field.options.map((o) => o.name);
  if (names.length === BOARD_COLUMNS.length && BOARD_COLUMNS.every((c, i) => names[i] === c)) return { id: field.id, options: field.options };
  const data = (await cliGql(ghExec)(SET_OPTIONS, { fieldId: field.id })) as { updateProjectV2Field: { projectV2Field: StatusField } };
  return data.updateProjectV2Field.projectV2Field;
}

async function seedIssue(owner: string, repo: string, project: ProjectRef, status: StatusField, existing: Issue[], issue: SeedIssue): Promise<void> {
  const url = existing.find((i) => i.title === issue.title)?.url ?? (await ghExec(['issue', 'create', '--repo', repo, '--title', issue.title, '--body', issue.body])).trim();
  const option = status.options.find((o) => o.name === issue.column);
  if (!option) throw new Error(`${STATUS_FIELD} não tem a opção ${issue.column}`);
  // item-add answers the existing item when the issue is already on the Project, so a second run adds nothing
  const item = await ghJson<{ id: string }>(['project', 'item-add', String(project.number), '--owner', owner, '--url', url, '--format', 'json']);
  await ghExec(['project', 'item-edit', '--id', item.id, '--project-id', project.id, '--field-id', status.id, '--single-select-option-id', option.id]);
}

async function main(): Promise<void> {
  const owner = readBoardOwner(process.env);
  const repo = `${owner}/${SANDBOX_REPO}`;
  await ensureRepo(repo);
  const project = await ensureProject(owner);
  const status = await ensureStatus(owner, project);
  const existing = await ghJson<Issue[]>(['issue', 'list', '--repo', repo, '--state', 'all', '--limit', LIST_LIMIT, '--json', 'title,url']);
  for (const issue of SEED_ISSUES) await seedIssue(owner, repo, project, status, existing, issue); // one at a time: gh's rate limit
  console.log(`Board de teste pronto: Project ${project.number} de ${owner}, repo ${repo}`);
  console.log(`export HIVE_TEST_BOARD_NUMBER=${project.number}`);
}

try {
  await main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err)); // ghExec's message names the command and gh's stderr
  process.exit(1);
}
