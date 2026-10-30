import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';
import { ChipList } from '@/components/benchmark/arms/ChipList';
import { setLanguage } from '@/i18n';

beforeEach(() => setLanguage('pt'));
function Harness({ start, options }: { start: string[]; options?: string[] }) {
  const [value, setValue] = useState(start);
  return <><ChipList id="c" addLabel="adicionar regra" placeholder="+ regra" value={value} onChange={setValue} options={options} /><output>{value.join('|')}</output></>;
}

test('adding and removing a chip; Enter on a blank, a repeat or an unlisted name adds nothing (#536)', async () => {
  const user = userEvent.setup();
  render(<Harness start={['Read']} options={['Read', 'Edit']} />);
  const add = screen.getByRole('combobox', { name: 'adicionar regra' }); // an input with a datalist is a combobox
  await user.type(add, 'Edit{Enter}');
  expect(screen.getByRole('status')).toHaveTextContent('Read|Edit');
  await user.type(add, 'Read{Enter}   {Enter}Nope{Enter}');
  expect(screen.getByRole('status')).toHaveTextContent('Read|Edit');
  await user.click(screen.getByRole('button', { name: 'tirar Read' }));
  expect(screen.getByRole('status')).toHaveTextContent(/^Edit$/);
});

test('without options any trimmed text is added', async () => {
  const user = userEvent.setup();
  render(<Harness start={[]} />);
  await user.type(screen.getByRole('textbox', { name: 'adicionar regra' }), '  Bash(gh:*) {Enter}');
  expect(screen.getByRole('status')).toHaveTextContent('Bash(gh:*)');
});

test('past the limit the rest collapse to mais N, which opens them and then reads menos (#536)', async () => {
  const user = userEvent.setup();
  render(<Harness start={Array.from({ length: 10 }, (_, i) => `R${i}`)} />);
  expect(screen.queryByText('R9')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'mais 3' }));
  expect(screen.getByText('R9')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'menos' })).toHaveAttribute('aria-expanded', 'true');
});

test('read only: no ×, no add field; an empty list reads nenhum (#536)', () => {
  render(<ChipList id="c" addLabel="a" placeholder="p" value={[]} onChange={() => undefined} isReadOnly />);
  expect(screen.getByText('nenhum')).toBeInTheDocument();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
});

test('read only with pillOf: every chip is the caller\'s, repeats included, and the list still folds (#537)', async () => {
  const user = userEvent.setup();
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const value = ['x', 'x', ...Array.from({ length: 8 }, (_, i) => `R${i}`)];
  render(<ChipList id="c" addLabel="" placeholder="" value={value} onChange={() => undefined} isReadOnly pillOf={(chip) => <mark>{chip}</mark>} />);
  expect(screen.getAllByText('x').map((el) => el.tagName)).toEqual(['MARK', 'MARK']);
  await user.click(screen.getByRole('button', { name: 'mais 3' }));
  expect(screen.getAllByText(/^R\d$/)).toHaveLength(8);
  expect(errors).not.toHaveBeenCalled(); // no duplicate-key warning
  errors.mockRestore();
});

test('isMono off drops the mono font from the chips and the add field (#537)', () => {
  render(<ChipList id="c" addLabel="adicionar critério" placeholder="+ critério" value={['código']} onChange={() => undefined} isMono={false} />);
  expect(screen.getByText('código')).not.toHaveClass('font-mono');
  expect(screen.getByRole('textbox', { name: 'adicionar critério' })).not.toHaveClass('font-mono');
});

test('× removes only its own chip when the loaded list repeats a value (#537)', async () => {
  const user = userEvent.setup();
  render(<Harness start={['a', 'b', 'a']} />);
  await user.click(screen.getAllByRole('button', { name: 'tirar a' })[0] as HTMLElement);
  expect(screen.getByRole('status')).toHaveTextContent('b|a');
});
