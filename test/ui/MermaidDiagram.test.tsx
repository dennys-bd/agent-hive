import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MermaidDiagram } from '@/components/MermaidDiagram';

const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock('mermaid', () => ({ default: mermaid }));

beforeEach(() => {
  mermaid.initialize.mockClear();
  mermaid.render.mockReset();
  mermaid.render.mockResolvedValue({ svg: '<svg data-testid="diagram"></svg>' });
  document.documentElement.dataset.theme = 'light';
});
afterEach(() => { delete document.documentElement.dataset.theme; });

test('shows the code while mermaid loads, then the SVG it draws, strict and with the light theme\'s neutral (#697)', async () => {
  render(<MermaidDiagram code="graph TD; A-->B" />);
  expect(screen.getByText('graph TD; A-->B')).toBeInTheDocument();
  expect(await screen.findByTestId('diagram')).toBeInTheDocument();
  expect(mermaid.initialize).toHaveBeenCalledWith({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral', suppressErrorRendering: true });
  expect(mermaid.render).toHaveBeenCalledWith(expect.stringMatching(/^mermaid-/), 'graph TD; A-->B');
});

test('a diagram mermaid cannot parse shows its code and the error (#697)', async () => {
  mermaid.render.mockRejectedValue(new Error('Parse error on line 1'));
  render(<MermaidDiagram code="graph ??" />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Parse error on line 1');
  expect(screen.getByText('graph ??')).toBeInTheDocument();
});

test('a theme change draws it again with the dark theme (#697)', async () => {
  render(<MermaidDiagram code="graph TD; Theme-->Dark" />);
  await screen.findByTestId('diagram');
  act(() => { document.documentElement.dataset.theme = 'dark'; });
  await waitFor(() => expect(mermaid.initialize).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'dark' })));
  await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(2));
});

test('a remount with the same code and theme shows the cached drawing at once, without drawing it again (#906)', async () => {
  const { unmount } = render(<MermaidDiagram code="graph TD; Cached-->Once" />);
  await screen.findByTestId('diagram');
  unmount();
  render(<MermaidDiagram code="graph TD; Cached-->Once" />);
  expect(screen.getByTestId('diagram')).toBeInTheDocument();
  expect(screen.queryByText('graph TD; Cached-->Once')).toBeNull();
  expect(mermaid.render).toHaveBeenCalledTimes(1);
});

test('a changed code keeps the previous drawing until the new one is drawn, never its code (#906)', async () => {
  const { rerender } = render(<MermaidDiagram code="graph TD; Old-->Drawing" />);
  await screen.findByTestId('diagram');
  let finish: (value: { svg: string }) => void = () => {};
  mermaid.render.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  rerender(<MermaidDiagram code="graph TD; New-->Drawing" />);
  await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(2));
  expect(screen.getByTestId('diagram')).toBeInTheDocument();
  expect(screen.queryByText('graph TD; New-->Drawing')).toBeNull();
  await act(async () => { finish({ svg: '<svg data-testid="redrawn"></svg>' }); });
  expect(await screen.findByTestId('redrawn')).toBeInTheDocument();
});

test('a fixed code drops the old parse error while it draws (#906)', async () => {
  mermaid.render.mockRejectedValueOnce(new Error('Parse error on line 1'));
  const { rerender } = render(<MermaidDiagram code="graph ?? Broken" />);
  await screen.findByRole('alert');
  mermaid.render.mockReturnValueOnce(new Promise(() => {}));
  rerender(<MermaidDiagram code="graph TD; Fixed-->Code" />);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByText('graph TD; Fixed-->Code')).toBeInTheDocument();
});
