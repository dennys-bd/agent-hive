import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { McpServerRow } from '@/components/plugins/McpServerRow';
import { McpToolRow } from '@/components/plugins/McpToolRow';
import { setLanguage } from '@/i18n';
import { MCP_READ } from './mcp-fixtures';
import { WORKSPACES } from './plugins-fixtures';

beforeEach(() => setLanguage('pt'));
const rowOf = (name: string): HTMLElement => screen.getByText(name).closest('li') as HTMLElement;

test('a locked tool has a lock naming its reason and no switch; an optional tool off shows what it drops (#334)', async () => {
  const user = userEvent.setup();
  const onSwitch = vi.fn();
  render(<ul>{MCP_READ.tools.map((tool) => <McpToolRow key={tool.name} tool={tool} onSwitch={onSwitch} />)}</ul>);
  const reason = 'sem ela a hive não sabe quando a etapa acabou';
  expect(within(rowOf('hive_done')).getByRole('img', { name: reason })).toHaveAttribute('title', reason);
  expect(within(rowOf('hive_done')).queryByRole('switch')).not.toBeInTheDocument();
  expect(rowOf('hive_pr')).toHaveTextContent('sem ela a hive não acompanha o PR da tarefa');
  expect(rowOf('hive_remember')).toHaveTextContent('desligada · tira 1 trecho do protocolo');
  expect(rowOf('hive_create_task')).toHaveTextContent(/cria uma tarefa na sourcedesligada$/);
  expect(rowOf('hive_applied')).not.toHaveTextContent('desligada');
  expect(screen.getByRole('switch', { name: 'hive_applied' })).toBeChecked();
  await user.click(screen.getByRole('switch', { name: 'hive_remember' }));
  expect(onSwitch).toHaveBeenCalledWith(true);
});

test('a server row shows its target, scope and state; its name opens it, its scope and switch change it (#334)', async () => {
  const user = userEvent.setup();
  const onEdit = vi.fn();
  const onChange = vi.fn();
  const [playwright, figma] = MCP_READ.servers;
  render(<ul>{MCP_READ.servers.map((server) => <McpServerRow key={server.name} server={server} workspaces={WORKSPACES} onEdit={() => onEdit(server.name)} onChange={onChange} />)}</ul>);
  expect(screen.getByRole('button', { name: 'editar playwright' })).toHaveTextContent('playwrightnpx @playwright/mcp@latest');
  expect(screen.getByRole('button', { name: 'editar figma' })).toHaveTextContent('figmahttp://127.0.0.1:3845/mcp');
  expect(screen.getByRole('combobox', { name: 'escopo de playwright' })).toHaveTextContent('todos os workspaces');
  expect(screen.getByRole('combobox', { name: 'escopo de figma' })).toHaveTextContent('só hive-site');
  expect(within(rowOf('playwright')).getByText('conectado')).toHaveClass('text-working');
  expect(within(rowOf('figma')).getByText('sem resposta')).toHaveClass('text-destructive');
  await user.click(screen.getByRole('button', { name: 'editar figma' }));
  expect(onEdit).toHaveBeenCalledWith('figma');
  await user.click(screen.getByRole('switch', { name: 'playwright' }));
  expect(onChange).toHaveBeenLastCalledWith({ ...playwright, on: false });
  await user.click(screen.getByRole('combobox', { name: 'escopo de figma' }));
  await user.click(await screen.findByRole('option', { name: 'todos os workspaces' }));
  expect(onChange).toHaveBeenLastCalledWith({ ...figma, workspace: null });
});
