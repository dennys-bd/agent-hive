import { screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setLanguage } from '@/i18n';
import { CONFIG, renderConfig } from './benchmark-config-fixtures';

beforeEach(() => setLanguage('pt'));
afterEach(() => vi.unstubAllGlobals());

test('while the experiment runs or sleeps the locked note sits on top; a done one has none (#463)', () => {
  const { rerender } = renderConfig({ ...CONFIG, status: 'running' });
  expect(screen.getByText('a config trava enquanto o experimento executa')).toBeInTheDocument();
  rerender({ ...CONFIG, status: 'sleeping' });
  expect(screen.getByText('a config trava enquanto o experimento executa')).toBeInTheDocument();
  rerender(CONFIG);
  expect(screen.queryByText('a config trava enquanto o experimento executa')).not.toBeInTheDocument();
});

test('while running no editar, trocar or editar cenários is drawn in any section, the switch and julgar de novo are off, the rows still read (#463)', () => {
  renderConfig({ ...CONFIG, status: 'running' });
  expect(screen.queryAllByRole('button', { name: /^(editar|trocar|editar cenários)$/ })).toEqual([]);
  expect(screen.getByRole('switch', { name: 'cegueira' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'julgar de novo sem executar' })).toBeDisabled();
  expect(screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))).toEqual(['seed', 'ritmo', 'isolamento', 'cegueira', 'avaliação']);
});
