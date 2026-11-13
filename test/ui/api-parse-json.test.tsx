import { afterEach, expect, test } from 'vitest';
import { setLanguage } from '@/i18n';
import { parseJson } from '@/lib/api';
import { jsonResponse } from '../fakes';

// The language is module state: a test that switches it never leaks into the next
afterEach(() => { setLanguage('en'); });

const GONE = { error: 'workspace site is gone', code: 'workspace_gone', workspace: 'site' };

test('a 409 workspace_gone throws the i18n sentence with the workspace name, in English and in Portuguese; status, body and code stay attached (#748)', async () => {
  await expect(parseJson(jsonResponse(GONE, 409))).rejects.toMatchObject({ message: 'workspace site no longer exists', status: 409, body: GONE, code: 'workspace_gone' });
  setLanguage('pt');
  await expect(parseJson(jsonResponse(GONE, 409))).rejects.toMatchObject({ message: 'o workspace site não existe mais' });
});

test('a refusal with another code, with no code, or workspace_gone without a string workspace throws the server\'s error unchanged (#748)', async () => {
  await expect(parseJson(jsonResponse({ error: 'memória cheia', code: 'full' }, 409))).rejects.toMatchObject({ message: 'memória cheia', code: 'full' });
  await expect(parseJson(jsonResponse({ error: 'workspace site is gone' }, 409))).rejects.toMatchObject({ message: 'workspace site is gone' });
  await expect(parseJson(jsonResponse({ error: 'workspace site is gone', code: 'workspace_gone' }, 409))).rejects.toMatchObject({ message: 'workspace site is gone' });
});
