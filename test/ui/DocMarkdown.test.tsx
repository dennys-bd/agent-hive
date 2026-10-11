import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { DocMarkdown } from '@/components/DocMarkdown';
import { setLanguage } from '@/i18n';

vi.mock('mermaid', () => ({ default: { initialize: vi.fn(), render: vi.fn(async () => ({ svg: '<svg data-testid="diagram"></svg>' })) } }));

beforeEach(() => { setLanguage('pt'); });

test('raw HTML goes through GitHub\'s allowlist: details and summary are elements; a script, an onclick and a javascript: link are gone (#697)', () => {
  const text = '<details>\n<summary>Task 1</summary>\n\nbody\n\n</details>\n\n<script>alert(1)</script>\n\n<div onclick="alert(2)">click</div>\n\n<a href="javascript:alert(3)">bad</a>';
  const { container } = render(<DocMarkdown text={text} onLink={vi.fn()} />);
  expect(container.querySelector('details > summary')).toHaveTextContent('Task 1');
  expect(container.querySelector('script')).toBeNull();
  expect(container.textContent).not.toContain('alert(1)');
  expect(screen.getByText('click')).not.toHaveAttribute('onclick');
  expect(screen.getByText('bad')).not.toHaveAttribute('href');
});

test('headings carry GitHub\'s slugs behind the sanitizer\'s user-content- prefix, as a raw id does, so no id can clobber a window global (#697)', () => {
  const { container } = render(<DocMarkdown text={'## Task 3: The preview pane\n\n# Hive\n\n<a id="x"></a>'} onLink={vi.fn()} />);
  expect(screen.getByRole('heading', { level: 2 })).toHaveAttribute('id', 'user-content-task-3-the-preview-pane');
  expect(container.querySelector('[id="user-content-hive"]')).not.toBeNull();
  expect(container.querySelector('[id="hive"]')).toBeNull();
  expect(container.querySelector('[id="user-content-x"]')).not.toBeNull();
});

test('a footnote\'s reference and definition link each other by ids the preview can resolve (#697)', () => {
  const { container } = render(<DocMarkdown text={'text[^1]\n\n[^1]: note'} onLink={vi.fn()} />);
  const ids = [...container.querySelectorAll('[id]')].map((element) => element.id);
  const hrefs = [...container.querySelectorAll('a[href^="#"]')].map((a) => a.getAttribute('href')?.slice(1) ?? '');
  expect(hrefs.length).toBeGreaterThan(0);
  for (const href of hrefs) expect(ids.some((id) => id === href || id === `user-content-${href}`)).toBe(true);
});

test('only http, https and mailto hrefs survive the sanitizer; another scheme loses its href (#697)', () => {
  render(<DocMarkdown text={'<a href="xmpp:a@b.c">chat</a> <a href="https://x.dev">web</a> <a href="mailto:a@b.c">mail</a>'} onLink={vi.fn()} />);
  expect(screen.getByText('chat')).not.toHaveAttribute('href');
  expect(screen.getByText('web')).toHaveAttribute('href', 'https://x.dev');
  expect(screen.getByText('mail')).toHaveAttribute('href', 'mailto:a@b.c');
});

test('a middle click on a file link or an anchor does not open a window, an external link keeps its own behaviour (#697)', () => {
  render(<DocMarkdown text="[plan](../plans/p.md) [site](https://example.com)" onLink={vi.fn()} />);
  expect(fireEvent(screen.getByRole('link', { name: 'plan' }), new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }))).toBe(false);
  expect(fireEvent(screen.getByRole('link', { name: 'site' }), new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }))).toBe(true);
});

test('a relative link or an anchor calls onLink; an https link opens outside (#697)', async () => {
  const user = userEvent.setup();
  const onLink = vi.fn();
  render(<DocMarkdown text="[plan](../plans/p.md) [top](#top) [site](https://example.com)" onLink={onLink} />);
  await user.click(screen.getByRole('link', { name: 'plan' }));
  await user.click(screen.getByRole('link', { name: 'top' }));
  expect(onLink.mock.calls).toEqual([['../plans/p.md'], ['#top']]);
  expect(screen.getByRole('link', { name: 'site' })).toHaveAttribute('target', '_blank');
  expect(screen.getByRole('link', { name: 'site' })).toHaveAttribute('rel', 'noreferrer');
});

test('a GitHub alert renders as an aside with its title, the marker gone (#697)', () => {
  render(<DocMarkdown text={'> [!WARNING]\n> careful'} onLink={vi.fn()} />);
  const aside = screen.getByRole('complementary');
  expect(aside).toHaveAttribute('data-alert', 'warning');
  expect(aside).toHaveTextContent('Atenção');
  expect(aside).toHaveTextContent('careful');
  expect(aside.textContent).not.toContain('[!WARNING]');
});

test(':smile: becomes the character (#697)', () => {
  render(<DocMarkdown text="done :smile:" onLink={vi.fn()} />);
  expect(screen.getByText('done 😄')).toBeInTheDocument();
});

test('with a repository, #12 and @octocat link to GitHub and open outside; without one they stay text (#697)', () => {
  const { unmount } = render(<DocMarkdown text="see #12 and @octocat" repository="acme/app" onLink={vi.fn()} />);
  expect(screen.getByRole('link', { name: '#12' })).toHaveAttribute('href', 'https://github.com/acme/app/issues/12');
  expect(screen.getByRole('link', { name: '#12' })).toHaveAttribute('target', '_blank');
  expect(screen.getByRole('link', { name: '@octocat' })).toHaveAttribute('href', 'https://github.com/octocat');
  unmount();
  render(<DocMarkdown text="see #12 and @octocat" onLink={vi.fn()} />);
  expect(screen.queryAllByRole('link')).toEqual([]);
});

test('$x^2$ and a $$ block render as KaTeX (#697)', () => {
  const { container } = render(<DocMarkdown text={'inline $x^2$\n\n$$\na+b\n$$'} onLink={vi.fn()} />);
  expect(container.querySelectorAll('.katex')).toHaveLength(2);
  expect(container.querySelector('.katex-display')).not.toBeNull();
});

test('a ```mermaid block mounts its diagram instead of a code block (#697)', async () => {
  const { container } = render(<DocMarkdown text={'```mermaid\ngraph TD; A-->B\n```'} onLink={vi.fn()} />);
  expect(await screen.findByTestId('diagram')).toBeInTheDocument();
  expect(container.querySelector('pre > code.language-mermaid')).toBeNull();
});

test('a render with a new onLink keeps the drawn diagram instead of mounting it again over its code (#906)', async () => {
  const text = '```mermaid\ngraph TD; Keep-->Drawn\n```';
  const { container, rerender } = render(<DocMarkdown text={text} onLink={vi.fn()} />);
  const diagram = await screen.findByTestId('diagram');
  rerender(<DocMarkdown text={text} onLink={vi.fn()} />);
  expect(container.querySelector('pre > code.language-mermaid')).toBeNull();
  expect(screen.getByTestId('diagram')).toBe(diagram);
});

test('a local link calls the latest onLink after a render that changed it (#906)', async () => {
  const first = vi.fn();
  const latest = vi.fn();
  const { rerender } = render(<DocMarkdown text="[file](notes.md)" onLink={first} />);
  rerender(<DocMarkdown text="[file](notes.md)" onLink={latest} />);
  await userEvent.click(screen.getByText('file'));
  expect(latest).toHaveBeenCalledWith('notes.md');
  expect(first).not.toHaveBeenCalled();
});
