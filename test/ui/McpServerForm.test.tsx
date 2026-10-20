import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { McpServerForm } from '@/components/plugins/McpServerForm';
import type { ServerDraft } from '@/hooks/use-mcp';
import { type MessageKey, setLanguage } from '@/i18n';
import { MCP_READ } from './mcp-fixtures';
import { WORKSPACES } from './plugins-fixtures';

beforeEach(() => setLanguage('pt'));
const FIGMA = { name: 'figma', url: 'http://127.0.0.1:3845/mcp', authHeader: 'Authorization', workspace: 'hive-site', on: true };

test('a new command server: the line splits on whitespace into the argv; a refusal keeps the form with its copy (#334)', async () => {
  const user = userEvent.setup();
  const onSave = vi.fn(async (_draft: ServerDraft): Promise<MessageKey | undefined> => 'plugins.mcp.refused');
  render(<McpServerForm workspaces={WORKSPACES} onSave={onSave} onRemove={vi.fn()} onCancel={vi.fn()} />);
  const form = screen.getByRole('form', { name: 'novo servidor' });
  expect(within(form).getByRole('textbox', { name: 'nome' })).toHaveFocus();
  expect(within(form).queryByRole('button', { name: 'remover' })).not.toBeInTheDocument();
  await user.type(within(form).getByRole('textbox', { name: 'nome' }), 'playwright');
  await user.type(within(form).getByRole('textbox', { name: 'comando e argumentos' }), ' npx  @playwright/mcp@latest --headless ');
  await user.click(within(form).getByRole('button', { name: 'salvar' }));
  expect(onSave).toHaveBeenCalledWith({ server: { name: 'playwright', workspace: null, on: true, command: 'npx', args: ['@playwright/mcp@latest', '--headless'] } });
  expect(await within(form).findByRole('alert')).toHaveTextContent('a hive recusou');
  await user.type(within(form).getByRole('textbox', { name: 'nome' }), '2');
  expect(within(form).queryByRole('alert')).not.toBeInTheDocument();
});

test('editing a URL server: the saved value is never shown, a typed one is sent, clear value sends null; remove asks first (#334)', async () => {
  const user = userEvent.setup();
  const onSave = vi.fn(async (_draft: ServerDraft): Promise<MessageKey | undefined> => undefined);
  const onRemove = vi.fn(async (): Promise<MessageKey | undefined> => undefined);
  render(<McpServerForm server={MCP_READ.servers[1]} workspaces={WORKSPACES} onSave={onSave} onRemove={onRemove} onCancel={vi.fn()} />);
  const form = screen.getByRole('form', { name: 'servidor figma' });
  const value = within(form).getByLabelText('valor do cabeçalho');
  const save = within(form).getByRole('button', { name: 'salvar' });
  expect(value).toHaveValue('');
  expect(value).toHaveAttribute('placeholder', 'valor salvo');
  expect(within(form).getByRole('textbox', { name: 'url' })).toHaveValue('http://127.0.0.1:3845/mcp');
  expect(within(form).getByRole('textbox', { name: 'cabeçalho' })).toHaveValue('Authorization');
  await user.click(save);
  await waitFor(() => expect(onSave).toHaveBeenLastCalledWith({ server: FIGMA, value: undefined }));
  await user.type(value, 'header-value');
  await user.click(save);
  await waitFor(() => expect(onSave).toHaveBeenLastCalledWith({ server: FIGMA, value: 'header-value' }));
  await user.clear(value);
  await user.click(within(form).getByRole('button', { name: 'apagar valor' }));
  expect(value).toHaveAttribute('placeholder', 'valor apagado ao salvar');
  await user.click(save);
  await waitFor(() => expect(onSave).toHaveBeenLastCalledWith({ server: FIGMA, value: null }));
  await user.click(within(form).getByRole('button', { name: 'remover' }));
  const dialog = await screen.findByRole('alertdialog');
  expect(dialog).toHaveTextContent('figma sai das sessões dos workers');
  expect(onRemove).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole('button', { name: 'remover' }));
  await waitFor(() => expect(onRemove).toHaveBeenCalledTimes(1));
});
