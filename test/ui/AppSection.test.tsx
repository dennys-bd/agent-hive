import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { AppSection } from '@/components/settings/AppSection';
import { setLanguage, t } from '@/i18n';
import { draftFrom } from '@/lib/settings-form';

beforeEach(() => setLanguage('pt'));

test('the trusted domains card lists chips; × removes one, Enter adds a host, a bad one stays with the error (#513)', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<AppSection draft={{ ...draftFrom(undefined), trustedDomains: ['github.com'] }} onChange={onChange} />);

  expect(screen.getByRole('heading', { level: 2, name: t('settings.trustedDomains') })).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: t('settings.trustedDomains.remove', { host: 'github.com' }) }));
  expect(onChange).toHaveBeenLastCalledWith({ trustedDomains: [] });

  const input = screen.getByRole('textbox', { name: t('settings.trustedDomains.add') });
  await user.type(input, 'Docs.Example.com{Enter}');
  expect(onChange).toHaveBeenLastCalledWith({ trustedDomains: ['github.com', 'docs.example.com'] });
  expect(input).toHaveValue('');

  await user.type(input, 'https://x.com{Enter}');
  expect(onChange).toHaveBeenLastCalledWith({ trustedDomains: ['github.com', 'docs.example.com'] });
  expect(input).toHaveValue('https://x.com');
  expect(input).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByText(t('settings.error.trustedDomain', { host: 'https://x.com' }))).toBeInTheDocument();
});

test('the terminal card: font and lines side by side', () => {
  render(<AppSection draft={draftFrom(undefined)} onChange={vi.fn()} />);
  expect(screen.getByRole('heading', { level: 2, name: 'terminal' })).toBeInTheDocument();
  for (const [key, pt] of [['settings.terminalFont', 'fonte'], ['settings.consoleLines', 'linhas por canal']] as const) expect(screen.getByLabelText(pt)).toBe(screen.getByLabelText(t(key)));
  expect(screen.getByText(t('settings.consoleLines.hint'))).toHaveTextContent('no console · 100 a 100.000; as mais antigas saem primeiro');
});

test('a card header drops its hint under the title when the card is narrow, and puts it beside from @2xl; the title never wraps', () => {
  render(<AppSection draft={draftFrom(undefined)} onChange={vi.fn()} />);
  const title = screen.getByRole('heading', { level: 2, name: t('settings.trustedDomains') });
  expect(title).toHaveClass('whitespace-nowrap');
  // the header is the query container, never the section: containment there would undo the section's subgrid (#614)
  expect(title.parentElement?.parentElement).toHaveClass('@container');
  expect(title.closest('section')).not.toHaveClass('@container');
  expect(title.parentElement).toHaveClass('flex-col', '@2xl:flex-row', '@2xl:items-baseline');
  expect(title.parentElement).toContainElement(screen.getByText(t('settings.trustedDomains.hint')));
});

test('side-by-side cards share their grid rows: each card is a two-row subgrid (header, body) with no gap between them', () => {
  render(<AppSection draft={draftFrom(undefined)} onChange={vi.fn()} />);
  for (const key of ['settings.group.appearance', 'settings.group.window', 'settings.group.terminal', 'settings.trustedDomains', 'settings.sidebarsPerView'] as const) {
    const card = screen.getByRole('heading', { level: 2, name: t(key) }).closest('section');
    expect(card).toHaveClass('grid', 'grid-rows-subgrid', 'row-span-2', 'gap-y-0');
    expect(card?.parentElement).toHaveClass('grid', 'grid-cols-2', 'gap-4');
  }
});

test('the window card: the close select, then the notifications group, a switch per kind, all on in a new form, each toggling its own; no other switch is there (#199, #614)', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  const draft = draftFrom(undefined);
  const { rerender } = render(<AppSection draft={draft} onChange={onChange} />);
  const card = screen.getByRole('region', { name: t('settings.group.window') });
  expect(within(card).getByRole('combobox', { name: t('settings.onClose') })).toBeInTheDocument();
  const group = within(card).getByRole('group', { name: t('settings.notifications') });
  expect(within(group).getByText(t('settings.notifications.hint'))).toBeInTheDocument();
  expect(within(card).getAllByRole('switch')).toEqual(within(group).getAllByRole('switch')); // #614: the close-tab switches live in execution
  expect(within(group).getAllByRole('switch').map((s) => s.getAttribute('aria-checked'))).toEqual(['true', 'true', 'true', 'true']);
  await user.click(within(group).getByRole('switch', { name: t('settings.notifications.pr') }));
  expect(onChange).toHaveBeenLastCalledWith({ notifications: { waiting: true, approval: true, pr: false, failed: true } });
  rerender(<AppSection draft={{ ...draft, notifications: { waiting: false, approval: true, pr: true, failed: true } }} onChange={onChange} />);
  expect(within(group).getByRole('switch', { name: t('settings.notifications.waiting') })).toHaveAttribute('aria-checked', 'false');
  await user.click(within(group).getByRole('switch', { name: t('settings.notifications.failed') }));
  expect(onChange).toHaveBeenLastCalledWith({ notifications: { waiting: false, approval: true, pr: true, failed: false } });
});

