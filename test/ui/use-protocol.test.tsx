import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { newDraft, newKey, useProtocol } from '@/hooks/use-protocol';
import { json } from './plugins-fixtures';
import { PROTOCOL_READ, passageOf, stubProtocol, withPassages } from './protocol-fixtures';

afterEach(() => vi.unstubAllGlobals());

const shown = () => renderHook(({ isShown }) => useProtocol(isShown), { initialProps: { isShown: true } });

test('reads GET /api/protocol only once shown; a failed read is its message and no read (#337)', async () => {
  const { mock } = stubProtocol({ read: () => json({ error: 'boom' }, 500) });
  const { result, rerender } = renderHook(({ isShown }) => useProtocol(isShown), { initialProps: { isShown: false } });
  expect(mock).not.toHaveBeenCalled();
  rerender({ isShown: true });
  await waitFor(() => expect(result.current.loadError).toBe('plugins.protocol.readFailed'));
  expect(result.current.read).toBeUndefined();
});

test('insert opens a draft with its header and selects it; save POSTs it, reloads, drops the draft and selects the saved id; cancel drops a draft (#337)', async () => {
  let read = PROTOCOL_READ;
  const { calls } = stubProtocol({
    read: () => read,
    write: () => {
      read = withPassages(passageOf('p1', 'ask', 'mine'));
      return json({ id: 'p1' }, 201);
    },
  });
  const { result } = shown();
  await waitFor(() => expect(result.current.read).toEqual(PROTOCOL_READ));
  act(() => result.current.insert('ask'));
  expect([result.current.drafts[newKey('ask')], result.current.selected]).toEqual([newDraft('ask'), 'new:ask']);
  act(() => result.current.edit(newKey('ask'), `${newDraft('ask')}mine`));
  await act(() => result.current.save(newKey('ask')));
  expect(calls).toEqual([{ method: 'POST', path: '/api/protocol/passages', body: { text: '---\nafter: ask\n---\nmine' } }]);
  expect(result.current.read?.passages.map((p) => p.id)).toEqual(['p1']);
  expect([result.current.drafts, result.current.selected]).toEqual([{}, 'p1']);
  act(() => result.current.insert('done'));
  act(() => result.current.cancel(newKey('done')));
  expect([result.current.drafts, result.current.selected]).toEqual([{}, undefined]);
});

test("an edited saved passage PUTs; a 400's errors land in saveErrors, a 500 is a message key, and the draft stays (#337)", async () => {
  const saved = passageOf('p1', 'ask', 'mine');
  const errors = [{ line: 4, message: 'tag "if" not closed' }];
  let status = 400;
  const { calls } = stubProtocol({
    read: () => withPassages(saved),
    write: () => (status === 400 ? json({ errors }, 400) : json({ error: 'the passages cannot be read or written' }, 500)),
  });
  const { result } = shown();
  await waitFor(() => expect(result.current.read).toBeDefined());
  act(() => result.current.edit('p1', `${saved.text} more`));
  await act(() => result.current.save('p1'));
  expect(result.current.saveErrors).toEqual({ p1: errors });
  status = 500;
  await act(() => result.current.save('p1'));
  expect(result.current.saveErrors).toEqual({ p1: 'plugins.protocol.failed' });
  expect(calls.map((c) => [c.method, c.path])).toEqual([['PUT', '/api/protocol/passages/p1'], ['PUT', '/api/protocol/passages/p1']]);
  expect(result.current.drafts.p1).toBe(`${saved.text} more`);
});

test('setViewAs reads the render for the workspace; a 404 from it goes back to the template (#337)', async () => {
  stubProtocol({
    render: (workspace: string) => (workspace === 'gone' ? json({ error: 'unknown workspace' }, 404) : json({ stage: `stage of ${workspace}\n`, session: '' })),
  });
  const { result } = shown();
  act(() => result.current.setViewAs('hive-site'));
  await waitFor(() => expect(result.current.rendered).toBe('stage of hive-site\n'));
  act(() => result.current.setViewAs('gone'));
  await waitFor(() => expect(result.current.viewAs).toBeUndefined());
  expect([result.current.rendered, result.current.renderError]).toEqual([undefined, undefined]);
});
