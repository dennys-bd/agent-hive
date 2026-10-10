import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MentionField } from '@/components/MentionField';
import { ReviewContext, type ReviewPane } from '@/components/review-context';
import { setLanguage } from '@/i18n';
import { caretRect } from '@/lib/caret';
import { EMPTY_REVIEW } from '@/lib/review-view';

// jsdom lays nothing out: the @'s box is what the mirror measurement would answer
vi.mock('@/lib/caret', () => ({ caretRect: vi.fn(() => ({ left: 140, top: 220, height: 20 })) }));

const S1 = 'e41f9a00-0000-4000-8000-000000000000';
const S2 = 'abcd1234-0000-4000-8000-000000000000';
const S3 = 'ffff0000-0000-4000-8000-000000000000';
const PANE: ReviewPane = {
  taskId: 'I1', scope: 'worktree', task: '#1 Task 1', review: EMPTY_REVIEW, defaultSession: S1, refresh: vi.fn(), edit: vi.fn(), isSending: false, track: (request) => request,
  sessions: [{ id: S1, status: 'working', lastUsedAt: 'T' }, { id: S2, status: 'empty', lastUsedAt: 'T' }, { id: S3, status: 'empty', lastUsedAt: 'T' }],
};
const ICON = 'svg[data-icon="claude"]';
// A chip as the field's text holds it: @, the em space its icon is drawn over, ·, four characters
const chip = (id: string): string => `@\u2003·${id}`;
// The backdrop draws the text behind the transparent textarea; the chip is there, in the text's flow, with no role
const chipEl = (id: string): HTMLElement => screen.getByText((_, el) => el?.getAttribute('data-slot') === 'mention-chip' && el.textContent === chip(id));

function Field({ seen, onKeyDown }: { seen(value: string, chips: string[]): void; onKeyDown?(): void }) {
  const [state, setState] = useState({ value: '', chips: [] as string[] });
  return (
    <ReviewContext.Provider value={PANE}>
      <MentionField
        label="comentário" value={state.value} chips={state.chips} participants={[S2]} onKeyDown={onKeyDown}
        onChange={(value, chips) => { setState({ value, chips }); seen(value, chips); }}
      />
    </ReviewContext.Provider>
  );
}
const setup = () => {
  const seen = vi.fn();
  const onKeyDown = vi.fn();
  render(<Field seen={seen} onKeyDown={onKeyDown} />);
  return { user: userEvent.setup(), seen, onKeyDown, field: screen.getByRole('textbox', { name: 'comentário' }) };
};
const selected = (): string | null => screen.getAllByRole('option').find((o) => o.getAttribute('aria-selected') === 'true')?.textContent ?? null;

const VIEWPORT = { clientWidth: 1024, clientHeight: 768 };
beforeEach(() => {
  setLanguage('pt');
  // jsdom's viewport is 0×0, which would overflow every side; the popper reads it from the root's client box
  for (const [key, value] of Object.entries(VIEWPORT)) Object.defineProperty(document.documentElement, key, { value, configurable: true });
});
afterEach(() => { vi.mocked(caretRect).mockClear(); vi.mocked(caretRect).mockImplementation(() => ({ left: 140, top: 220, height: 20 })); });

test('the list opens below the typed @ with its left edge on it, and flips above when there is no room below (#591)', async () => {
  const { user, field } = setup();
  await user.type(field, 'see @');
  expect(caretRect).toHaveBeenCalledWith(field, 4); // the @, not the caret after it
  const content = screen.getByRole('listbox', { name: 'sessões de #1 Task 1' }).closest<HTMLElement>('[data-side]');
  await waitFor(() => expect(content?.parentElement?.style.transform).toMatch(/^translate\(140px, 2\d\dpx\)$/));
  expect(content).toHaveAttribute('data-side', 'bottom');
  expect(content).toHaveAttribute('data-align', 'start');
  await user.keyboard('{Escape}');
  vi.mocked(caretRect).mockImplementation(() => ({ left: 140, top: VIEWPORT.clientHeight - 10, height: 20 }));
  await user.type(field, ' @');
  const flipped = screen.getByRole('listbox').closest('[data-side]');
  await waitFor(() => expect(flipped).toHaveAttribute('data-side', 'top'));
});

test('each row: the agent\'s icon, claude, the id in mono, and nesta conversa or the status with its dot; then nova sessão and the hint (#591)', async () => {
  const { user, field } = setup();
  await user.type(field, '@');
  const [working, participant, stopped, fresh] = screen.getAllByRole('option');
  expect(working.querySelector(ICON)).not.toBeNull();
  expect(within(working).getByText('e41f9a00')).toHaveClass('font-mono');
  expect(working).toHaveTextContent(/^claude e41f9a00trabalhando$/);
  expect(within(working).getByText('trabalhando')).toHaveClass('text-working');
  expect(participant).toHaveTextContent(/^claude abcd1234nesta conversa$/);
  expect(stopped).toHaveTextContent(/^claude ffff0000parada$/);
  expect(fresh).toHaveTextContent(/^nova sessão claude.*N/);
  expect(screen.getByText('↑↓ escolher · tab ou ↵ inserir · esc fechar')).toBeInTheDocument();
});

