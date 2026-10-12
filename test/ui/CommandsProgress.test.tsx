import { beforeEach, expect, test } from 'vitest';
import { taskError } from '@/components/CommandsProgress';
import { setLanguage } from '@/i18n';
import { STAGE_GONE } from '../../src/types';

beforeEach(() => setLanguage('en'));

test('a task halted because its stage was deleted reads in the viewer\'s language (#861)', () => {
  expect(taskError(`${STAGE_GONE}Backlog`)).toBe('The stage "Backlog" no longer exists');
  setLanguage('pt');
  expect(taskError(`${STAGE_GONE}Backlog`)).toBe('A etapa "Backlog" não existe mais');
});
