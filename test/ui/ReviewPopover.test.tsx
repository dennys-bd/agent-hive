import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { canSendReview } from '@/components/ReviewPopover';
import { setLanguage } from '@/i18n';
import { ANCHOR, fakePrHive, type FakePrHive, HEAD, prCalls, prData, renderPage, ROUTE } from './pr-harness';

let hive: FakePrHive;
beforeEach(() => { setLanguage('pt'); localStorage.clear(); hive = fakePrHive(); });
afterEach(() => vi.unstubAllGlobals());
const gets = (url: string): number => hive.calls.filter((c) => c.method === 'GET' && c.url === url).length;

test('review shows the pending drafts and opens the popover; send review posts the event, the summary and the head, then reads the PR again (#758)', async () => {
  const user = userEvent.setup();
  hive.review = { reviewed: [], drafts: [{ id: 'D1', anchor: ANCHOR, text: 'later' }, { id: 'D2', anchor: ANCHOR, text: 'and this' }] };
  renderPage();
  const review = await screen.findByRole('button', { name: /^revisar/ });
  await waitFor(() => expect(review).toHaveTextContent('2 pendentes'));
  await user.click(review);
  expect(screen.getByText('2 comentários pendentes vão junto')).toBeInTheDocument();
  await user.type(screen.getByRole('textbox', { name: 'resumo da review…' }), 'looks good');
  await user.click(screen.getByRole('radio', { name: /^aprovar/ }));
  expect(screen.getByRole('radio', { name: /^aprovar/ }).closest('label')).toHaveClass('bg-muted');
  await user.click(screen.getByRole('button', { name: 'enviar review' }));
  await waitFor(() => expect(prCalls(hive, 'POST', `${ROUTE}/review`)[0]?.body).toEqual({ head: HEAD, event: 'approve', body: 'looks good' }));
  await waitFor(() => expect(gets(ROUTE)).toBe(2));
  expect(screen.queryByRole('textbox', { name: 'resumo da review…' })).toBeNull();
});

test('on one\'s own PR approve and request changes are off, with GitHub\'s reason as their tooltip (#758)', async () => {
  const user = userEvent.setup();
  hive.pr = prData({ author: 'ana' }); // the viewer
  renderPage();
  await user.click(await screen.findByRole('button', { name: /^revisar/ }));
  for (const name of [/^aprovar/, /^pedir mudanças/]) {
    const radio = screen.getByRole('radio', { name });
    expect(radio).toBeDisabled();
    expect(radio.closest('label')).toHaveAttribute('title', 'o GitHub não deixa aprovar o próprio PR');
  }
  expect(screen.getByRole('radio', { name: /^comentar/ })).toBeEnabled();
});

test('a comment waits for a summary or a draft; an approval or a change request goes without; GitHub\'s refusal stays in the popover (#758)', async () => {
  const user = userEvent.setup();
  expect([canSendReview('comment', ' ', 0), canSendReview('comment', '', 1), canSendReview('approve', '', 0)]).toEqual([false, true, true]);
  hive.answers[`POST ${ROUTE}/review`] = { status: 502, body: { error: 'gh api graphql: Resource not accessible by integration' } };
  renderPage();
  await user.click(await screen.findByRole('button', { name: /^revisar/ }));
  const send = screen.getByRole('button', { name: 'enviar review' });
  expect(send).toBeDisabled();
  await user.type(screen.getByRole('textbox', { name: 'resumo da review…' }), 'x');
  expect(send).toBeEnabled();
  await user.clear(screen.getByRole('textbox', { name: 'resumo da review…' }));
  expect(send).toBeDisabled();
  await user.click(screen.getByRole('radio', { name: /^pedir mudanças/ }));
  expect(send).toBeEnabled();
  await user.click(send);
  expect(await screen.findByRole('alert')).toHaveTextContent('Resource not accessible by integration');
  expect(prCalls(hive, 'POST', `${ROUTE}/review`)[0].body).toEqual({ head: HEAD, event: 'request_changes', body: '' });
});
