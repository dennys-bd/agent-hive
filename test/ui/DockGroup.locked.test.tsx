import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test } from 'vitest';
import { type DockPanel, DockGroup } from '@/components/DockGroup';
import { setLanguage } from '@/i18n';

// Its own file (#458): Radix's ContextMenu opens once per file under jsdom (see DockGroup.test.tsx), and this test spends it on the Detalhes
// tab, proving a menu does open here while the locked tabs open none.
const panel = (id: DockPanel['id'], title: string): DockPanel => ({ id, title, body: <p>{`corpo ${title}`}</p> });

beforeEach(() => setLanguage('pt'));

test('Automação and Atividades have no menu to move them; a tab beside them still does (#458)', async () => {
  render(
    <DockGroup
      side="left" size={30} panels={[panel('automation', 'Automação'), panel('activities', 'Atividades'), panel('detail', 'Detalhes')]}
      active="automation" open measure={{ current: null }} onActivate={() => {}} onMove={() => {}} onResize={() => {}} onClose={() => {}}
    />,
  );
  fireEvent.contextMenu(screen.getByRole('tab', { name: 'Automação' }));
  fireEvent.contextMenu(screen.getByRole('tab', { name: 'Atividades' }));
  expect(screen.queryAllByRole('menuitem')).toEqual([]);
  fireEvent.contextMenu(screen.getByRole('tab', { name: 'Detalhes' }));
  expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent)).toEqual(['Mover para a direita']);
});
