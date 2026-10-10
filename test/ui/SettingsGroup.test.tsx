import { render, screen } from '@testing-library/react';
import { beforeEach, expect, test } from 'vitest';
import { SettingsGroup } from '@/components/settings/SettingsGroup';
import { setLanguage } from '@/i18n';

beforeEach(() => setLanguage('pt'));

// jsdom has no layout: the class is what keeps a wide child (the stages chart) from widening the card's only column past its border (#887)
test('a card is a one-column grid whose column may shrink below its content, so a wide child stays inside the card (#887)', () => {
  render(<SettingsGroup title="settings.stages"><div style={{ width: 2000 }} /></SettingsGroup>);
  expect(screen.getByRole('region', { name: 'etapas' })).toHaveClass('grid', 'grid-rows-subgrid', 'grid-cols-[minmax(0,1fr)]');
});
