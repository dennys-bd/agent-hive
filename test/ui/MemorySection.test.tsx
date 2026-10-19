import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MemorySection } from '@/components/settings/MemorySection';
import { WorkspacesEditor } from '@/components/settings/WorkspacesEditor';
import { setLanguage } from '@/i18n';
import type { WorkspaceDraft } from '@/lib/settings-form';
import type { MemoryStats, MemoryView } from '../../src/types';
import { jsonResponse } from '../fakes';

// Settings › workspaces › memory (#797): the card's usage section and the dialog it opens
const VIEW: MemoryView = {
  used: 87, cap: 4000, textMax: 300,
  entries: [
    { id: 'm-1', kind: 'fact', text: 'pnpm test runs lint, tsc and both runners', origin: { task: '812', stage: 'build' }, at: '2026-10-01T10:00:00.000Z', uses: 5 },
    { id: 'm-2', kind: 'pref', text: 'write specs in English', origin: { task: '790' }, at: '2026-10-02T10:00:00.000Z', uses: 1 },
    { id: 'm-3', kind: 'avoid', text: 'never edit dist/ by hand', origin: 'user', at: '2026-10-03T10:00:00.000Z', uses: 0 },
  ],
};
const lastAt = (): string => new Date(Date.now() - 2 * 3_600_000 - 300_000).toISOString();
let stats: MemoryStats = { runs: 0, cited: 0 };

let view: MemoryView = VIEW;
// the route's answer to PUT …/memory/cap: by default the save, which the next read of the memory shows
const saves = ({ cap }: { cap: number }): Response => {
  view = { ...view, cap };
  return jsonResponse({ ok: true });
};
let capAnswer = saves;
let readFails = false; // the memory read answers 500, as after a save whose follow-up read fails

const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  if (url === '/workspaces/hive/memory/cap' && init?.method === 'PUT') return capAnswer(JSON.parse(String(init.body)) as { cap: number });
  if (url === '/workspaces/hive/memory') return readFails ? jsonResponse({ error: 'unreadable' }, 500) : jsonResponse(view);
  if (url === '/workspaces/hive/memory/stats') return jsonResponse(stats);
  return jsonResponse({ error: 'unknown workspace' }, 404);
});

