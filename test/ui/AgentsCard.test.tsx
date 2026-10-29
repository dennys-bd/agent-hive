import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { AgentsCard } from '@/components/settings/AgentsCard';
import { setLanguage, t } from '@/i18n';
import { draftFrom } from '@/lib/settings-form';
import { ALL_AGENTS } from '../../src/agents';
import type { AgentAvailability } from '../../src/types';

beforeEach(() => setLanguage('pt'));
const section = (agent: string): HTMLElement => screen.getByRole('group', { name: agent });
const renderCard = (patch = {}, agents: readonly AgentAvailability[] = ALL_AGENTS, onChange = vi.fn()) =>
  render(<AgentsCard draft={{ ...draftFrom(undefined), ...patch }} agents={agents} onChange={onChange} onOpenFlow={vi.fn()} />);

test('one section per agent: the default carries padrão and a locked switch with its title; another offers tornar padrão, which sets it (#482)', () => {
  const onChange = vi.fn();
  renderCard({}, ALL_AGENTS, onChange);
  const claude = section('claude');
  expect(within(claude).getByText(t('settings.agents.default'))).toBeInTheDocument();
  expect(within(claude).getByText(t('settings.agents.installed'))).toBeInTheDocument();
  const locked = within(claude).getByRole('switch', { name: t('settings.agents.enabled.of', { agent: 'claude' }) });
  expect(locked).toBeChecked();
  expect(locked).toBeDisabled();
  expect(locked).toHaveAttribute('title', t('settings.agents.lockedDefault'));
  fireEvent.click(within(section('codex')).getByRole('button', { name: t('settings.agents.makeDefault') }));
  expect(onChange).toHaveBeenCalledWith({ defaultAgent: 'codex' });
});

test('turning an agent off sends agentEnabled; off, it hides tornar padrão, says why beside its name and its fields go inert (#482)', () => {
  const onChange = vi.fn();
  const { unmount } = renderCard({}, ALL_AGENTS, onChange);
  fireEvent.click(within(section('codex')).getByRole('switch', { name: t('settings.agents.enabled.of', { agent: 'codex' }) }));
  expect(onChange).toHaveBeenCalledWith({ agentEnabled: { claude: true, codex: false } });
  unmount();
  renderCard({ agentEnabled: { claude: true, codex: false } });
  const codex = section('codex');
  expect(within(codex).queryByRole('button', { name: t('settings.agents.makeDefault') })).not.toBeInTheDocument();
  expect(within(codex).getByText(t('settings.agents.disabled', { agent: 'codex' }))).toBeInTheDocument();
  expect(within(codex).getByLabelText(t('settings.agentArgs', { agent: 'codex' })).closest('[inert]')).not.toBeNull();
});

test('an agent off PATH reads não instalado, with a disabled unchecked switch, no fields and no tornar padrão; as the default it says so (#482)', () => {
  renderCard({}, [{ agent: 'claude', available: false }, { agent: 'codex', available: false }]);
  const codex = section('codex');
  expect(within(codex).getByText(t('settings.agents.missing', { agent: 'codex' }))).toBeInTheDocument();
  const off = within(codex).getByRole('switch', { name: t('settings.agents.enabled.of', { agent: 'codex' }) });
  expect(off).not.toBeChecked();
  expect(off).toBeDisabled();
  expect(within(codex).queryByLabelText(t('settings.agentArgs', { agent: 'codex' }))).not.toBeInTheDocument();
  expect(within(codex).queryByRole('button', { name: t('settings.agents.makeDefault') })).not.toBeInTheDocument();
  expect(within(section('claude')).getByText(`${t('settings.agents.missing', { agent: 'claude' })} · ${t('settings.agents.missingDefault')}`)).toBeInTheDocument();
});

test('each installed agent has its model field and its arguments field, mono with nenhum; editing the arguments sends its text (#482, #924)', () => {
  const onChange = vi.fn();
  renderCard({}, ALL_AGENTS, onChange);
  for (const agent of ['claude', 'codex']) {
    expect(screen.getByRole('combobox', { name: t('settings.agents.model.of', { agent }) })).toBeInTheDocument();
    expect(screen.getByLabelText(t('settings.agentArgs', { agent }))).toHaveAttribute('placeholder', t('settings.agents.args.none'));
  }
  fireEvent.change(screen.getByLabelText(t('settings.agentArgs', { agent: 'claude' })), { target: { value: '--verbose' } });
  expect(onChange).toHaveBeenCalledWith({ agentArgs: { claude: '--verbose', codex: '' } });
});
