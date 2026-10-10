import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { MultiSelect } from '@/components/settings/MultiSelect';
import { setLanguage, t } from '@/i18n';

beforeEach(() => setLanguage('pt'));

test('MultiSelect lists the loaded options plus a saved value that is not among them, and toggles on click', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<MultiSelect value={['Ready', 'Old']} options={['Ready', 'In progress']} onChange={onChange} />);
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
  await user.keyboard('{Escape}'); // close it: an open popover left mounted at cleanup can swallow the next test's first click
});

test('MultiSelect with allowTyped offers typed text that matches no listed value as "adicionar", trimmed, and clears it once added (#245)', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<MultiSelect allowTyped ariaLabel="valores" value={['blocked']} options={['blocked', 'Bug']} onChange={onChange} />);
  await user.click(screen.getByRole('combobox', { name: 'valores' }));
  const search = screen.getByPlaceholderText(t('settings.filter.typed'));
  await user.type(search, 'bug');
  expect(screen.queryByRole('option', { name: t('settings.filter.addValue', { value: 'bug' }) })).not.toBeInTheDocument(); // Bug is listed: pick it
  await user.clear(search);
  await user.type(search, '  wontfix ');
  await user.click(screen.getByRole('option', { name: t('settings.filter.addValue', { value: 'wontfix' }) }));
  expect(onChange).toHaveBeenLastCalledWith(['blocked', 'wontfix']);
  expect(search).toHaveValue('');
  await user.keyboard('{Escape}');
});

test('MultiSelect labelOf shows labels on the chips and the options while onChange gets the raw values; placeholder replaces nenhum when empty (#515)', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  const labelOf = (v: string): string => v.replace(':', ' · ');
  const { rerender } = render(<MultiSelect value={['h:Ready']} options={['h:Ready', 'c:todo']} labelOf={labelOf} onChange={onChange} />);
  const trigger = screen.getByRole('combobox');
  expect(trigger).toHaveTextContent('h · Ready');
  await user.click(trigger);
  expect(screen.getAllByRole('option').map((i) => i.textContent)).toEqual(['h · Ready', 'c · todo']);
  await user.click(screen.getByRole('option', { name: 'c · todo' }));
  expect(onChange).toHaveBeenLastCalledWith(['h:Ready', 'c:todo']);
  await user.keyboard('{Escape}');
  rerender(<MultiSelect value={[]} options={['h:Ready']} placeholder="adicionar coluna" onChange={onChange} />);
  expect(screen.getByRole('combobox')).toHaveTextContent('adicionar coluna');
  expect(screen.getByRole('combobox')).not.toHaveTextContent(t('settings.stages.none'));
});
