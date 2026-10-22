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