test('the first row starts selected and again after each filter change; ↑ ↓ move it and wrap (#591)', async () => {
  const { user, field } = setup();
  await user.type(field, '@');
  expect(selected()).toMatch(/e41f9a00/);
  await user.keyboard('{ArrowDown}');
  expect(selected()).toMatch(/abcd1234/);
  expect(field).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[1].id);
  await user.keyboard('{ArrowUp}{ArrowUp}');
  expect(selected()).toMatch(/^nova sessão/); // wraps from the first to the last
  await user.keyboard('{ArrowDown}');
  expect(selected()).toMatch(/e41f9a00/); // and from the last to the first
  await user.keyboard('{ArrowDown}ff');
  expect(selected()).toMatch(/ffff0000/);
});

test('Tab or ↵ insert the selected chip, and ↵ never reaches the field\'s send (#591)', async () => {
  const { user, field, seen, onKeyDown } = setup();
  await user.type(field, 'see @');
  await user.keyboard('{ArrowDown}{Tab}');
  expect(seen).toHaveBeenLastCalledWith(`see ${chip('abcd')} `, [S2]);
  expect(chipEl('abcd')).toHaveClass('text-ring', 'bg-ring/15');
  expect(chipEl('abcd').querySelector(ICON)).not.toBeNull(); // @ + the agent's icon + · + four characters
  await user.type(field, '@ffff{Enter}');
  expect(seen).toHaveBeenLastCalledWith(`see ${chip('abcd')} ${chip('ffff')} `, [S2, S3]);
  expect(onKeyDown).not.toHaveBeenCalledWith(expect.objectContaining({ key: 'Enter' }));
  expect(screen.queryByRole('listbox')).toBeNull();
});

test('Esc closes and keeps the typed @cl, which stays closed while typed on; a space closes without inserting (#591)', async () => {
  const { user, field, seen, onKeyDown } = setup();
  await user.type(field, 'ask @cl');
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(field).toHaveValue('ask @cl');
  expect(onKeyDown).not.toHaveBeenCalledWith(expect.objectContaining({ key: 'Escape' })); // the comment box's own Esc would close the box
  await user.type(field, 'a');
  expect(screen.queryByRole('listbox')).toBeNull();
  await user.type(field, ' @');
  expect(screen.getByRole('listbox')).toBeInTheDocument();
  await user.type(field, ' ');
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(seen).toHaveBeenLastCalledWith('ask @cla @ ', []);
});

test('Backspace right after a chip deletes it whole; the newSession key picks nova sessão while the list is open (#591)', async () => {
  const { user, field, seen } = setup();
  await user.type(field, '@');
  await user.keyboard('{Control>}{Alt>}{Shift>}N{/Shift}{/Alt}{/Control}'); // newSession off macOS (#585)
  expect(seen).toHaveBeenLastCalledWith(`${chip('nova')} `, ['new']);
  expect(chipEl('nova')).toBeInTheDocument();
  await user.keyboard('{Backspace}');
  expect(seen).toHaveBeenLastCalledWith(chip('nova'), ['new']);
  await user.keyboard('{Backspace}');
  expect(seen).toHaveBeenLastCalledWith('', []);
});

test('the chip sits in the text where its @ was typed, drawn by a backdrop laid out as the field; typing goes on after it (#591)', async () => {
  const { user, field, seen } = setup();
  await user.type(field, 'ask @');
  await user.keyboard('{Tab}');
  await user.type(field, 'why');
  expect(seen).toHaveBeenLastCalledWith(`ask ${chip('e41f')} why`, [S1]);
  const backdrop = chipEl('e41f').parentElement as HTMLElement;
  expect(backdrop).toHaveAttribute('aria-hidden', 'true');
  expect(backdrop.textContent).toBe(`ask ${chip('e41f')} why\u200b`);
  // The textarea's own glyphs are transparent over it, its caret is not; both lay text out alike, so the chip wraps as a word
  expect(field).toHaveClass('text-transparent', 'caret-foreground');
  for (const layout of ['whitespace-pre-wrap', 'break-words', 'px-2', 'py-1', 'text-[13px]', 'leading-[19px]']) {
    expect(field).toHaveClass(layout);
    expect(backdrop).toHaveClass(layout);
  }
  expect(field.parentElement).toBe(backdrop.parentElement); // no chip row beside the field
});

test('text typed inside a chip breaks it: the chip is dropped and its characters stay as text (#591)', async () => {
  const { user, field, seen } = setup();
  await user.type(field, '@');
  await user.keyboard('{Tab}');
  await user.type(field, 'x', { initialSelectionStart: 1, initialSelectionEnd: 1 });
  expect(seen).toHaveBeenLastCalledWith(`@x\u2003·e41f `, []);
});

test('the field grows with its text up to 5 lines of 19px, then scrolls, and the backdrop scrolls with it (#591)', async () => {
  const { user, field } = setup();
  await user.type(field, 'one');
  const backdrop = screen.getByText((_, el) => el?.getAttribute('aria-hidden') === 'true' && el.textContent === 'one​');
  // Its content sizes it; 5 lines of 19px and the 4px paddings cap it; past them it scrolls, both layers keeping the scrollbar's room
  expect(field).toHaveClass('[field-sizing:content]', 'max-h-[103px]', 'overflow-y-auto', '[scrollbar-gutter:stable]');
  expect(backdrop).toHaveClass('[scrollbar-gutter:stable]');
  Object.defineProperty(field, 'scrollTop', { value: 40, configurable: true });
  Object.defineProperty(backdrop, 'scrollTop', { value: 0, writable: true, configurable: true });
  fireEvent.scroll(field);
  expect(backdrop.scrollTop).toBe(40);
});
