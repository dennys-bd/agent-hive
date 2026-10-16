import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { parseTemplate } from '../../src/template';
import { buildMap } from '../../src/template-map';
import { BlockMap, type BlockMapProps } from '@/components/plugins/BlockMap';
import { setLanguage } from '@/i18n';
import { BUILD_TEXT } from './plugins-fixtures';

const map = buildMap(parseTemplate(BUILD_TEXT), { skills: ['hive:new-pr'], agents: [] });
function renderMap(extra: Partial<BlockMapProps> = {}): BlockMapProps {
  const props: BlockMapProps = { map, collapsed: [], dimmed: new Set(), canDrag: true, onReveal: vi.fn(), onToggle: vi.fn(), onMove: vi.fn(), ...extra };
  render(<BlockMap {...props} />);
  return props;
}
const nav = (): HTMLElement => screen.getByRole('navigation', { name: 'mapa' });
const rowOf = (name: string): HTMLElement => within(nav()).getByRole('button', { name }).closest('li')!;
const handleOf = (name: string): HTMLElement => within(rowOf(name)).getAllByTitle('arrastar')[0]!;
const dataTransfer = () => {
  const data = new Map<string, string>();
  return { setData: (type: string, value: string) => data.set(type, value), getData: (type: string) => data.get(type) ?? '', effectAllowed: 'move', dropEffect: 'move' };
};

beforeEach(() => setLanguage('pt'));

test("each block shows its title, start line and chips: the introduction, the ## with its subsection count, the chain's branches dashed and indented (#319, decision 18)", () => {
  renderMap();
  expect(within(nav()).getAllByRole('button').map((b) => b.textContent)).toEqual(['introdução', 'Input', '1 subseções', 'if delivery == "stacked"', 'else', 'Stops']);
  expect(rowOf('introdução')).toHaveTextContent('hive:new-pr');
  expect(rowOf('Stops')).toHaveTextContent('Stops20');
  expect(within(nav()).getByRole('button', { name: 'else' }).closest('.border-dashed')).not.toBeNull();
  expect(within(rowOf('introdução')).queryAllByTitle('arrastar')).toEqual([]); // the introduction never moves
});

test('a click reveals the block; the subsections toggle collapses, a collapsed ## hides its children; dimmed rows fade and no handle shows without canDrag (#319, decisions 18, 19, 23)', () => {
  const props = renderMap({ collapsed: [11], dimmed: new Set([20]), canDrag: false });
  fireEvent.click(within(nav()).getByRole('button', { name: 'Stops' }));
  expect(props.onReveal).toHaveBeenCalledWith(20);
  fireEvent.click(within(nav()).getByRole('button', { name: '1 subseções' }));
  expect(props.onToggle).toHaveBeenCalledWith(11);
  expect(within(nav()).queryByRole('button', { name: 'else' })).not.toBeInTheDocument();
  expect(within(nav()).getByRole('button', { name: 'Stops' }).closest('.opacity-35')).not.toBeNull();
  expect(within(nav()).queryAllByTitle('arrastar')).toEqual([]);
});

test('a block dropped on a sibling moves to its index; a drop on a block of another parent moves nothing (#319, decisions 20, 21)', () => {
  const props = renderMap();
  const dt = dataTransfer();
  fireEvent.dragStart(handleOf('Input'), { dataTransfer: dt });
  fireEvent.dragOver(rowOf('Stops'), { dataTransfer: dt });
  fireEvent.drop(rowOf('Stops'), { dataTransfer: dt });
  expect(props.onMove).toHaveBeenCalledWith(11, 1);
  fireEvent.dragStart(handleOf('if delivery == "stacked"'), { dataTransfer: dt }); // the chain lives under Input
  fireEvent.drop(rowOf('Stops'), { dataTransfer: dt });
  expect(props.onMove).toHaveBeenCalledTimes(1);
});
