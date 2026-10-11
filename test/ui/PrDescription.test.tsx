import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PrDescription } from '@/components/PrDescription';
import { setLanguage } from '@/i18n';
import { relativeTime } from '@/lib/home';
import type { PrData } from '../../src/types';
import { AT, fakePrHive, type FakePrHive, prCalls, prData, ROUTE } from './pr-harness';

let hive: FakePrHive;
beforeEach(() => { setLanguage('pt'); hive = fakePrHive(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const SESSION = 'f9f0456a-1b2c-4d5e-8f90-123456789abc';
// jsdom lays nothing out: the rendered body's height, as the browser measures it
const bodyHeight = (px: number) => vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(px);
const region = (): HTMLElement => screen.getByRole('region', { name: 'descrição' });
const panel = () => within(region());
const show = (pr: PrData = prData(), sessionId?: string, onChanged = vi.fn(async () => {})) =>
  render(<PrDescription pr={pr} sessionId={sessionId} onChanged={onChanged} />);
const CLIP = '.max-h-\\[148px\\]';
const FADE = '.bg-linear-to-t';

test('a body taller than 148px is clipped with a fade, its footer saying show all and the hidden lines; show all opens it whole, collapse clips it again (#62)', async () => {
  const user = userEvent.setup();
  bodyHeight(300); // ceil((300 − 148) / 21) = 8 lines hidden
  const { container } = show();
  const toggle = panel().getByRole('button', { name: /mostrar tudo/ });
  expect(toggle).toHaveTextContent('+8 linhas');
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(container.querySelector(CLIP)).not.toBeNull();
  expect(container.querySelector(FADE)).not.toBeNull();
  await user.click(toggle);
  expect(panel().getByRole('button', { name: 'recolher' })).toHaveAttribute('aria-expanded', 'true');
  expect(container.querySelector(CLIP)).toBeNull();
  expect(container.querySelector(FADE)).toBeNull();
  await user.click(panel().getByRole('button', { name: 'recolher' }));
  expect(panel().getByRole('button', { name: /mostrar tudo/ })).toHaveAttribute('aria-expanded', 'false');
  expect(container.querySelector(CLIP)).not.toBeNull();
});

test('a body of 148px or less shows whole: no clip, no fade, no footer (#62)', () => {
  bodyHeight(148);
  const { container } = show();
  expect(panel().getByText('The description')).toBeInTheDocument();
  expect(panel().queryByRole('button', { name: /mostrar tudo|recolher/ })).toBeNull();
  expect(container.querySelector(CLIP)).toBeNull();
  expect(container.querySelector(FADE)).toBeNull();
});

test('the hidden lines are counted again when the body\'s size changes: a refresh\'s new body, a narrower window (#62)', () => {
  const observers: ResizeObserverCallback[] = [];
  vi.stubGlobal('ResizeObserver', class { constructor(callback: ResizeObserverCallback) { observers.push(callback); } observe(): void {} disconnect(): void {} });
  const height = bodyHeight(300);
  show();
  expect(panel().getByRole('button', { name: /mostrar tudo/ })).toHaveTextContent('+8 linhas');
  height.mockReturnValue(169); // one line past the clip
  act(() => observers.at(-1)?.([], {} as ResizeObserver));
  expect(panel().getByRole('button', { name: /mostrar tudo/ })).toHaveTextContent(/\+1 linha$/);
});

test('the header shows the author with the avatar and the opened line: via session and its id\'s first 8 characters in mono when the Hive recorded it, the time alone when not (#62)', () => {
  const { unmount } = show(prData(), SESSION);
  expect(panel().getByText('bia')).toHaveClass('font-medium');
  expect(panel().getByTitle('bia')).toHaveTextContent('BI'); // the timeline's avatar
  expect(panel().getByText('f9f0456a')).toHaveClass('font-mono');
  expect(region()).toHaveTextContent(`abriu · via sessão f9f0456a · ${relativeTime(AT)}`);
  unmount();
  show();
  expect(region()).toHaveTextContent(`abriu · ${relativeTime(AT)}`);
  expect(region()).not.toHaveTextContent('via sessão');
});

test('edit sits in the header and swaps the body for the form; cancel brings the body back, and saving sends the body with the updatedAt read (#62)', async () => {
  const user = userEvent.setup();
  const onChanged = vi.fn(async () => {});
  show(prData(), undefined, onChanged);
  const edit = panel().getByRole('button', { name: 'editar' });
  expect(panel().getByText('bia').parentElement).toContainElement(edit);
  await user.click(edit);
  expect(panel().getByRole('textbox', { name: 'descrição' })).toHaveValue('The description');
  expect(panel().queryByRole('button', { name: 'editar' })).toBeNull();
  await user.click(panel().getByRole('button', { name: 'cancelar' }));
  expect(panel().queryByRole('textbox')).toBeNull();
  expect(panel().getByText('The description')).toBeInTheDocument();
  await user.click(panel().getByRole('button', { name: 'editar' }));
  const box = panel().getByRole('textbox', { name: 'descrição' });
  await user.clear(box);
  await user.type(box, 'Better body');
  await user.click(panel().getByRole('button', { name: 'salvar' }));
  await waitFor(() => expect(prCalls(hive, 'POST', ROUTE)[0]?.body).toEqual({ body: 'Better body', updatedAt: AT }));
  await waitFor(() => expect(panel().queryByRole('textbox')).toBeNull());
  expect(onChanged).toHaveBeenCalledOnce();
});

test('an empty body keeps the header and says no description (#62)', () => {
  show(prData({ body: '' }));
  expect(panel().getByText('bia')).toBeInTheDocument();
  expect(panel().getByText('sem descrição')).toHaveClass('text-muted-foreground');
  expect(panel().queryByRole('button', { name: /mostrar tudo/ })).toBeNull();
});

test('an open edit closes when the PR stops being editable: a merge or a lost permission read by a poll (#62)', async () => {
  const user = userEvent.setup();
  const onChanged = vi.fn(async () => {});
  const { rerender } = show(prData(), undefined, onChanged);
  await user.click(panel().getByRole('button', { name: 'editar' }));
  expect(panel().getByRole('textbox', { name: 'descrição' })).toBeInTheDocument();
  rerender(<PrDescription pr={prData({ state: 'merged' })} onChanged={onChanged} />);
  expect(panel().queryByRole('textbox')).toBeNull();
  expect(panel().getByText('The description')).toBeInTheDocument();
});
