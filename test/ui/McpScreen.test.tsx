import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { McpScreen } from '@/components/plugins/McpScreen';
import { usePlugins } from '@/hooks/use-plugins';
import { setLanguage } from '@/i18n';
import { MCP_READ, stubMcp, withServer } from './mcp-fixtures';
import { CATALOGUE, json, WORKSPACES } from './plugins-fixtures';

function Screen() {
  const plugins = usePlugins(true);
  return <McpScreen plugins={plugins} workspaces={WORKSPACES} />;
}
const FIGMA = { name: 'figma', url: 'http://127.0.0.1:3845/mcp', authHeader: 'Authorization', on: true };
const nameField = (form: HTMLElement): HTMLElement => within(form).getByRole('textbox', { name: 'nome' });

beforeEach(() => setLanguage('pt'));
afterEach(() => vi.unstubAllGlobals());

test('the first read shows a loading line; a failed one says so (#334)', async () => {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => (path === '/api/mcp' ? json({ error: 'boom' }, 500) : json(CATALOGUE))));
  render(<Screen />);
  expect(screen.getByText('lendo as ferramentas e os servidores…')).toBeInTheDocument();
  expect(await screen.findByText('não foi possível ler as ferramentas e os servidores')).toBeInTheDocument();
});

test('the route lists the ten tools and the servers: a locked tool with its lock, an optional one with its switch, each server with its state (#334)', async () => {
  stubMcp();
  render(<Screen />);
  const tools = await screen.findByRole('region', { name: 'ferramentas da hive' });
  expect(within(tools).getAllByRole('listitem')).toHaveLength(10);
  expect(within(tools).getAllByRole('switch').map((s) => s.getAttribute('aria-label'))).toEqual(['hive_remember', 'hive_applied', 'hive_create_task', 'hive_task']);
  expect(within(tools).getByRole('img', { name: 'sem ela a sessão para sem avisar' })).toBeInTheDocument();
  const servers = screen.getByRole('region', { name: 'servidores externos' });
  expect(within(servers).getByRole('button', { name: 'editar playwright' })).toHaveTextContent('npx @playwright/mcp@latest');
  expect(within(servers).getByRole('combobox', { name: 'escopo de figma' })).toHaveTextContent('só hive-site');
  expect(within(servers).getByText('sem resposta')).toBeInTheDocument();
});

test('no servers: no table, the + servidor stays (#334)', async () => {
  stubMcp(() => ({ ...MCP_READ, servers: [] }));
  render(<Screen />);
  const servers = await screen.findByRole('region', { name: 'servidores externos' });
  expect(within(servers).queryByRole('list')).not.toBeInTheDocument();
  expect(within(servers).getByRole('button', { name: '+ servidor' })).toBeInTheDocument();
});

test("a row's scope sends PUT with the new workspace; a server switched on shows verificando… until the re-read (#334)", async () => {
  const user = userEvent.setup();
  let read = withServer('playwright', { on: false, state: 'off' });
  let answer: (r: Response) => void = () => undefined;
  const { calls } = stubMcp(() => read, (call) =>
    (call.path === '/api/mcp/servers/playwright' ? new Promise<Response>((resolve) => { answer = resolve; }) : json({ ok: true })));
  render(<Screen />);
  await user.click(await screen.findByRole('combobox', { name: 'escopo de figma' }));
  await user.click(await screen.findByRole('option', { name: 'só agent-hive' }));
  await waitFor(() => expect(calls).toContainEqual({ method: 'PUT', path: '/api/mcp/servers/figma', body: { ...FIGMA, workspace: 'agent-hive' } }));
  await user.click(screen.getByRole('switch', { name: 'playwright' }));
  expect(await screen.findByText('verificando…')).toBeInTheDocument();
  read = MCP_READ;
  await act(async () => answer(json({ ok: true })));
  expect(await screen.findByText('conectado')).toBeInTheDocument();
});

