import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ImageView } from '@/components/ImageView';
import { setLanguage } from '@/i18n';
import { jsonResponse } from '../fakes';

const A = 'a-I1';
const PATH = 'shots/home.png';
// What the disk answers: the image's bytes (or a refusal) and its version
let image: () => Response = () => new Response(new Uint8Array(2048));
let version = 'v1';
let blobs = 0;
const fetchMock = vi.fn(async (url: string) => (url.includes('/file-version') ? jsonResponse({ version }) : image()));
const reads = (route: string): number => fetchMock.mock.calls.filter(([url]) => url.startsWith(`/activities/${A}/${route}?`)).length;
const view = () => <ImageView activityId={A} path={PATH} active />;
const percent = (): string | null => screen.getByTitle('voltar a 100%').textContent;

// jsdom decodes nothing: the test gives the <img> its natural size and fires its load
async function loaded(width = 640, height = 480): Promise<HTMLImageElement> {
  const img = await screen.findByAltText<HTMLImageElement>(PATH);
  Object.defineProperties(img, { naturalWidth: { value: width, configurable: true }, naturalHeight: { value: height, configurable: true } });
  fireEvent.load(img);
  return img;
}

beforeEach(() => {
  setLanguage('pt');
  image = () => new Response(new Uint8Array(2048));
  version = 'v1';
  blobs = 0;
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  Object.assign(URL, { createObjectURL: vi.fn(() => `blob:${++blobs}`), revokeObjectURL: vi.fn() }); // jsdom has neither
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('the image route\'s bytes show as an object URL, the bar reading the dimensions and the size once it loads (#498)', async () => {
  render(view());
  const img = await loaded();
  expect(img).toHaveAttribute('src', 'blob:1');
  expect(screen.getByText('640 × 480 · 2.0 KB')).toBeInTheDocument();
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/activities/a-I1/image?path=shots%2Fhome.png']);
  expect(screen.queryByRole('button', { name: 'ver código' })).not.toBeInTheDocument();
});

test('fit shows the whole image and never above 100%; −, + and the percentage step within 10%–800% (#498)', async () => {
  const user = userEvent.setup();
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(320);
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(240);
  render(view());
  const img = await loaded(640, 480);
  expect([percent(), img.style.width]).toEqual(['50%', '320px']);
  await user.click(screen.getByRole('button', { name: 'aumentar zoom' }));
  expect(percent()).toBe('75%');
  await user.click(screen.getByTitle('voltar a 100%'));
  expect(percent()).toBe('100%');
  for (const expected of ['75%', '50%', '25%', '10%']) {
    await user.click(screen.getByRole('button', { name: 'diminuir zoom' }));
    expect(percent()).toBe(expected);
  }
  expect(screen.getByRole('button', { name: 'diminuir zoom' })).toBeDisabled();
  await user.click(screen.getByTitle('voltar a 100%'));
  for (let i = 0; i < 6; i++) await user.click(screen.getByRole('button', { name: 'aumentar zoom' }));
  expect([percent(), img.style.width]).toEqual(['800%', '5120px']);
  expect(screen.getByRole('button', { name: 'aumentar zoom' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'ajustar' }));
  expect(percent()).toBe('50%');
  await loaded(100, 50); // a small image fits at its own size
  expect(percent()).toBe('100%');
});

test('a ⌘ or Ctrl wheel zooms and keeps the page from zooming; a plain wheel only scrolls (#498)', async () => {
  render(view());
  const img = await loaded();
  const pane = img.parentElement?.parentElement as HTMLElement;
  expect(fireEvent.wheel(pane, { ctrlKey: true, deltaY: -200 })).toBe(false);
  expect(percent()).toBe('200%');
  fireEvent.wheel(pane, { metaKey: true, deltaY: 200 });
  expect(percent()).toBe('100%');
  expect(fireEvent.wheel(pane, { deltaY: -200 })).toBe(true);
  expect(percent()).toBe('100%');
});

test('a new version from the poll fetches the image again and revokes the URL it replaced; the view\'s unmount revokes the last (#498)', async () => {
  const { unmount } = render(view());
  const img = await loaded();
  fireEvent.focus(window);
  await waitFor(() => expect(reads('file-version')).toBe(1)); // the first answer is the baseline
  version = 'v2';
  await waitFor(() => {
    fireEvent.focus(window);
    expect(reads('image')).toBe(2);
  });
  await waitFor(() => expect(img).toHaveAttribute('src', 'blob:2'));
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:1');
  unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:2');
});

test('a refused read shows why, in the pane\'s words for a 404 and the server\'s for any other (#498)', async () => {
  for (const [status, text] of [[404, 'arquivo não encontrado'], [500, 'disco cheio']] as const) {
    image = () => jsonResponse({ error: 'disco cheio' }, status);
    const { unmount } = render(view());
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
    expect(screen.queryByAltText(PATH)).not.toBeInTheDocument();
    unmount();
  }
});

test('an image the browser cannot decode shows imagem inválida, no zoom (#498)', async () => {
  render(view());
  fireEvent.error(await screen.findByAltText(PATH));
  expect(await screen.findByRole('alert')).toHaveTextContent('imagem inválida');
  expect(screen.queryByRole('button', { name: 'ajustar' })).not.toBeInTheDocument();
});
