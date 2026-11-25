import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { GitlabHostsGroup } from '@/components/settings/GitlabHostsGroup';
import { setLanguage, t } from '@/i18n';

beforeEach(() => setLanguage('en'));

test('the GitLab hosts card lists chips; × removes one, Enter adds a host lowercased, gitlab.com is dropped, a bad host or github.com stays with the error (#1044, decision 10)', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<GitlabHostsGroup hosts={['git.example.com']} onChange={onChange} />);
  expect(screen.getByRole('heading', { level: 2, name: 'GitLab hosts' })).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'remove git.example.com' }));
  expect(onChange).toHaveBeenLastCalledWith([]);

  const input = screen.getByRole('textbox', { name: 'add GitLab host' });
  await user.type(input, 'Code.Example.org{Enter}');
  expect(onChange).toHaveBeenLastCalledWith(['git.example.com', 'code.example.org']);
  expect(input).toHaveValue('');

  onChange.mockClear();
  await user.type(input, 'GitLab.com{Enter}');
  expect(onChange).not.toHaveBeenCalled();
  expect(input).toHaveValue('');

  for (const bad of ['https://git.example.com', 'github.com']) {
    await user.clear(input);
    await user.type(input, `${bad}{Enter}`);
    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveValue(bad);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(t('settings.error.gitlabHost', { host: bad }))).toBeInTheDocument();
  }
});

test('the card is in Portuguese when the language is (#1044)', () => {
  setLanguage('pt');
  render(<GitlabHostsGroup hosts={['git.example.com']} onChange={vi.fn()} />);
  expect(screen.getByRole('heading', { level: 2, name: 'hosts GitLab' })).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'adicionar host GitLab' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'remover git.example.com' })).toBeInTheDocument();
});
