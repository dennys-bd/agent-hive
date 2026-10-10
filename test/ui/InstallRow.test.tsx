import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { InstallRow } from '@/components/settings/InstallRow';
import { setLanguage } from '@/i18n';
import type { InstallState } from '../../src/types';

beforeEach(() => setLanguage('pt'));

const row = (state: InstallState | undefined, onAct = vi.fn(), extra: { isOff?: boolean } = {}) =>
  render(<InstallRow name="pyright" via="pacote npm" state={state} requiresHint="o pyright se instala com npm: instale o node e verifique de novo" onAct={onAct} {...extra} />);

test('each state\'s text and actions; an action calls back with it (#780)', async () => {
  const user = userEvent.setup();
  const cases: [InstallState, string, string[]][] = [
    [{ state: 'absent' }, 'não instalado', ['instalar']],
    [{ state: 'installing', percent: 62 }, 'instalando… 62%', ['cancelar']],
    [{ state: 'installing' }, 'instalando…', ['cancelar']],
    [{ state: 'installed', version: '1.2.3' }, 'instalado · v1.2.3', ['remover']],
    [{ state: 'installed', version: '1.2.3', latest: '1.3.0' }, 'atualização disponível · v1.3.0', ['atualizar', 'remover']],
    [{ state: 'requires', tool: 'node' }, 'requer node', ['verificar de novo']],
    [{ state: 'failed', version: '1.3.0', step: 'npm install', log: 'npm ERR!\nnpm exited with code 1' }, 'falhou', ['ver log', 'tentar de novo']],
    [{ state: 'builtin' }, 'embutida no editor', []],
  ];
  for (const [state, text, actions] of cases) {
    const { unmount } = row(state);
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.queryAllByRole('button').map((b) => b.textContent)).toEqual(actions);
    unmount();
  }
  const onAct = vi.fn();
  row({ state: 'installed', version: '1.2.3', latest: '1.3.0' }, onAct);
  await user.click(screen.getByRole('button', { name: 'atualizar' }));
  expect(onAct).toHaveBeenCalledWith('update');
});

test('a failure shows where it stopped and its log on demand; requires its hint; installing its progress; installed in no workspace reads off everywhere (#780)', async () => {
  const user = userEvent.setup();
  const { unmount } = row({ state: 'failed', version: '1.3.0', step: 'npm install', log: 'npm ERR!\nnpm exited with code 1' });
  expect(screen.getByText('v1.3.0 · npm install')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'ver log' }));
  expect(screen.getByText(/npm exited with code 1/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'esconder log' })).toBeInTheDocument();
  unmount();
  row({ state: 'requires', tool: 'node' }).unmount();
  row({ state: 'installing', percent: 62 });
  expect(screen.getByRole('progressbar', { name: 'progresso de pyright' })).toHaveAttribute('aria-valuenow', '62');
  row({ state: 'installed', version: '1.2.3' }, vi.fn(), { isOff: true });
  expect(screen.getByText('desligado em todos')).toBeInTheDocument();
});

test('an install with no percent shows an indeterminate bar, in both languages (#780)', () => {
  const { unmount } = row({ state: 'installing' });
  const bar = screen.getByRole('progressbar', { name: 'progresso de pyright' });
  expect(bar).not.toHaveAttribute('aria-valuenow');
  expect(bar).toHaveAttribute('data-state', 'indeterminate');
  unmount();
  setLanguage('en');
  row({ state: 'installing' });
  expect(screen.getByText('installing…')).toBeInTheDocument();
});
