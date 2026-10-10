import { render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { SettingsFooter } from '@/components/settings/SettingsFooter';
import { setLanguage, t } from '@/i18n';

beforeEach(() => setLanguage('pt'));

const props = { changed: ['language'] as const, saving: false, savableUnchanged: false, onRevert: vi.fn(), onSave: vi.fn() };

test('a save error shows as an alert in the footer, in place of the unsaved summary (#739)', () => {
  render(<SettingsFooter {...props} saveError={'first line\nsecond line'} />);
  const alert = screen.getByRole('alert');
  expect(alert).toHaveTextContent('first line second line');
  expect(alert.className).toContain('whitespace-pre-wrap');
  expect(alert.className).toContain('text-destructive');
  expect(alert.closest('footer')).not.toBeNull();
  expect(screen.queryByText(/não salvo|alteraç/i)).toBeNull();
});

test('without a save error the unsaved summary shows and there is no alert', () => {
  render(<SettingsFooter {...props} />);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByText(t('settings.unsaved.one', { n: 1, sections: t('settings.section.app') }))).toBeInTheDocument();
});
