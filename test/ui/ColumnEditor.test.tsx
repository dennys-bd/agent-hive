import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { ColumnEditor } from '@/components/setup/ColumnEditor';
import { FromMultiSelect } from '@/components/setup/FromMultiSelect';
import { setLanguage } from '@/i18n';
import { type ColumnDraft, emptyColumn } from '@/lib/setup-form';

beforeEach(() => setLanguage('pt'));

const column = (name: string, extra: Partial<ColumnDraft> = {}): ColumnDraft => ({ ...emptyColumn(), name, ...extra });

test('FromMultiSelect lists the loaded options plus a saved value that is not among them, and toggles on click', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<FromMultiSelect value={['Ready', 'Old']} options={['Ready', 'In progress']} onChange={onChange} />);
  const trigger = screen.getByRole('combobox');
  expect(trigger).toHaveTextContent('Ready');
  expect(trigger).toHaveTextContent('Old');
  await user.click(trigger);
  const items = screen.getAllByRole('option');
  expect(items.map((i) => i.textContent)).toEqual(['Ready', 'In progress', 'Old']);
  await user.click(screen.getByRole('option', { name: 'In progress' }));
  expect(onChange).toHaveBeenLastCalledWith(['Ready', 'Old', 'In progress']);
  await user.click(screen.getByRole('option', { name: 'Ready' }));
  expect(onChange).toHaveBeenLastCalledWith(['Old']);
});

test('adding, moving and removing rows reach onChange with the new list, in order', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  const columns = [column('spec', { weight: '5' }), column('dev')];
  const { rerender } = render(<ColumnEditor columns={columns} options={['Ready']} onChange={onChange} />);
  expect(screen.getAllByLabelText('nome').map((el) => (el as HTMLInputElement).value)).toEqual(['spec', 'dev']);
  await user.click(screen.getByRole('button', { name: '+ coluna' }));
  expect(onChange).toHaveBeenLastCalledWith([...columns, emptyColumn()]);
  const rows = screen.getAllByTestId('column-row');
  await user.click(within(rows[1]).getByRole('button', { name: '↑' }));
  expect(onChange).toHaveBeenLastCalledWith([columns[1], columns[0]]);
  await user.click(within(rows[0]).getByRole('button', { name: '↓' }));
  expect(onChange).toHaveBeenLastCalledWith([columns[1], columns[0]]);
  await user.click(within(rows[0]).getByRole('button', { name: 'remover' }));
  expect(onChange).toHaveBeenLastCalledWith([columns[1]]);
  await user.clear(within(rows[0]).getByLabelText('peso'));
  await user.type(within(rows[0]).getByLabelText('peso'), '7');
  expect(onChange).toHaveBeenLastCalledWith([{ ...columns[0], weight: '7' }, columns[1]]);
  rerender(<ColumnEditor columns={[]} options={[]} onChange={onChange} />);
  expect(screen.queryAllByTestId('column-row')).toHaveLength(0);
});
