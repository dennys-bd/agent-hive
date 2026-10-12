import { render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { CodexIcon } from '@/components/CodexIcon';
import { AGENT_ICON } from '@/components/SessionLabel';
import { SessionLine } from '@/components/SessionLines';

test('a codex run\'s line shows Codex\'s own mark beside its name (#927)', () => {
  expect(AGENT_ICON.codex).toBe(CodexIcon);
  render(<SessionLine agent="codex" label="a1b2c3d4" status="working" isShown={false} onOpen={vi.fn()} />);
  expect(screen.getByRole('button', { name: /^codex/ }).querySelector('svg[data-icon="codex"]')).not.toBeNull();
});
