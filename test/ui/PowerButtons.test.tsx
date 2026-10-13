import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PowerButtons } from '@/components/footer/PowerButtons';
import { setLanguage, t } from '@/i18n';

const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }));
const posted = (path: string, body: unknown) => waitFor(() => expect(fetchMock).toHaveBeenCalledWith(path, expect.objectContaining({ body: JSON.stringify(body) })));

beforeEach(() => { setLanguage('pt'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

test('off: two icon-only buttons, coffee then power, muted, titled with what they would do (#226)', () => {
  render(<PowerButtons keepAwake={false} armed={false} />);
  const [awake, shutdown] = screen.getAllByRole('button');
  expect(awake).toHaveAccessibleName('manter ligado: sem hibernar e sem desligar a tela');
  expect(shutdown).toHaveAccessibleName('desligar o computador quando todas as sessões terminarem');
  expect(awake).toHaveAttribute('title', t('power.keepAwake.off'));
  expect(shutdown).toHaveAttribute('title', t('power.shutdown.off'));
  for (const button of [awake, shutdown]) {
    expect(button.textContent).toBe('');
    expect(button).toHaveClass('text-muted-foreground');
  }
});

test('on: keep awake in working and shutdown in waiting, each over 16% of its colour, titled with how to turn it off (#226)', () => {
  render(<PowerButtons keepAwake armed />);
  const awake = screen.getByRole('button', { name: 'mantendo ligado: sem hibernar e sem desligar a tela · clique para desligar' });
  const shutdown = screen.getByRole('button', { name: 'desligando quando os workers terminarem · clique para cancelar' });
  expect(awake).toHaveAttribute('title', t('power.keepAwake.on'));
  expect(shutdown).toHaveAttribute('title', t('power.shutdown.on'));
  expect(awake).toHaveClass('border-working', 'bg-working/16', 'text-working');
  expect(shutdown).toHaveClass('border-waiting', 'bg-waiting/16', 'text-waiting');
});

test('keep awake toggles with one click and no confirm, both ways (#226)', async () => {
  const user = userEvent.setup();
  const { rerender } = render(<PowerButtons keepAwake={false} armed={false} />);
  await user.click(screen.getByRole('button', { name: t('power.keepAwake.off') }));
  await posted('/keep-awake', { on: true });
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  rerender(<PowerButtons keepAwake armed={false} />);
  await user.click(screen.getByRole('button', { name: t('power.keepAwake.on') }));
  await posted('/keep-awake', { on: false });
});

test('shutdown asks before arming; armed, a click cancels at once (#226)', async () => {
  const user = userEvent.setup();
  const { rerender } = render(<PowerButtons keepAwake={false} armed={false} />);
  await user.click(screen.getByRole('button', { name: t('power.shutdown.off') }));
  expect(fetchMock).not.toHaveBeenCalled();
  await user.click(await screen.findByRole('button', { name: t('shutdown.arm') }));
  await posted('/shutdown', { armed: true });
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  rerender(<PowerButtons keepAwake={false} armed />);
  await user.click(screen.getByRole('button', { name: t('power.shutdown.on') }));
  await posted('/shutdown', { armed: false });
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
});
