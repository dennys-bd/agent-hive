import { afterEach, expect, test, vi } from 'vitest';
import { applySyntax } from '@/lib/monaco-textmate';

const loadWASM = vi.hoisted(() => vi.fn());
vi.mock('vscode-oniguruma', () => ({ loadWASM, createOnigScanner: vi.fn(), createOnigString: vi.fn() }));
vi.mock('vscode-oniguruma/release/onig.wasm?url', () => ({ default: '/onig.wasm' }));

const MANIFEST = { contributes: { grammars: [{ language: 'python', scopeName: 'source.python', path: './g.json' }], languages: [{ id: 'python', extensions: ['.py'] }] } };
const api = { setTokensProvider: vi.fn(), setLanguageConfiguration: vi.fn() };

afterEach(() => { vi.unstubAllGlobals(); loadWASM.mockReset(); });

test('a failed load of the oniguruma wasm is not kept: the next file opened loads it again (#780)', async () => {
  loadWASM.mockRejectedValue(new Error('wasm failed'));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.endsWith('package.json') ? new Response(JSON.stringify(MANIFEST)) : new Response(new ArrayBuffer(1)))));
  await applySyntax(api as never, 'vscode.python', 'python', '.py');
  await applySyntax(api as never, 'vscode.python', 'python', '.py');
  expect(loadWASM).toHaveBeenCalledTimes(2);
  expect(api.setTokensProvider).not.toHaveBeenCalled();
});
