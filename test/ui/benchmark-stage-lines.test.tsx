import { beforeEach, expect, test } from 'vitest';
import { entriesText, exitsOf, nodeLine, verdictsText } from '@/components/benchmark/arms/stage-lines';
import { setLanguage } from '@/i18n';
import { ARMS_FLOW } from './benchmark-fixtures';

beforeEach(() => setLanguage('pt'));

test('exits and entries read as the screen writes them (#536)', () => {
  expect(exitsOf(ARMS_FLOW, 'Checks')).toEqual([{ trigger: 'passou', to: 'Avaliação', isBack: false }, { trigger: 'falhou', to: 'Build', isBack: true, tries: 3 }]);
  expect(exitsOf(ARMS_FLOW, 'PR')).toEqual([{ trigger: 'terminou', to: 'fim', isBack: false }]);
  expect(exitsOf(ARMS_FLOW, 'Avaliação')[1]).toEqual({ trigger: 'reprovou', to: 'Build', isBack: true, tries: 2 });
  expect(entriesText(ARMS_FLOW, 'Spec')).toBe('chega do início');
  expect(entriesText(ARMS_FLOW, 'Build')).toBe('chega de Plan, Checks (falhou) e Avaliação (reprovou)');
  expect(entriesText(ARMS_FLOW, 'Avaliação')).toBe('chega de Checks (passou)');
});

test('verdicts and the node line per kind of stage (#536)', () => {
  const [spec, , , checks, evaluate] = ARMS_FLOW.stages;
  expect(verdictsText(spec)).toBe('nenhum · a saída é ao terminar');
  expect(verdictsText(checks)).toBe('passou quando todos saem com 0, senão falhou');
  expect(verdictsText(evaluate)).toMatch(/^o Hive dá pelo juiz/);
  expect(verdictsText({ name: 'Gate', approval: true })).toBe('aprovou ou pediu mudanças, por você');
  expect(verdictsText({ name: 'Triage', prompt: 'x', verdicts: ['passed', 'big'] })).toBe('passou, big');
  expect(nodeLine(checks)).toBe('3 comandos');
  expect(nodeLine({ ...checks, commands: ['test'] })).toBe('1 comando');
  expect(nodeLine(evaluate)).toBe('juiz · fable');
  expect(nodeLine(spec)).toBe('claude · sonnet');
});
