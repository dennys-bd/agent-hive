import { render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { CopilotIcon } from '@/components/CopilotIcon';
import { AGENT_COLOR, AGENT_ICON } from '@/components/SessionLabel';
import { SessionLine } from '@/components/SessionLines';

test('a copilot run\'s line shows Copilot\'s own mark beside its name, in its own colour token (#873)', () => {
  expect(AGENT_ICON.copilot).toBe(CopilotIcon);
  expect(AGENT_COLOR.copilot).toBe('text-agent-copilot');
  render(<SessionLine agent="copilot" label="a1b2c3d4" status="working" isShown={false} onOpen={vi.fn()} />);
  expect(screen.getByRole('button', { name: /^copilot/ }).querySelector('svg[data-icon="copilot"]')).not.toBeNull();
});
