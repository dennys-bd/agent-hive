import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { EditorLanguagesContext } from '@/components/editor-languages';
import { Checkers } from '@/components/footer/Checkers';
import { ConsoleContext } from '@/hooks/use-console';
import { setLanguage } from '@/i18n';
import * as store from '@/lib/diagnostics-store';
import { EDITOR_DEFAULTS } from '../../src/types';

const A = 'a-I1';
const LOG = { channel: 'lsp:hive:ts', run: 'r1' };
const checkers = (activityId: string | undefined, openConsole = vi.fn(), openLanguage = vi.fn()) => render(
  <ConsoleContext.Provider value={openConsole}>
    <EditorLanguagesContext.Provider value={{ editor: EDITOR_DEFAULTS, openLanguage }}><Checkers activityId={activityId} /></EditorLanguagesContext.Provider>
  </ConsoleContext.Provider>,
);

beforeEach(() => setLanguage('pt'));
afterEach(() => store.resetDiagnostics());

test('the group renders nothing without an activity, nor for an activity with no server or checker (#225)', () => {
  act(() => store.setClient('k', A, 'typescript-language-server', { phase: 'ready' }));
  const shown = checkers(undefined);
  expect(shown.container).toBeEmptyDOMElement();
  shown.unmount();
  expect(checkers('a-other').container).toBeEmptyDOMElement();
});

test('one item per entry: ready by name with the working dot, starting with iniciando, a running command-line checker with executando (#225)', () => {
  act(() => {
    store.setClient('k', A, 'typescript-language-server', { phase: 'starting' });
    store.setClient('b', A, 'biome', { phase: 'ready' }, undefined, 'biome');
    store.checkStarted(A, 'tsc', '');
  });
  checkers(A);
  expect(screen.getByText('typescript-language-server · iniciando').querySelector('span')).toHaveClass('bg-empty');
  expect(screen.getByText('biome').querySelector('span')).toHaveClass('bg-working');
  expect(screen.getByText('tsc · executando')).toBeInTheDocument();
});

test('a failed item with a log is a button that opens its channel in the console, its title the reason and the hint; without a log, plain text (#225)', async () => {
  const user = userEvent.setup();
  const openConsole = vi.fn();
  act(() => {
    store.setClient('k', A, 'typescript-language-server', { phase: 'failed', reason: 'spawn node ENOENT' }, LOG);
    store.setCheck(A, 'tsc', { state: 'failed', reason: 'exit code 2' }, '');
  });
  checkers(A, openConsole);
  const failed = screen.getByRole('button', { name: 'typescript-language-server falhou' });
  expect(failed).toHaveAttribute('title', 'spawn node ENOENT · clique para abrir o canal typescript-language-server no console');
  expect(failed).toHaveClass('text-destructive');
  await user.click(failed);
  expect(openConsole).toHaveBeenCalledWith('lsp:hive:ts', 'r1', true);
  expect(screen.queryByRole('button', { name: 'tsc falhou' })).not.toBeInTheDocument();
  expect(screen.getByText('tsc falhou')).toHaveAttribute('title', 'exit code 2');
});

test('the language\'s server absent reads sem language server with instalar…, which opens Settings on its language; a checker absent shows nothing (#225)', async () => {
  const user = userEvent.setup();
  const openLanguage = vi.fn();
  act(() => {
    store.setClient('k', A, 'typescript-language-server', { phase: 'absent', reason: 'not installed' });
    store.bindFile(A, 'a.ts', 'k', 'typescript');
    store.setClient('e', A, 'eslint', { phase: 'absent', reason: 'not installed' }, undefined, 'eslint');
  });
  checkers(A, vi.fn(), openLanguage);
  expect(screen.getByText('sem language server')).toHaveAttribute('title', 'not installed');
  expect(screen.queryByText(/eslint/)).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'instalar typescript-language-server…' }));
  expect(openLanguage).toHaveBeenCalledWith('typescript');
});