test('+ servidor opens the form; a refusal keeps it open with its copy; a URL server with a value sends the definition, then the value (#334)', async () => {
  const user = userEvent.setup();
  const { calls } = stubMcp(undefined, (call) =>
    (call.method === 'POST' && (call.body as { name?: string }).name === 'figma' ? json({ error: 'mcp.servers: figma is listed twice' }, 400) : json({ ok: true })));
  render(<Screen />);
  await user.click(await within(await screen.findByRole('region', { name: 'servidores externos' })).findByRole('button', { name: '+ servidor' }));
  const form = screen.getByRole('form', { name: 'novo servidor' });
  await user.type(nameField(form), 'figma');
  await user.click(within(form).getByRole('combobox', { name: 'tipo' }));
  await user.click(await screen.findByRole('option', { name: 'url' }));
  await user.type(within(form).getByRole('textbox', { name: 'url' }), 'https://docs.example.com/mcp');
  await user.type(within(form).getByRole('textbox', { name: 'cabeçalho' }), 'X-Api-Key');
  await user.type(within(form).getByLabelText('valor do cabeçalho'), 'header-value');
  await user.click(within(form).getByRole('button', { name: 'salvar' }));
  expect(await within(form).findByRole('alert')).toHaveTextContent('a hive recusou');
  await user.clear(nameField(form));
  await user.type(nameField(form), 'docs');
  await user.click(within(form).getByRole('button', { name: 'salvar' }));
  await waitFor(() => expect(screen.queryByRole('form', { name: 'novo servidor' })).not.toBeInTheDocument());
  expect(calls.slice(-2)).toEqual([
    { method: 'POST', path: '/api/mcp/servers', body: { name: 'docs', url: 'https://docs.example.com/mcp', authHeader: 'X-Api-Key', workspace: null, on: true } },
    { method: 'PUT', path: '/api/mcp/servers/docs/value', body: { value: 'header-value' } },
  ]);
});

test('a header value the route refuses closes the form and shows on the screen (#334)', async () => {
  const user = userEvent.setup();
  stubMcp(undefined, (call) => (call.path.endsWith('/value') ? json({ error: 'value must be 1 to 4096 characters' }, 400) : json({ ok: true })));
  render(<Screen />);
  await user.click(await screen.findByRole('button', { name: 'editar figma' }));
  const form = screen.getByRole('form', { name: 'servidor figma' });
  await user.type(within(form).getByLabelText('valor do cabeçalho'), 'header-value');
  await user.click(within(form).getByRole('button', { name: 'salvar' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('o servidor foi salvo, mas o valor do cabeçalho não');
  expect(screen.queryByRole('form')).not.toBeInTheDocument();
});

test('a row opens its server in the form: a scope edit sends PUT and no value call; remove asks, then sends DELETE (#334)', async () => {
  const user = userEvent.setup();
  const { calls } = stubMcp();
  render(<Screen />);
  await user.click(await screen.findByRole('button', { name: 'editar figma' }));
  const form = screen.getByRole('form', { name: 'servidor figma' });
  await user.click(within(form).getByRole('combobox', { name: 'escopo' }));
  await user.click(await screen.findByRole('option', { name: 'só agent-hive' }));
  await user.click(within(form).getByRole('button', { name: 'salvar' }));
  await waitFor(() => expect(screen.queryByRole('form')).not.toBeInTheDocument());
  expect(calls).toEqual([{ method: 'PUT', path: '/api/mcp/servers/figma', body: { ...FIGMA, workspace: 'agent-hive' } }]);
  await user.click(screen.getByRole('button', { name: 'editar figma' }));
  await user.click(within(screen.getByRole('form', { name: 'servidor figma' })).getByRole('button', { name: 'remover' }));
  const dialog = await screen.findByRole('alertdialog');
  await user.click(within(dialog).getByRole('button', { name: 'remover' }));
  await waitFor(() => expect(calls.at(-1)).toEqual({ method: 'DELETE', path: '/api/mcp/servers/figma' }));
  await waitFor(() => expect(screen.queryByRole('form')).not.toBeInTheDocument());
});

test('a failed read offers to try again, and the retry reads the route again (#334)', async () => {
  const user = userEvent.setup();
  let fails = true;
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path !== '/api/mcp') return json(CATALOGUE);
    return fails ? json({ error: 'boom' }, 500) : json(MCP_READ);
  }));
  render(<Screen />);
  const retry = await screen.findByRole('button', { name: 'tentar de novo' });
  fails = false;
  await user.click(retry);
  expect(await screen.findByRole('region', { name: 'ferramentas da hive' })).toBeInTheDocument();
  expect(screen.queryByText('não foi possível ler as ferramentas e os servidores')).not.toBeInTheDocument();
});
