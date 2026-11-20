import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { parseTemplate } from '../../src/template';
import { type EditResult, removeChain } from '../../src/template-edit';
import { buildMap } from '../../src/template-map';
import { chainsOf } from '../../src/template-preview';
import { ConditionPopover } from '@/components/plugins/ConditionPopover';
import { setLanguage } from '@/i18n';
import { formVariables } from '@/lib/chain-draft';

const HEADER = ['---', 'variables:', '  delivery: { values: [pr, stacked], default: pr, workspaces: { hive-site: stacked } }', '  quick: { type: boolean }', '---'];
const WORKSPACES = ['agent-hive', 'hive-site'];
function popoverOn(condition: string) {
  const text = [...HEADER, `{% if ${condition} %}`, 'A.', '{% else %}', 'B.', '{% endif %}', ''].join('\n');
  const parsed = parseTemplate(text);
  const [chain] = chainsOf(buildMap(parsed).blocks);
  const handlers = { onOk: vi.fn((): EditResult => removeChain(text, 6)), onRemove: vi.fn((): EditResult => removeChain(text, 6)), onClose: vi.fn(), onReveal: vi.fn() };
  render(<ConditionPopover chain={chain!} parsed={parsed} variables={formVariables(parsed.variables, WORKSPACES)} workspaces={WORKSPACES} {...handlers} />);
  return handlers;
}

beforeEach(() => setLanguage('pt'));

test('a condition the form cannot hold shows each conditional block read-only with its reach, the text-mode note and only "remove condition" (#322, decisions 14, 18)', () => {
  const { onOk, onRemove, onClose } = popoverOn('delivery == "stacked" or quick and workspace == "x"');
  expect(screen.getByText('if delivery == "stacked" or quick and workspace == "x"')).toBeInTheDocument();
  expect(screen.getAllByText('com os valores de hoje').map((p) => p.parentElement?.textContent)).toEqual(['com os valores de hojehive-site · entra', 'com os valores de hojeagent-hive · senão']);
  expect(screen.getByText('edite esta condição no modo texto')).toBeInTheDocument();
  expect([screen.queryByRole('button', { name: 'ok' }), screen.queryByRole('combobox')]).toEqual([null, null]);
  expect(screen.getByText('texto mantido')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'remover condição' }));
  expect([onRemove.mock.calls.length, onClose.mock.calls.length, onOk.mock.calls.length]).toEqual([1, 1, 0]);
});

test('ok on an unchanged form closes it without writing (#322, decision 17)', () => {
  const { onOk, onClose } = popoverOn('delivery == "stacked"');
  fireEvent.click(screen.getByRole('button', { name: 'ok' }));
  expect([onOk.mock.calls.length, onClose.mock.calls.length]).toEqual([0, 1]);
});

test('the footer is ok, remove condition, then "texto mantido"; the else line jumps the editor there and closes; "+ e / ou" is here (#492)', () => {
  const { onReveal, onClose } = popoverOn('delivery == "stacked"');
  expect(screen.getAllByRole('button').slice(-2).map((b) => b.textContent)).toEqual(['ok', 'remover condição']);
  expect(screen.getByRole('button', { name: 'remover condição' }).nextElementSibling).toHaveTextContent('texto mantido');
  expect(screen.getByRole('button', { name: '+ e / ou' })).toBeInTheDocument();
  expect(screen.getByText('com os valores de hoje', { selector: '[role="group"][aria-label="else"] *' }).parentElement).toHaveTextContent('agent-hive · senão');
  fireEvent.click(screen.getByRole('button', { name: 'else · linha 8' }));
  expect([onReveal.mock.calls, onClose.mock.calls.length]).toEqual([[[8]], 1]);
});

test("the operator list is headed by the variable and its kind, each operator with its Liquid symbol (#492)", async () => {
  const user = userEvent.setup();
  popoverOn('delivery == "stacked"');
  await user.click(screen.getByRole('combobox', { name: 'operador' }));
  const list = await screen.findByRole('listbox');
  const [first] = within(list).getAllByRole('option');
  expect(within(list).getByText('delivery · lista').compareDocumentPosition(first!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(within(list).getAllByRole('option').map((o) => o.querySelector('code')?.textContent)).toEqual(['==', '!=', 'or']);
});
