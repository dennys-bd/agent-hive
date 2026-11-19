import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test } from 'vitest';
import { DetailSection } from '@/components/DetailSection';
import { setLanguage } from '@/i18n';

const NOTE = 'what this section holds';
const show = ({ defaultOpen, note = NOTE }: { defaultOpen?: boolean; note?: string | null } = {}) =>
  render(
    <DetailSection name="árvore" note={note ?? undefined} summary={<span>3 tarefas</span>} defaultOpen={defaultOpen}>
      <p>body</p>
    </DetailSection>,
  );
const section = (): HTMLDetailsElement => screen.getByRole('group', { name: 'árvore' }) as HTMLDetailsElement;
const summaryOf = (): HTMLElement => section().querySelector('summary')!;
const icon = (): HTMLElement => screen.getByRole('button', { name: 'sobre esta seção' });

beforeEach(() => setLanguage('pt'));

test('a native details, closed by default and open with defaultOpen; the summary holds the name and the summary slot (#958)', () => {
  const view = show();
  expect(section().tagName).toBe('DETAILS');
  expect(section().open).toBe(false);
  expect(summaryOf()).toHaveTextContent('árvore');
  expect(summaryOf()).toHaveTextContent('3 tarefas');
  expect(section()).toHaveTextContent('body');
  view.unmount();
  show({ defaultOpen: true });
  expect(section().open).toBe(true);
});

test('a click on the summary toggles it, and a re-render with the same props keeps what the user chose (#958)', async () => {
  const user = userEvent.setup();
  const { rerender } = show({ defaultOpen: true });
  await user.click(summaryOf());
  expect(section().open).toBe(false);
  rerender(<DetailSection name="árvore" note={NOTE} summary={<span>3 tarefas</span>} defaultOpen><p>body</p></DetailSection>);
  expect(section().open).toBe(false);
});

test('the summary is aria-describedby the note, kept in an sr-only span; without a note there is neither icon nor description (#958)', () => {
  const view = show();
  const note = document.getElementById(summaryOf().getAttribute('aria-describedby')!);
  expect(note).toHaveTextContent(NOTE);
  expect(note).toHaveClass('sr-only');
  view.unmount();
  show({ note: null });
  expect(summaryOf()).not.toHaveAttribute('aria-describedby');
  expect(screen.queryByRole('button', { name: 'sobre esta seção' })).not.toBeInTheDocument();
});

// Radix draws the content twice (visible, and a visually hidden role="tooltip" copy): read the role, not the text.
test('hovering or focusing the info icon shows the note as a tooltip (#958)', async () => {
  const hovered = show();
  fireEvent.pointerMove(icon(), { pointerType: 'mouse' });
  expect(await screen.findByRole('tooltip')).toHaveTextContent(NOTE);
  hovered.unmount();
  show();
  fireEvent.focus(icon());
  expect(await screen.findByRole('tooltip')).toHaveTextContent(NOTE);
});

test('a click on the icon, or Enter and Space on it, leaves the section as it was (#958)', async () => {
  const user = userEvent.setup();
  show();
  await user.click(icon());
  expect(section().open).toBe(false);
  icon().focus();
  await user.keyboard('{Enter}');
  await user.keyboard(' ');
  expect(section().open).toBe(false);
  await user.click(summaryOf()); // the summary itself still toggles
  expect(section().open).toBe(true);
});
