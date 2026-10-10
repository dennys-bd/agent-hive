import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { CheckersSection } from '@/components/settings/CheckersSection';
import { setLanguage } from '@/i18n';
import { emptyLanguageDraft } from '@/lib/settings-format';
import { languageDef } from '../../src/languages';
import { type EditorInstalls, type InstallState, SERVER_IDS, SYNTAX_IDS } from '../../src/types';

const ABSENT: InstallState = { state: 'absent' };
const installs = (servers: Partial<EditorInstalls['servers']>): EditorInstalls => ({
  servers: { ...Object.fromEntries(SERVER_IDS.map((id) => [id, ABSENT])), ...servers } as EditorInstalls['servers'],
  syntaxes: Object.fromEntries(SYNTAX_IDS.map((id) => [id, ABSENT])) as EditorInstalls['syntaxes'],
});
const NAMES = ['agent-hive', 'core-api'];
const row = (name: string): HTMLElement => screen.getByRole('group', { name });

beforeEach(() => setLanguage('pt'));

test('Python: ruff its own language server, installed, the project\'s winning in core-api; mypy on save found in core-api with its args; pylint not installed and off by default (#782)', () => {
  const draft = { ...emptyLanguageDraft(), checkers: { mypy: { enabled: true, args: '--strict', workspaces: 'all' as const } } };
  const states = [{ id: 'ruff' as const, found: ['core-api'] }, { id: 'mypy' as const, found: ['core-api'] }, { id: 'pylint' as const, found: [] }];
  render(<CheckersSection language={languageDef('python')} draft={draft} names={NAMES} installs={installs({ ruff: { state: 'installed', version: '0.13.2' } })} states={states} onAct={vi.fn()} onChange={vi.fn()} />);
  const ruff = row('ruff');
  for (const text of ['language server próprio · binário do GitHub', 'instalado · v0.13.2', 'o do projeto vence em core-api · nos outros, o do Hive', 'ruff server']) expect(within(ruff).getByText(text)).toBeInTheDocument();
  expect(within(ruff).getByRole('button', { name: 'remover' })).toBeInTheDocument();
  expect(within(ruff).getByRole('switch', { name: 'usar ruff' })).toBeChecked();
  const mypy = row('mypy');
  for (const text of ['linha de comando ao salvar', 'instalado em core-api', 'detectado no workspace · o Hive não instala', 'mypy --strict --show-column-numbers -O json "$FILE"']) expect(within(mypy).getByText(text)).toBeInTheDocument();
  expect(within(mypy).getByRole('textbox', { name: 'argumentos extras de mypy' })).toHaveValue('--strict');
  expect(within(mypy).queryByRole('button', { name: 'instalar' })).not.toBeInTheDocument();
  const pylint = row('pylint');
  expect(within(pylint).getByText('não instalado nos workspaces')).toBeInTheDocument();
  expect(within(pylint).getByRole('switch', { name: 'usar pylint' })).not.toBeChecked();
});

test('TypeScript: biome not installed offers instalar; eslint installed, the project\'s winning in both workspaces; oxlint has an update; tsc runs on save (#782)', async () => {
  const user = userEvent.setup();
  const onAct = vi.fn();
  const servers = { eslint: { state: 'installed', version: '4.10.0' }, oxlint: { state: 'installed', version: '1.20.0', latest: '1.21.0' } } as const;
  render(<CheckersSection language={languageDef('typescript')} draft={emptyLanguageDraft()} names={NAMES} installs={installs(servers)} states={[{ id: 'eslint', found: ['agent-hive', 'core-api'] }]} onAct={onAct} onChange={vi.fn()} />);
  expect(within(row('biome')).getByText('instale, ou adicione ao projeto')).toBeInTheDocument();
  await user.click(within(row('biome')).getByRole('button', { name: 'instalar' }));
  expect(onAct).toHaveBeenCalledWith({ kind: 'server', id: 'biome' }, 'install');
  expect(within(row('eslint')).getByText('o do projeto vence em agent-hive e core-api')).toBeInTheDocument();
  expect(within(row('oxlint')).getByText('atualização disponível · v1.21.0')).toBeInTheDocument();
  expect(within(row('oxlint')).getByRole('button', { name: 'atualizar' })).toBeInTheDocument();
  expect(within(row('tsc')).getByText('linha de comando ao salvar')).toBeInTheDocument();
});

test('the switch, the args and the chips go into the draft as the checker\'s setting, a change from no setting starting from on everywhere (#782)', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<CheckersSection language={languageDef('python')} draft={emptyLanguageDraft()} names={NAMES} states={[]} onAct={vi.fn()} onChange={onChange} />);
  await user.click(screen.getByRole('switch', { name: 'usar pylint' }));
  expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ checkers: { pylint: { enabled: true, args: '', workspaces: 'all' } } }));
  await user.type(screen.getByRole('textbox', { name: 'argumentos extras de mypy' }), 'x');
  expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ checkers: { mypy: { enabled: true, args: 'x', workspaces: 'all' } } }));
  render(<CheckersSection language={languageDef('other')} draft={emptyLanguageDraft()} names={NAMES} onAct={vi.fn()} onChange={vi.fn()} />);
  expect(screen.getByText('nenhum checker suportado para esta linguagem')).toBeInTheDocument();
});
