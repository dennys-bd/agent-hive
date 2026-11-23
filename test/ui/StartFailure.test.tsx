import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test } from 'vitest';
import { StartFailure } from '@/components/StartFailure';
import { setLanguage } from '@/i18n';
import { SPAWN_FAILED } from '../../src/types';

const ERROR = `${SPAWN_FAILED}account claude missing: no token named work`;
afterEach(() => setLanguage('en'));

test('a refused account shows its copy with the agent\'s name in English and Portuguese, the raw message only behind details (#953)', async () => {
  const user = userEvent.setup();
  setLanguage('en');
  const { unmount } = render(<StartFailure error={ERROR} />);
  expect(screen.getByText('the Claude account chosen in Settings has no saved token: add it again or choose another')).toBeInTheDocument();
  expect(screen.queryByText(/account claude missing/)).toBeNull();
  await user.click(screen.getByRole('button', { name: 'details' }));
  expect(screen.getByText('account claude missing: no token named work')).toBeInTheDocument();
  unmount();
  setLanguage('pt');
  render(<StartFailure error={ERROR} />);
  expect(screen.getByText('a conta do Claude escolhida na configuração não tem token salvo: adicione de novo ou escolha outra')).toBeInTheDocument();
});
