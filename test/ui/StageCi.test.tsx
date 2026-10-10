import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';
import { StageCi } from '@/components/settings/StageCi';
import { setLanguage } from '@/i18n';
import { emptyStage, type StageDraft } from '@/lib/settings-form';

beforeEach(() => setLanguage('pt'));

// The block over its own draft, as StageEditor holds it: every update is seen and applied
function Harness({ initial = {}, onUpdate }: { initial?: Partial<StageDraft>; onUpdate(patch: Partial<StageDraft>): void }) {
  const [stage, setStage] = useState<StageDraft>({ ...emptyStage(), action: 'waitForCi', ...initial });
  return <StageCi id="s" stage={stage} onUpdate={(patch) => { onUpdate(patch); setStage((s) => ({ ...s, ...patch })); }} />;
}

test('a new wait starts on the branch\'s required checks, a 60m wait and the re-run off; the chips show only under só estes (#834)', async () => {
  const onUpdate = vi.fn();
  render(<Harness onUpdate={onUpdate} />);
  const which = screen.getByRole('combobox', { name: 'quais checks' });
  expect(which).toHaveTextContent('os obrigatórios da branch');
  expect(screen.queryByRole('textbox', { name: 'checks' })).not.toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'espera até' })).toHaveValue('60m');
  expect(screen.getByRole('switch', { name: 'executar de novo uma vez' })).not.toBeChecked();
  fireEvent.click(which);
  fireEvent.click(await screen.findByRole('option', { name: 'só estes' }));
  expect(onUpdate).toHaveBeenLastCalledWith({ ciChecks: 'list' });
  expect(screen.getByRole('textbox', { name: 'checks' })).toHaveAttribute('placeholder', 'nome ou padrão');
});

test('Enter and a comma add a chip, trimmed; x removes it; a duplicate is ignored (#834)', async () => {
  const user = userEvent.setup();
  const onUpdate = vi.fn();
  render(<Harness initial={{ ciChecks: 'list' }} onUpdate={onUpdate} />);
  const field = screen.getByRole('textbox', { name: 'checks' });
  await user.type(field, ' build {Enter}');
  expect(onUpdate).toHaveBeenLastCalledWith({ checks: ['build'] });
  await user.type(field, 'e2e-*,');
  expect(onUpdate).toHaveBeenLastCalledWith({ checks: ['build', 'e2e-*'] });
  expect(field).toHaveValue('');
  onUpdate.mockClear();
  await user.type(field, 'build{Enter}');
  expect(onUpdate).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'remover build' }));
  expect(onUpdate).toHaveBeenLastCalledWith({ checks: ['e2e-*'] });
});

test('de onde has its one option with its hint; the hints and the note read as the handoff writes them (#834)', () => {
  render(<Harness onUpdate={vi.fn()} />);
  expect(screen.getByRole('combobox', { name: 'de onde' })).toHaveTextContent('checks do PR da tarefa');
  expect(screen.getByText('lidos pelo gh · GitHub Actions e qualquer check reportado no último commit')).toBeInTheDocument();
  expect(screen.getByText('30s, 10m, 1h · estourar = "falhou"')).toBeInTheDocument();
  expect(screen.getByText('re-run dos jobs que falharam antes do veredito, para checks instáveis')).toBeInTheDocument();
  expect(screen.getByText(/entram em \{result\.ci\.output\}$/)).toBeInTheDocument();
});

test('an emptied espera até means no limit; the switch turns the re-run on (#834)', async () => {
  const user = userEvent.setup();
  const onUpdate = vi.fn();
  render(<Harness onUpdate={onUpdate} />);
  const wait = screen.getByRole('textbox', { name: 'espera até' });
  await user.clear(wait);
  expect(onUpdate).toHaveBeenLastCalledWith({ timeout: '' });
  expect(wait).toHaveAttribute('placeholder', 'sem limite');
  await user.click(screen.getByRole('switch', { name: 'executar de novo uma vez' }));
  expect(onUpdate).toHaveBeenLastCalledWith({ rerunOnce: true });
});
