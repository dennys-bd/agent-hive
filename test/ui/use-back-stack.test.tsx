import { act, render, renderHook } from '@testing-library/react';
import { expect, onTestFinished, test, vi } from 'vitest';
import { type BackEntry, NavScrollContext, useBackStack, useNavScroll } from '@/hooks/use-back-stack';

const entry = (label: string, scroll?: number): BackEntry => ({ label, restore: vi.fn(), scroll });

test('back restores the top entry and pops it, leaving its scroll pending for the next screen; a push drops a pending scroll (#911)', () => {
  const { result } = renderHook(() => useBackStack());
  const [project, issue] = [entry('GitHub Project', 240), entry('issue #12', 30)];
  expect(result.current.top).toBeUndefined();
  act(() => result.current.push(project));
  act(() => result.current.push(issue));
  expect(result.current.top).toBe(issue);
  act(() => result.current.back());
  expect(issue.restore).toHaveBeenCalledOnce();
  expect(project.restore).not.toHaveBeenCalled();
  expect(result.current.top).toBe(project);
  expect(result.current.pending.current).toBe(30);
  act(() => result.current.push(entry('PR #7')));
  expect(result.current.pending.current).toBeUndefined(); // it belonged to the screen just left
  act(() => result.current.back()); // PR #7
  act(() => result.current.back()); // GitHub Project
  expect(project.restore).toHaveBeenCalledOnce();
  expect(result.current.top).toBeUndefined();
  act(() => result.current.back()); // an empty stack: nothing to restore
  expect(project.restore).toHaveBeenCalledOnce();
});

test('reset empties the stack, and with an entry leaves only that one (#911)', () => {
  const { result } = renderHook(() => useBackStack());
  act(() => result.current.push(entry('fluxo · todas')));
  act(() => result.current.push(entry('issue #12')));
  act(() => result.current.reset());
  expect(result.current.top).toBeUndefined();
  const activity = entry('atividade #12');
  act(() => result.current.push(entry('PRs · site')));
  act(() => result.current.reset(activity));
  expect(result.current.top).toBe(activity);
  act(() => result.current.back());
  expect(activity.restore).toHaveBeenCalledOnce();
  expect(result.current.top).toBeUndefined();
});

function List() {
  const scroller = useNavScroll();
  return <div ref={scroller}><p>row</p></div>;
}
const list = (pending: { current: number | undefined }): HTMLElement => {
  const { container } = render(<NavScrollContext.Provider value={pending}><List /></NavScrollContext.Provider>);
  return container.querySelector<HTMLElement>('[data-nav-scroll]')!;
};

test('useNavScroll marks its container and applies a pending scroll once the content allows it: at once for a cached list, when a page\'s body arrives, then never again (#911)', () => {
  const observers: ResizeObserverCallback[] = [];
  vi.stubGlobal('ResizeObserver', class { constructor(callback: ResizeObserverCallback) { observers.push(callback); } observe(): void {} disconnect(): void {} });
  onTestFinished(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  // jsdom lays nothing out: the content's height and the container's, as the browser measures them
  const content = vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(1000);
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(400);
  const pending: { current: number | undefined } = { current: 240 };
  expect(list(pending).scrollTop).toBe(240);
  expect(pending.current).toBeUndefined();
  expect(observers).toEqual([]); // applied on attach: nothing to watch
  content.mockReturnValue(300); // a page whose body is still short: 300 − 400 leaves nothing to scroll
  pending.current = 240;
  const page = list(pending);
  expect(page.scrollTop).toBe(0);
  content.mockReturnValue(1000); // the body arrived
  act(() => observers.at(-1)?.([], {} as ResizeObserver));
  expect(page.scrollTop).toBe(240);
  expect(pending.current).toBeUndefined();
  page.scrollTop = 0;
  act(() => observers.at(-1)?.([], {} as ResizeObserver));
  expect(page.scrollTop).toBe(0); // at most once
});
