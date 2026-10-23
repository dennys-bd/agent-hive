import { toast } from 'sonner';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { evaluateAgain, refusalOf, saveSection, toastRefusal, uploadSeedFile } from '@/components/benchmark/config/save-section';
import { setLanguage } from '@/i18n';
import { CONFIG, stubConfigFetch } from './benchmark-config-fixtures';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
beforeEach(() => setLanguage('pt'));
afterEach(() => { vi.unstubAllGlobals(); vi.mocked(toast.error).mockClear(); });

test("saveSection PATCHes that section alone and answers the id the route answers, a fork's included (#463)", async () => {
  const calls = stubConfigFetch({ 'PATCH /benchmark/experiments/skills': { body: { id: 'skills-fork' } } });
  expect(await saveSection('skills', 'pace', CONFIG.pace)).toBe('skills-fork');
  expect(calls).toEqual([{ method: 'PATCH', path: '/benchmark/experiments/skills', body: { pace: CONFIG.pace } }]);
});

test("an upload PUTs the base64 content under its name; evaluate POSTs the experiment's evaluate route (#463)", async () => {
  const calls = stubConfigFetch();
  await uploadSeedFile('skills', 'shot.png', 'aGVsbG8=');
  await evaluateAgain('skills');
  expect(calls).toEqual([
    { method: 'PUT', path: '/benchmark/experiments/skills/seed/files/shot.png', body: { content: 'aGVsbG8=' } },
    { method: 'POST', path: '/benchmark/experiments/skills/evaluate' },
  ]);
});

test("a refusal keeps the route's status, code and message for the form; its toast is the copy for the status, never the route's words (#463)", async () => {
  stubConfigFetch({ 'PATCH /benchmark/experiments/skills': { status: 404, body: { error: 'unknown_path', message: "spec.md is not in the seed's commit or uploads" } } });
  const err = await saveSection('skills', 'seed', CONFIG.seed).catch((e: unknown) => e);
  expect(refusalOf(err)).toEqual({ status: 404, error: 'unknown_path', message: "spec.md is not in the seed's commit or uploads" });
  toastRefusal(err);
  expect(toast.error).toHaveBeenCalledWith('o experimento ou o workspace dele não existe mais');
  toastRefusal(new Error('offline'));
  expect(toast.error).toHaveBeenLastCalledWith('não foi possível salvar a mudança; veja o hive.log');
});
