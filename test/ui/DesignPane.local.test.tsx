import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DesignPane, designFrameRoute } from '@/components/DesignPane';
import { showCommentsPanel } from '@/hooks/use-design-pins';
import { setLanguage } from '@/i18n';
import { activityKey, type LocalActivity } from '@/lib/activities';
import { rememberFocus } from '@/lib/session-focus';
import type { Session } from '../../src/types';
import { localPairOf } from '../fixtures/work';
import { FRAME_NAME, FRAME_URL, fromBridge, PATH, RECT, REVIEW } from './design-review';
import { callsTo, fakeHive, type FakeHive } from './diff-harness';

// Workspace hive's local activity (#345): its record keeps one local session, no run holds it
const LOCAL_SESSION: Session = { id: 'cccccccc-0000-4000-8000-000000000000', startedAt: 'T', stages: [], agent: 'claude', lastUsedAt: 'T' };
const LOCAL: LocalActivity = { kind: 'local', ...localPairOf('hive', [LOCAL_SESSION]), workspace: 'hive', runs: [], sessions: [], kept: [{ session: LOCAL_SESSION, status: 'empty' }] };
const LABEL = 'hive · Design Landing.hv.html';
const ELEMENT = { kind: 'element', selector: 'main > h1:nth-of-type(1)', text: 'Welcome', rect: RECT };
const SEND_KEYS = { key: 'Enter', code: 'Enter', ctrlKey: true, shiftKey: true }; // ⌘⇧↵ off macOS (jsdom's platform)

let hive: FakeHive;
beforeEach(() => {
  showCommentsPanel(true);
  setLanguage('pt');
  document.documentElement.dataset.theme = 'dark';
  hive = fakeHive();
  hive.answers['GET /workspaces/hive/review'] = REVIEW;
  hive.answers[`GET ${designFrameRoute(LOCAL.activity.id, PATH)}`] = { url: FRAME_URL };
});
afterEach(() => {
  delete document.documentElement.dataset.theme;
  vi.unstubAllGlobals();
});

async function pane(): Promise<void> {
  render(<DesignPane activity={LOCAL} path={PATH} label={LABEL} active />);
  await screen.findByTitle(FRAME_NAME);
  await screen.findByText('a draft');
}
const posted = (url: string): unknown[] => callsTo(hive, 'POST', `/workspaces/hive/review${url}`).map((c) => c.body);

test('a local activity\'s pane shows the comments button, its count and the panel, reading the workspace\'s review and no task\'s (#345)', async () => {
  await pane();
  expect(screen.getByRole('button', { name: 'comentários' })).toHaveTextContent('4');
  expect(screen.getByRole('complementary', { name: 'comentários' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'comentar' })).toBeInTheDocument();
  expect(hive.calls.some((c) => c.url.startsWith('/tasks/'))).toBe(false);
});

test('a comment added on a local pane is a draft of the workspace\'s review, for a new session while none is in focus (#345)', async () => {
  const user = userEvent.setup();
  await pane();
  await user.click(screen.getByRole('button', { name: 'comentar' }));
  fromBridge({ type: 'anchor', anchor: ELEMENT });
  await user.type(screen.getByRole('textbox', { name: 'comentar' }), 'bigger{Enter}');
  await waitFor(() => expect(posted('/drafts')).toEqual([{ anchor: { ...ELEMENT, path: PATH, viewport: 'natural', theme: 'dark', tweaks: {} }, text: 'bigger', session: 'new' }]));
});

test('⌘⇧↵ on a local pane submits the file\'s drafts to the workspace\'s review: to a new session, then to the local session in focus (#345)', async () => {
  await pane();
  const region = screen.getByRole('region', { name: LABEL });
  fireEvent.keyDown(region, SEND_KEYS);
  await waitFor(() => expect(posted('/submit')).toHaveLength(1));
  await waitFor(() => expect(screen.getByRole('button', { name: 'enviar 1 rascunho' })).toBeEnabled());
  act(() => rememberFocus(activityKey(LOCAL), LOCAL_SESSION.id)); // last in the file: the focus store outlives each test
  fireEvent.keyDown(region, SEND_KEYS);
  await waitFor(() => expect(posted('/submit')).toHaveLength(2));
  expect(posted('/submit')).toEqual([
    { skip: [], kind: 'design', path: PATH, to: 'new' },
    { skip: [], kind: 'design', path: PATH, to: LOCAL_SESSION.id },
  ]);
});
