import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { CloseTabNotice, type CloseTabNoticeProps } from '@/components/CloseTabNotice';
import { setLanguage, t } from '@/i18n';

// The notice after a tab closes and its session keeps running (#614): a close that sleeps shows the sleep notice instead (#672)
const props = (patch: Partial<CloseTabNoticeProps> = {}): CloseTabNoticeProps => ({
  session: '9e03b7c2', where: '#11 Task 11',
  onReopen: vi.fn(), onSleep: vi.fn(), onSettings: vi.fn(), onDontWarn: vi.fn(async () => true), onClose: vi.fn(), ...patch,
});
const buttons = (): string[] => screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent ?? '');

beforeEach(() => setLanguage('pt'));

test('its title, the body naming the agent, the session and the task, reabrir, dormir no longer destructive, the link and the checkbox (#614, #672)', () => {
  render(<CloseTabNotice {...props()} />);
  expect(screen.getByText('tab fechada, sessão aberta')).toBeInTheDocument();
  expect(screen.getByText('claude 9e03b7c2 continua em #11 Task 11, na lateral, e pode ser retomada. fechar uma tab não encerra a sessão.')).toBeInTheDocument();
  expect(buttons()).toEqual(['Fechar', 'reabrir', 'dormir', 'mudar em configurações › sessões']);
  expect(screen.getByRole('button', { name: 'dormir' })).not.toHaveClass('text-destructive');
  expect(screen.getByRole('checkbox', { name: 'não avisar de novo' })).not.toBeChecked();
});

test('a stage session names its stage after the session, and a session not known yet reads the agent alone; in English too (#614)', () => {
  const { unmount } = render(<CloseTabNotice {...props({ stage: 'dev' })} />);
  expect(screen.getByText(/^claude 9e03b7c2 da etapa dev continua em #11 Task 11, na lateral/)).toBeInTheDocument();
  unmount();
  setLanguage('en');
  render(<CloseTabNotice {...props({ session: undefined, where: 'local', stage: 'dev' })} />);
  expect(screen.getByText('tab closed, session still open')).toBeInTheDocument();
  expect(screen.getByText(/^claude of the dev stage keeps running in local, in the sidebar/)).toBeInTheDocument();
});

test('each button calls its own callback, the X closes, and the checkbox reports its state (#614)', () => {
  const [onReopen, onSleep, onSettings, onClose] = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
  const onDontWarn = vi.fn(async () => true);
  render(<CloseTabNotice {...props({ onReopen, onSleep, onSettings, onClose, onDontWarn })} />);
  fireEvent.click(screen.getByRole('button', { name: t('closeTabNotice.reopen') }));
  fireEvent.click(screen.getByRole('button', { name: t('closeTabNotice.sleep') }));
  fireEvent.click(screen.getByRole('button', { name: t('closeTabNotice.settings') }));
  fireEvent.click(screen.getByRole('button', { name: t('center.close') }));
  expect([onReopen, onSleep, onSettings, onClose].map((f) => f.mock.calls.length)).toEqual([1, 1, 1, 1]);
  const box = screen.getByRole('checkbox', { name: t('closeTabNotice.dismiss') });
  fireEvent.click(box);
  expect(onDontWarn).toHaveBeenLastCalledWith(true);
  fireEvent.click(box);
  expect(onDontWarn).toHaveBeenLastCalledWith(false);
});

test('a failed save unticks the checkbox again, so it never shows a choice that was not saved (#614)', async () => {
  render(<CloseTabNotice {...props({ onDontWarn: vi.fn(async () => false) })} />);
  const box = screen.getByRole('checkbox', { name: t('closeTabNotice.dismiss') });
  fireEvent.click(box);
  await vi.waitFor(() => expect(box).not.toBeChecked());
});

test('without reabrir, the link or the save, the notice leaves them out; the countdown bar is always there (#614)', () => {
  const { container } = render(<CloseTabNotice {...props({ onReopen: undefined, onSettings: undefined, onDontWarn: undefined })} />);
  expect(buttons()).toEqual(['Fechar', 'dormir']);
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  expect(container.querySelector('.close-tab-countdown')).toHaveAttribute('aria-hidden', 'true');
});
