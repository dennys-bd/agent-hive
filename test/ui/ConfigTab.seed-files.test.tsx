import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setLanguage } from '@/i18n';
import { CONFIG, DRAFT_CONFIG, editIn, pills, region, renderConfig, rowIn, stubConfigFetch } from './benchmark-config-fixtures';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
beforeEach(() => setLanguage('pt'));
afterEach(() => { vi.unstubAllGlobals(); vi.mocked(toast.error).mockClear(); });
const upload = (): HTMLElement => screen.getByLabelText('enviar arquivo para referência');

test('+ arquivo sends the picked file as base64 under its name and lists it as upload:<name>; salvar lists it with the paths (#463)', async () => {
  const user = userEvent.setup();
  const calls = stubConfigFetch();
  renderConfig(DRAFT_CONFIG);
  await user.click(editIn('seed'));
  await user.upload(upload(), new File(['hello'], 'shot.png', { type: 'image/png' }));
  await waitFor(() => expect(pills(rowIn('seed', 'referência'))).toContain('shot.png'));
  await user.click(within(region('seed')).getByRole('button', { name: 'salvar' }));
  await waitFor(() => expect(calls).toHaveLength(2));
  expect(calls).toEqual([
    { method: 'PUT', path: '/benchmark/experiments/draft-1/seed/files/shot.png', body: { content: 'aGVsbG8=' } },
    { method: 'PATCH', path: '/benchmark/experiments/draft-1', body: { seed: { ...DRAFT_CONFIG.seed, reference: [...DRAFT_CONFIG.seed.reference, 'upload:shot.png'] } } },
  ]);
});

test('a file name the route refuses is said under the field and never sent (#463)', async () => {
  const user = userEvent.setup();
  const calls = stubConfigFetch();
  renderConfig(DRAFT_CONFIG);
  await user.click(editIn('seed'));
  await user.upload(upload(), new File(['x'], 'my shot.png'));
  expect(await within(rowIn('seed', 'referência')).findByRole('alert')).toHaveTextContent('um nome de arquivo com letras, dígitos, pontos, hífens e sublinhados');
  expect(calls).toEqual([]);
});

test('a 409 seed_locked on an upload shows under the field, not as a toast (#463)', async () => {
  const user = userEvent.setup();
  stubConfigFetch({ 'PUT /benchmark/experiments/skills/seed/files/print-1.png': { status: 409, body: { error: 'seed_locked', message: 'the raw words' } } });
  renderConfig(CONFIG);
  await user.click(editIn('seed'));
  await user.upload(upload(), new File(['x'], 'print-1.png'));
  expect(await within(rowIn('seed', 'referência')).findByRole('alert')).toHaveTextContent('print-1.png está num seed que já executou: envie com outro nome');
  expect(toast.error).not.toHaveBeenCalled();
});

test('a 404 unknown_path on save shows under the list holding the path, keeps the form open, and is no toast (#463)', async () => {
  const user = userEvent.setup();
  stubConfigFetch({ 'PATCH /benchmark/experiments/draft-1': { status: 404, body: { error: 'unknown_path', message: "spec.md is not in the seed's commit or uploads" } } });
  renderConfig(DRAFT_CONFIG);
  await user.click(editIn('seed'));
  await user.click(within(region('seed')).getByRole('button', { name: 'salvar' }));
  expect(await within(rowIn('seed', 'referência')).findByRole('alert')).toHaveTextContent('spec.md não está no commit de partida nem nos arquivos enviados');
  expect(screen.getByRole('textbox', { name: 'commit de partida' })).toBeInTheDocument();
  expect(toast.error).not.toHaveBeenCalled();
});

test('any other refusal of the save is the toast for its status (#463)', async () => {
  const user = userEvent.setup();
  stubConfigFetch({ 'PATCH /benchmark/experiments/draft-1': { status: 400, body: { error: 'bad_body', message: 'the raw words' } } });
  renderConfig(DRAFT_CONFIG);
  await user.click(editIn('seed'));
  await user.click(within(region('seed')).getByRole('button', { name: 'salvar' }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('a mudança foi recusada'));
});