beforeEach(() => {
  setLanguage('pt');
  view = VIEW;
  capAnswer = saves;
  readFails = false;
  stats = { runs: 12, cited: 2, tokensPerRun: 150, last: { at: lastAt(), task: '812', stage: 'build', cited: 1 } };
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

test('the section shows the usage and the lessons, and ver memória… opens the dialog with its usage, telemetry and rules; fechar closes it (#797)', async () => {
  const user = userEvent.setup();
  render(<MemorySection workspace="hive" saved onCapSaved={vi.fn()} />);
  expect(await screen.findByText('87 de 4.000 caracteres')).toBeInTheDocument();
  expect(screen.getByText('3 lições · 2 vindas de tarefas')).toBeInTheDocument();
  expect(screen.getByRole('progressbar', { name: 'memória usada' })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'ver memória…' }));
  const dialog = within(await screen.findByRole('dialog', { name: 'Memória de hive' }));
  expect(dialog.getByText(/^o que os agentes deste workspace sabem/)).toBeInTheDocument();
  const usage = within(dialog.getByRole('region', { name: 'uso' }));
  expect(usage.getByRole('spinbutton', { name: 'limite total' })).toHaveValue(4000);
  expect(usage.getByText('≈ 1.100 tokens por execução com a memória cheia')).toBeInTheDocument();
  expect(usage.getByRole('button', { name: 'salvar' })).toBeDisabled();
  expect(usage.getByText('no limite, nenhuma lição nova entra, nem sua nem de tarefa, até você remover ou encurtar outra')).toBeInTheDocument();
  expect(usage.getByRole('spinbutton', { name: 'limite por lição (caracteres)' })).toHaveValue(300);
  expect(usage.getByRole('spinbutton', { name: 'limite por lição (caracteres)' })).toBeDisabled();
  const telemetry = within(dialog.getByRole('region', { name: 'telemetria · últimos 7 dias' }));
  expect(await telemetry.findByText('12')).toBeInTheDocument();
  expect(telemetry.getByText('2 de 3')).toBeInTheDocument();
  expect(telemetry.getByText('~150')).toBeInTheDocument();
  expect(telemetry.getByText('última injeção há 2 h, na etapa build de #812 · 1 lição citada')).toBeInTheDocument();
  expect(dialog.getByRole('heading', { name: 'quando uma lição entra' })).toBeInTheDocument();
  expect(dialog.getByRole('region', { name: 'lições' })).toBeInTheDocument();
  await user.click(dialog.getByRole('button', { name: 'fechar' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

test('with no run carrying memory in the window the telemetry shows dashes and no last injection (#797)', async () => {
  stats = { runs: 0, cited: 0 };
  const user = userEvent.setup();
  render(<MemorySection workspace="hive" saved onCapSaved={vi.fn()} />);
  await user.click(await screen.findByRole('button', { name: 'ver memória…' }));
  const telemetry = within(await screen.findByRole('region', { name: 'telemetria · últimos 7 dias' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/workspaces/hive/memory/stats'));
  expect(telemetry.getAllByText('—')).toHaveLength(3);
  expect(telemetry.queryByText(/última injeção/)).not.toBeInTheDocument();
});

test('the section and the dialog read in English (#797)', async () => {
  setLanguage('en');
  const user = userEvent.setup();
  render(<MemorySection workspace="hive" saved onCapSaved={vi.fn()} />);
  expect(await screen.findByText('87 of 4,000 characters')).toBeInTheDocument();
  expect(screen.getByText('3 lessons · 2 from tasks')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'view memory…' }));
  const dialog = within(await screen.findByRole('dialog', { name: 'hive memory' }));
  expect(within(dialog.getByRole('region', { name: 'usage' })).getByRole('spinbutton', { name: 'total limit' })).toHaveValue(4000);
  expect(dialog.getByText("at the limit no new lesson comes in, yours or a task's, until you remove or shorten another")).toBeInTheDocument();
  expect(await dialog.findByText('last injected 2 h ago, in the build stage of #812 · 1 lesson cited')).toBeInTheDocument();
  expect(dialog.getByText('prompts with memory')).toBeInTheDocument();
  expect(dialog.getByRole('button', { name: 'close' })).toBeInTheDocument();
});

test('a workspace the live config does not have yet says so and keeps the dialog shut, in both languages; an unnamed one asks nothing (#797)', async () => {
  for (const [language, text, open] of [['en', 'save the workspace to see its memory', 'view memory…'], ['pt', 'salve o workspace para ver a memória', 'ver memória…']] as const) {
    setLanguage(language);
    const { unmount } = render(<MemorySection workspace="new" saved={false} onCapSaved={vi.fn()} />);
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: open })).toBeDisabled();
    unmount();
  }
  fetchMock.mockClear();
  render(<MemorySection workspace="" saved onCapSaved={vi.fn()} />);
  expect(screen.getByText('salve o workspace para ver a memória')).toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalled();
});

test('typing the name of a workspace that is not saved never asks for /workspaces/<partial>/memory (#797)', async () => {
  const row: WorkspaceDraft = { id: 'w1', name: 'hive', path: '/repo', env: [], setup: '', setupTimeout: '', teardown: '', teardownTimeout: '', fork: null, baseBranch: '', memoryCap: '4000', color: 'oklch(0.72 0.12 25)' };
  const Editor = ({ name }: { name: string }) => <WorkspacesEditor workspaces={[{ ...row, name }]} savedNames={['hive']} onChange={vi.fn()} onCapSaved={vi.fn()} />;
  const { rerender } = render(<Editor name="hive" />);
  expect(await screen.findByText('87 de 4.000 caracteres')).toBeInTheDocument();
  fetchMock.mockClear();
  for (const name of ['hiv', 'hive2', 'hive23']) rerender(<Editor name={name} />);
  expect(await screen.findByText('salve o workspace para ver a memória')).toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalled();
});

test('the memory section closes each workspace card, after the environment, with its hint (#797)', async () => {
  const row: WorkspaceDraft = { id: 'w1', name: 'hive', path: '/repo', env: [], setup: '', setupTimeout: '', teardown: '', teardownTimeout: '', fork: null, baseBranch: '', memoryCap: '4000', color: 'oklch(0.72 0.12 25)' };
  render(<WorkspacesEditor workspaces={[row]} savedNames={['hive']} onChange={vi.fn()} onCapSaved={vi.fn()} />);
  const hive = within(screen.getByRole('region', { name: 'hive' }));
  expect(hive.getAllByRole('heading', { level: 3 }).map((h) => h.textContent).slice(-2)).toEqual(['ambiente', 'memória']);
  expect(hive.getByText('preferências, fatos do código e o que evitar, que toda sessão das tarefas deste workspace recebe')).toBeInTheDocument();
  expect(await hive.findByText('87 de 4.000 caracteres')).toBeInTheDocument();
});

test('the dialog edits the total limit: save stays off for the saved value or one out of range, which shows the range; a new one is saved at once, then the memory is read again and both bars show it (#115)', async () => {
  const user = userEvent.setup();
  const onCapSaved = vi.fn();
  render(<MemorySection workspace="hive" saved onCapSaved={onCapSaved} />);
  await user.click(await screen.findByRole('button', { name: 'ver memória…' }));
  const usage = within(await screen.findByRole('region', { name: 'uso' }));
  const cap = usage.getByRole('spinbutton', { name: 'limite total' });
  await user.clear(cap);
  await user.type(cap, '20001');
  expect(cap).toHaveAttribute('aria-invalid', 'true');
  expect(usage.getByText('um número inteiro de 300 a 20.000')).toBeInTheDocument();
  expect(usage.getByRole('button', { name: 'salvar' })).toBeDisabled();
  await user.clear(cap);
  await user.type(cap, '6000');
  expect(usage.getByText('≈ 1.600 tokens por execução com a memória cheia')).toBeInTheDocument();
  await user.click(usage.getByRole('button', { name: 'salvar' }));
  expect(await usage.findByText('87 de 6.000 caracteres')).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith('/workspaces/hive/memory/cap', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ cap: 6000 }) }));
  const calls = fetchMock.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${url}`);
  expect(calls.slice(calls.indexOf('PUT /workspaces/hive/memory/cap'))).toContain('GET /workspaces/hive/memory');
  expect(onCapSaved).toHaveBeenCalledWith(6000);
  expect(usage.getByRole('spinbutton', { name: 'limite total' })).toHaveValue(6000);
  expect(usage.getByRole('button', { name: 'salvar' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'fechar' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(screen.getByText('87 de 6.000 caracteres')).toBeInTheDocument(); // the card's bar, with no window focus
});

test('a cap the route refuses shows the range under the field, any other failure Erro inesperado and never the server\'s words; Enter saves too, and a new value clears the message (#115)', async () => {
  const user = userEvent.setup();
  const onCapSaved = vi.fn();
  render(<MemorySection workspace="hive" saved onCapSaved={onCapSaved} />);
  await user.click(await screen.findByRole('button', { name: 'ver memória…' }));
  const usage = within(await screen.findByRole('region', { name: 'uso' }));
  const cap = usage.getByRole('spinbutton', { name: 'limite total' });
  capAnswer = () => jsonResponse({ error: 'cap must be an integer from 300 to 20000', code: 'cap_range' }, 400);
  await user.clear(cap);
  await user.type(cap, '5000{Enter}');
  expect(await usage.findByRole('alert')).toHaveTextContent('um número inteiro de 300 a 20.000');
  capAnswer = () => jsonResponse({ error: 'EACCES: permission denied' }, 500);
  await user.clear(cap);
  await user.type(cap, '5001');
  expect(usage.queryByRole('alert')).not.toBeInTheDocument();
  await user.click(usage.getByRole('button', { name: 'salvar' }));
  expect(await usage.findByRole('alert')).toHaveTextContent('Erro inesperado');
  expect(usage.queryByText(/EACCES/)).not.toBeInTheDocument();
  expect(onCapSaved).not.toHaveBeenCalled();
  expect(usage.getByText('87 de 4.000 caracteres')).toBeInTheDocument();
});

test('a save whose follow-up read fails still stands: no error, both the field and the bar take the new cap (#115)', async () => {
  const user = userEvent.setup();
  const onCapSaved = vi.fn();
  render(<MemorySection workspace="hive" saved onCapSaved={onCapSaved} />);
  await user.click(await screen.findByRole('button', { name: 'ver memória…' }));
  const usage = within(await screen.findByRole('region', { name: 'uso' }));
  capAnswer = (body) => {
    readFails = true;
    return saves(body);
  };
  const cap = usage.getByRole('spinbutton', { name: 'limite total' });
  await user.clear(cap);
  await user.type(cap, '6000{Enter}');
  expect(await usage.findByText('87 de 6.000 caracteres')).toBeInTheDocument();
  expect(onCapSaved).toHaveBeenCalledWith(6000);
  expect(usage.queryByRole('alert')).not.toBeInTheDocument();
  expect(usage.getByRole('button', { name: 'salvar' })).toBeDisabled();
});
