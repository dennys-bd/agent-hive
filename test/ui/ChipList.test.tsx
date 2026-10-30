import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, expect, test } from 'vitest';
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