test('the appearance card sets the files tree icons: the set, where they show and muted; with none the other two are disabled (#754)', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  const draft = draftFrom(undefined);
  const { rerender } = render(<AppSection draft={draft} onChange={onChange} />);
  const card = screen.getByRole('region', { name: t('settings.group.appearance') });

  within(card).getByRole('combobox', { name: t('settings.fileIcons') }).focus();
  await user.keyboard('{Enter}');
  await user.click(await screen.findByRole('option', { name: 'vscode-icons' }));
  expect(onChange).toHaveBeenLastCalledWith({ fileIcons: { set: 'vscode', scope: 'all', muted: true } });

  within(card).getByRole('combobox', { name: t('settings.fileIcons.scope') }).focus();
  await user.keyboard('{Enter}');
  await user.click(await screen.findByRole('option', { name: t('settings.fileIcons.scope.folders') }));
  expect(onChange).toHaveBeenLastCalledWith({ fileIcons: { set: 'material', scope: 'folders', muted: true } });

  await user.click(within(card).getByRole('switch', { name: t('settings.fileIcons.muted') })); // on by default: the click turns it off
  expect(onChange).toHaveBeenLastCalledWith({ fileIcons: { set: 'material', scope: 'all', muted: false } });
  expect(within(card).getByText(t('settings.fileIcons.muted.hint'))).toBeInTheDocument();

  rerender(<AppSection draft={{ ...draft, fileIcons: { set: 'none', scope: 'all', muted: false } }} onChange={onChange} />);
  expect(within(card).getByRole('combobox', { name: t('settings.fileIcons') })).toBeEnabled();
  expect(within(card).getByRole('combobox', { name: t('settings.fileIcons.scope') })).toBeDisabled();
  expect(within(card).getByRole('switch', { name: t('settings.fileIcons.muted') })).toBeDisabled();
});

test('the sidebars per view card: left and right off with the right tab on in a new form; the tab is disabled while right is off and keeps its value (#821)', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  const draft = draftFrom(undefined);
  const { rerender } = render(<AppSection draft={draft} onChange={onChange} />);
  const card = screen.getByRole('region', { name: t('settings.sidebarsPerView') });
  expect(within(card).getByText(t('settings.sidebarsPerView.hint'))).toBeInTheDocument(); // in the card's header (#513)
  expect(within(card).getAllByRole('switch').map((s) => s.getAttribute('aria-checked'))).toEqual(['false', 'false', 'true']);
  expect(within(card).getByRole('switch', { name: t('settings.sidebarsPerView.rightTab') })).toBeDisabled();
  await user.click(within(card).getByRole('switch', { name: t('settings.sidebarsPerView.left') }));
  expect(onChange).toHaveBeenLastCalledWith({ sidebarsPerView: { left: true, right: false, rightTab: true } });
  await user.click(within(card).getByRole('switch', { name: t('settings.sidebarsPerView.right') }));
  expect(onChange).toHaveBeenLastCalledWith({ sidebarsPerView: { left: false, right: true, rightTab: true } });
  rerender(<AppSection draft={{ ...draft, sidebarsPerView: { left: false, right: true, rightTab: true } }} onChange={onChange} />);
  expect(within(card).getByText(t('settings.sidebarsPerView.rightTab.hint'))).toBeInTheDocument();
  await user.click(within(card).getByRole('switch', { name: t('settings.sidebarsPerView.rightTab') }));
  expect(onChange).toHaveBeenLastCalledWith({ sidebarsPerView: { left: false, right: true, rightTab: false } });
  rerender(<AppSection draft={{ ...draft, sidebarsPerView: { left: false, right: false, rightTab: true } }} onChange={onChange} />);
  const tab = within(card).getByRole('switch', { name: t('settings.sidebarsPerView.rightTab') });
  expect(tab).toBeDisabled();
  expect(tab).toHaveAttribute('aria-checked', 'true');
});
