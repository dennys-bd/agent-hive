import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { Header } from '@/components/Header';
import { setLanguage, t } from '@/i18n';

const noop = () => {};

beforeEach(() => setLanguage('en'));

test('the brand and the view switcher: atividades first, then fluxo; the center\'s view is pressed, each item shows its shortcut, a click switches (#533, #746)', async () => {
  const onView = vi.fn();
  render(<Header signal="green" center="activities" onView={onView} />);
  expect(screen.getByText(t('header.brand'))).toBeInTheDocument();
  // jsdom runs as off macOS: ⌘1 and ⌘2 there
  expect(screen.getAllByRole('radio').map((item) => item.textContent)).toEqual([`${t('header.activities')}Ctrl+1`, `${t('header.flow')}Ctrl+2`]);
  const flow = screen.getByRole('radio', { name: new RegExp(t('header.flow')) });
  const activities = screen.getByRole('radio', { name: new RegExp(t('header.activities')) });
  expect(activities).toHaveAttribute('aria-checked', 'true');
  expect(flow).toHaveAttribute('aria-checked', 'false');

  await userEvent.setup().click(flow);

  expect(onView).toHaveBeenCalledWith('automation');
});

test('the header shows no usage: no meter, no agent mark, no refresh and no Settings button; it is no @container (#223, #499)', () => {
  const { container } = render(<Header signal="green" center="automation" onView={noop} />);
  expect(container.querySelectorAll('[data-slot="progress"]')).toHaveLength(0);
  expect(container.querySelector('[data-icon]')).toBeNull();
  expect(screen.queryAllByRole('button')).toEqual([]); // the views are radios; Settings opens from the app menu, its shortcut or the tray
  expect(container.querySelector('header')).not.toHaveClass('@container');
});

test('the hexagon takes the signal\'s colour (#533)', () => {
  const { container, rerender } = render(<Header signal="green" center="automation" onView={noop} />);
  const mark = (): Element => container.querySelector('[data-signal]')!;
  expect(mark().getAttribute('class')).toMatch(/text-signal-green/);
  rerender(<Header signal="red" center="automation" onView={noop} />);
  expect(mark().getAttribute('class')).toMatch(/text-signal-red/);
});
