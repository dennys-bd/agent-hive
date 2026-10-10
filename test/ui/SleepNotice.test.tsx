import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { SleepNotice, type SleepNoticeProps } from '@/components/SleepNotice';
import { setLanguage, t } from '@/i18n';

// The sleep notice's view (#672), with the user's image's words: claude 9e03b7c2 of task #11
const props = (patch: Partial<SleepNoticeProps> = {}): SleepNoticeProps => ({
  sessions: [{ session: '9e03b7c2' }], where: '#11 Task 11', hasTab: true,
  onContinue: vi.fn(), onSettings: vi.fn(), onDontWarn: vi.fn(async () => true), onClose: vi.fn(), ...patch,
});
const buttons = (): string[] => screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent ?? '');

beforeEach(() => setLanguage('pt'));

test('one session with its tab open: sessão dormindo, the tab sentence, continuar, the link and the checkbox, nothing destructive (#672)', () => {
  render(<SleepNotice {...props()} />);
  expect(screen.getByText('sessão dormindo')).toBeInTheDocument();
  expect(screen.getByText('claude 9e03b7c2 dormiu em #11 Task 11. a tab e o transcript continuam abertos, e clicar na tab continua a sessão.')).toBeInTheDocument();
  expect(buttons()).toEqual(['Fechar', 'continuar', 'mudar em configurações › sessões']);
  expect(screen.getByRole('button', { name: 'continuar' })).not.toHaveClass('text-destructive');
  expect(screen.getByRole('checkbox', { name: 'não avisar de novo' })).not.toBeChecked();
});

test('one session with no tab open sleeps in the sidebar; a stage session names its stage; in English too (#672)', () => {
  const { unmount } = render(<SleepNotice {...props({ hasTab: false, sessions: [{ session: '9e03b7c2', stage: 'dev' }] })} />);
  expect(screen.getByText('claude 9e03b7c2 da etapa dev está dormindo em #11 Task 11, na lateral, e pode ser continuada.')).toBeInTheDocument();
  unmount();
  setLanguage('en');
  render(<SleepNotice {...props({ where: 'local' })} />);
  expect(screen.getByText('session sleeping')).toBeInTheDocument();
  expect(screen.getByText('claude 9e03b7c2 fell asleep in local. the tab and the transcript stay open, and clicking the tab continues the session.')).toBeInTheDocument();
});

test('several sessions: the count in the title, the sessions listed with commas and e, continuar todas (#672)', () => {
  render(<SleepNotice {...props({ sessions: [{ session: 'aaaaaaaa' }, { session: 'bbbbbbbb' }, { session: 'cccccccc', stage: 'dev' }] })} />);
  expect(screen.getByText('sessões dormindo · 3')).toBeInTheDocument();
  expect(screen.getByText('claude aaaaaaaa, claude bbbbbbbb e claude cccccccc da etapa dev dormiram em #11 Task 11. as tabs e os transcripts continuam abertos, e clicar em cada tab continua a sessão.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'continuar todas' })).toBeInTheDocument();
});

test('each button calls back, the X closes, the checkbox reports its state; with nothing to continue there is no button (#672)', () => {
  const [onContinue, onSettings, onClose] = [vi.fn(), vi.fn(), vi.fn()];
  const onDontWarn = vi.fn(async () => true);
  const { unmount } = render(<SleepNotice {...props({ onContinue, onSettings, onClose, onDontWarn })} />);
  fireEvent.click(screen.getByRole('button', { name: t('session.continue') }));
  fireEvent.click(screen.getByRole('button', { name: t('closeTabNotice.settings') }));
  fireEvent.click(screen.getByRole('button', { name: t('center.close') }));
  expect([onContinue, onSettings, onClose].map((f) => f.mock.calls.length)).toEqual([1, 1, 1]);
  fireEvent.click(screen.getByRole('checkbox', { name: t('closeTabNotice.dismiss') }));
  expect(onDontWarn).toHaveBeenLastCalledWith(true);
  unmount();
  render(<SleepNotice {...props({ onContinue: undefined })} />);
  expect(screen.queryByRole('button', { name: t('session.continue') })).not.toBeInTheDocument();
});
