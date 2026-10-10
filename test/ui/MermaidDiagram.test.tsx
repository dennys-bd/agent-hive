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
  render(<MermaidDiagram code="graph TD; A-->B" />);
  await screen.findByTestId('diagram');
  act(() => { document.documentElement.dataset.theme = 'dark'; });
  await waitFor(() => expect(mermaid.initialize).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'dark' })));
  await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(2));
});
