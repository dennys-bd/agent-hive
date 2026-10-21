import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { WorkspaceNestedRepos } from '@/components/settings/WorkspaceNestedRepos';
import { WorkspacesEditor } from '@/components/settings/WorkspacesEditor';
import { setLanguage, t } from '@/i18n';
import { emptyWorkspace, type WorkspaceDraft } from '@/lib/settings-form';
import type { NestedReposAnswer } from '../../src/types';

// Settings › workspaces › repos aninhados (#653, tweak repos-aninhados): configurado, sugestão, inválido, preparo-antigo.
const NONE: NestedReposAnswer = { repos: [], suggested: [] };
let answer: NestedReposAnswer = NONE;
const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => json(String(input).startsWith('/settings/nested-repos?') ? answer : {}));
beforeEach(() => { setLanguage('pt'); answer = NONE; fetchMock.mockClear(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => vi.unstubAllGlobals());

const DOCS = { id: 'n1', path: 'docs' };
const urls = (): string[] => fetchMock.mock.calls.map(([url]) => String(url));

// The group over a row held as the card holds it; `seen` gets every row a change makes
function Harness({ start, seen }: { start: Partial<WorkspaceDraft>; seen(row: WorkspaceDraft): void }) {
  const [row, setRow] = useState<WorkspaceDraft>({ ...emptyWorkspace(), name: 'app', path: '/app', ...start });
  return <WorkspaceNestedRepos row={row} flagId="old-setup" onChange={(patch) => { const next = { ...row, ...patch }; setRow(next); seen(next); }} />;
}
const renderNested = (start: Partial<WorkspaceDraft>) => {
  const seen = vi.fn();
  render(<Harness start={start} seen={seen} />);
  return seen;
};
const last = (seen: ReturnType<typeof vi.fn>): WorkspaceDraft => seen.mock.calls.at(-1)?.[0] as WorkspaceDraft;

test('configurado: a row shows its path, its repository and the workspace\'s base; + repo aninhado adds a row and × removes one (#653)', async () => {
  const user = userEvent.setup();
  answer = { repos: [{ path: 'docs', repository: 'acme/docs', base: 'origin/main' }], suggested: [] };
  const seen = renderNested({ nestedRepos: [DOCS] });
  expect(await screen.findByText('acme/docs · parte da mesma base do workspace, origin/main')).toBeInTheDocument();
  expect(urls()).toContain(`/settings/nested-repos?${new URLSearchParams({ path: '/app', repos: 'docs' })}`);
  expect(screen.getByRole('textbox', { name: 'caminho do repo aninhado 1' })).toHaveValue('docs');
  await user.click(screen.getByRole('button', { name: '+ repo aninhado' }));
  expect(last(seen).nestedRepos.map((r) => r.path)).toEqual(['docs', '']);
  await user.click(screen.getByRole('button', { name: 'remover repo aninhado docs' }));
  expect(last(seen).nestedRepos.map((r) => r.path)).toEqual(['']);
});

test('sugestão: the Hive\'s find is suggested with its repository; adicionar lists it and the suggestion goes (#653)', async () => {
  const user = userEvent.setup();
  answer = { repos: [], suggested: [{ path: 'docs', repository: 'acme/docs' }] };
  const seen = renderNested({});
  expect(await screen.findByRole('status')).toHaveTextContent('o Hive encontrou um repositório git em docs/ que este workspace ignora');
  expect(screen.getByText('docs/')).toHaveClass('font-mono');
  expect(screen.getByText('acme/docs · sugestão: criar uma worktree dele em cada tarefa')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'adicionar' }));
  expect(last(seen).nestedRepos.map((r) => r.path)).toEqual(['docs']);
  expect(screen.queryByRole('button', { name: 'adicionar' })).not.toBeInTheDocument();
});

test('sugestão: não é repo aninhado keeps the path in notNestedRepos and the suggestion never shows again (#653)', async () => {
  const user = userEvent.setup();
  answer = { repos: [], suggested: [{ path: 'docs', repository: 'acme/docs' }] };
  const seen = renderNested({});
  await user.click(await screen.findByRole('button', { name: 'não é repo aninhado' }));
  expect([last(seen).notNestedRepos, last(seen).nestedRepos]).toEqual([['docs'], []]);
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});

test('inválido: the input is invalid and described by the cause and its fix, in its row (#653)', async () => {
  answer = { repos: [{ path: 'docs/agent', problem: { cause: 'notTopLevel', root: 'docs' } }], suggested: [] };
  renderNested({ nestedRepos: [{ id: 'n1', path: 'docs/agent' }] });
  const status = await screen.findByRole('status');
  expect(status).toHaveTextContent('docs/agent não é a raiz de um repositório git');
  expect(status).toHaveTextContent('a raiz é docs · use docs');
  const input = screen.getByRole('textbox', { name: 'caminho do repo aninhado 1' });
  expect(input).toHaveAttribute('aria-invalid', 'true');
  expect(input).toHaveAttribute('aria-describedby', status.id);
});

test('preparo-antigo: a setup line that still adds the nested worktree is flagged under the rows and marks the setup textarea (#653)', async () => {
  answer = { repos: [{ path: 'docs', repository: 'acme/docs', base: 'origin/main' }], suggested: [] };
  const setup = 'RUN main="$(git rev-parse --path-format=absolute --git-common-dir)/.." && git -C "$main/docs" worktree add "$PWD/docs" "$(git branch --show-current)"\nRUN pnpm install';
  const row: WorkspaceDraft = { ...emptyWorkspace(), name: 'app', path: '/app', setup, nestedRepos: [DOCS] };
  render(<WorkspacesEditor workspaces={[row]} savedNames={['app']} onChange={vi.fn()} onCapSaved={vi.fn()} />);
  const flag = screen.getByText('o preparo da worktree também cria uma worktree em docs, e esse passo vai falhar').closest('[role="status"]');
  expect(flag).toHaveTextContent('o Hive já cria essa worktree antes do preparo · tire essa linha do preparo');
  const textarea = screen.getByRole('textbox', { name: `${t('settings.workspaces.setup')} 1` });
  expect(textarea).toHaveAttribute('aria-invalid', 'true');
  expect(textarea).toHaveAttribute('aria-describedby', flag?.id);
});
