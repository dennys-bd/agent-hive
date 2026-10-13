import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { toast } from 'sonner';
import { TaskDescription } from '@/components/DescriptionCopy';
import { setLanguage } from '@/i18n';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const BODY = '# Title\n\nSome **bold** text';

beforeEach(() => {
  setLanguage('pt');
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, 'innerText');
});

// userEvent.setup installs its own clipboard; ours goes in after it
function clipboard(): { writeText: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn> } {
  const fake = { writeText: vi.fn(() => Promise.resolve()), write: vi.fn(() => Promise.resolve()) };
  Object.defineProperty(navigator, 'clipboard', { value: fake, configurable: true });
  return fake;
}

class FakeItem { constructor(readonly items: Record<string, Blob>) {} }

test('copiar markdown writes the body exactly as stored (#283)', async () => {
  const user = userEvent.setup();
  const fake = clipboard();
  render(<TaskDescription body={BODY} />);
  await user.click(screen.getByRole('button', { name: 'copiar markdown' }));
  await waitFor(() => expect(fake.writeText).toHaveBeenCalledWith(BODY));
  expect(toast.success).toHaveBeenCalledWith('copiado');
});

test('copiar writes the rendered description as html with a plain-text fallback (#283)', async () => {
  vi.stubGlobal('ClipboardItem', FakeItem);
  // jsdom has no innerText; Electron's keeps the block breaks, which textContent would lose
  Object.defineProperty(HTMLElement.prototype, 'innerText', { get(this: HTMLElement) { return this.textContent; }, configurable: true });
  const user = userEvent.setup();
  const fake = clipboard();
  render(<TaskDescription body={BODY} />);
  await user.click(screen.getByRole('button', { name: 'copiar' }));
  await waitFor(() => expect(fake.write).toHaveBeenCalledOnce());
  const [[item]] = fake.write.mock.calls[0] as [[FakeItem]];
  expect(await item.items['text/html']!.text()).toContain('<strong>bold</strong>');
  expect(await item.items['text/plain']!.text()).toContain('bold');
  expect(toast.success).toHaveBeenCalledWith('copiado');
});

test('a failed copy toasts the generic error, never the raw message (#283)', async () => {
  const user = userEvent.setup();
  const fake = clipboard();
  fake.writeText.mockRejectedValueOnce(new Error('NotAllowedError: raw'));
  render(<TaskDescription body={BODY} />);
  await user.click(screen.getByRole('button', { name: 'copiar markdown' }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Erro inesperado'));
});

test('an empty description shows sem descrição and no copy buttons (#283)', () => {
  render(<TaskDescription body={'  \n'} />);
  expect(screen.getByText('sem descrição')).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
});
