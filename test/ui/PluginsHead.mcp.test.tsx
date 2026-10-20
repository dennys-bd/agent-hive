import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setLanguage } from '@/i18n';
import { stubMcp } from './mcp-fixtures';
import { resetMonacoFakes } from './monaco-fake';
import { PluginsWindow } from './skill-editor-harness';

vi.mock('@/lib/monaco', async () => (await import('./monaco-fake')).monacoModule);

beforeEach(() => {
  setLanguage('pt');
  resetMonacoFakes();
});
afterEach(() => vi.unstubAllGlobals());

test("the mcp head has its meta and a + servidor that opens the screen's form (#334)", async () => {
  const user = userEvent.setup();
  stubMcp();
  render(<PluginsWindow />);
  await user.click(within(screen.getByRole('navigation', { name: 'Plugins' })).getByRole('button', { name: 'mcp' }));
  const head = screen.getByTestId('head');
  expect(head).toHaveTextContent('mcpferramentas que a sessão do worker enxerga');
  await screen.findByRole('region', { name: 'servidores externos' });
  expect(screen.queryByRole('form')).not.toBeInTheDocument();
  await user.click(within(head).getByRole('button', { name: '+ servidor' }));
  expect(screen.getByRole('form', { name: 'novo servidor' })).toBeInTheDocument();
});
