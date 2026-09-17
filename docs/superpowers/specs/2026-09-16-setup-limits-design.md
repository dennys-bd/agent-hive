# Agent Hive — setup: seção única de limites (orçamento + faixas de uso)

Extensão do orçamento (`docs/superpowers/specs/2026-09-16-token-budget-design.md`) e das faixas de uso (`docs/superpowers/specs/2026-09-16-usage-rules-design.md`); a v1 (`docs/superpowers/specs/2026-09-15-agent-hive-design.md`) é autoritativa pra tudo que não está aqui. Issue: [#17](https://github.com/dennys-bd/agent-hive/issues/17). Objetivo: os dois mecanismos que limitam uso de tokens passam a ser editados no mesmo lugar. O formulário de setup ganha uma seção `limites` com os campos de orçamento (com explicação) e uma tabela editável das faixas de uso (`usageRules`), salva pelo `POST /setup` já existente. O item 6 deixou `usageRules` fora do formulário de propósito ("ajuste raro, feito à mão"); este item reverte só essa decisão. Nada muda no orquestrador, no `parseConfig` ou no medidor do dashboard.

## O que os itens 5 e 6 já entregam

- `Config.budget` / `SetupBody.budget`: dois campos numéricos `tokens por hora` / `tokens por dia` no formulário, `budgetFromForm` (vazio → chave ausente), `parseBudget`.
- `Config.usageRules: UsageRule[]` com `parseUsageRule` (`percent` inteiro 0–100, `maxWorkers` inteiro ≥ 0, `signal` ∈ `green/yellow/red`, pelo menos um efeito, erro nomeando `usageRules[i].campo`); `setUsageRules` no `configure` / `reconfigure`; `saveSetup` passa `current?.usageRules`.
- `applyUsageRules`: faixas cumulativas, ordem do array irrelevante, manual × dinâmico = o mais restritivo vence.

## Decisões fechadas

| Decisão | Escolha | Motivo |
|---|---|---|
| Onde a seção fica | Um `<fieldset id="limits">` com `<legend>limites</legend>` logo depois de `máx. workers`, antes de `prompt do worker`; dentro dele, primeiro o orçamento, depois a tabela | É a posição que os campos de orçamento já ocupam; `fieldset` é o agrupamento nativo e o CSS do formulário já o trata (`border: 0`). Não fica `disabled` nunca (o `fieldset[disabled] { display: none }` é dos campos por tipo de board) |
| Copy do orçamento | Hint abaixo dos dois campos: "totais por hora e por dia; ao estourar, nenhum job novo abre (os que estão rodando terminam). Vazio = sem limite" | Substitui o `vazio = sem limite` seco do item 5; é a resposta a "o que esses campos fazem" |
| Forma da tabela | `<table id="rules">` com uma linha por faixa: `% do orçamento` (`input number min=0 max=100 step=1 required`), `máx. workers` (`input number min=0 step=1`, vazio = sem teto), `sinal` (`select` com `—` / `green` / `yellow` / `red`, `—` = não muda) e um botão `remover`. Abaixo, um botão `adicionar faixa` | Uma linha = um `UsageRule`; os mesmos nomes de campo do JSON traduzidos. Os sinais ficam em inglês como no header do dashboard (`green` / `yellow` / `red` são o nome dos estados, não copy) |
| Hint da tabela | "faixas cumulativas: ao passar de uma faixa, valem todas as anteriores (o pior sinal e o menor teto). O sinal manual do dashboard vence quando é mais restritivo." | É o que `applyUsageRules` faz e o que o issue pede pra explicar |
| Validação no cliente | Nativa pra `percent` (`required`, `min`, `max`) e `maxWorkers` (`min`); "pelo menos um efeito" checada em `usageRulesFromForm`: linha sem `maxWorkers` e com sinal `—` → `setupError("faixa N: informe máx. workers ou sinal")` e o envio não acontece | O navegador já bloqueia 0–100 e vazio com `required`; só a regra que o HTML não expressa vira código. O servidor continua sendo a validação de verdade |
| Validação no servidor | `parseConfig` como hoje, sem mudança; `usageRules` do corpo entra em `parseConfig` como `budget` entra, e um erro responde 400 com a mensagem `usageRules[i]…` nomeando o campo | A fronteira de confiança é o `POST /setup`, não o formulário; a mensagem do `parseConfig` já nomeia a linha |
| Forma do corpo | `SetupBody.usageRules?: UsageRule[]`; o formulário sempre manda (tabela vazia → `[]`); quem chama a API sem a chave mantém as regras do arquivo: `usageRules: body.usageRules ?? current?.usageRules` | Espelha `budget` (mesma frase no tipo). Zero linhas = "sem faixas", que é o default do item 6 |
| Ordem das linhas | Salvas na ordem em que estão na tabela; sem ordenar por `percent` | `applyUsageRules` ignora a ordem; ordenar seria código pra um efeito só estético |
| Formulário sem regras | Ao abrir o setup com `usageRules: []` (ou sem config), a tabela abre vazia, só com `adicionar faixa` | Sem sugerir uma tabela padrão: os percentuais ainda vão ser calibrados (item 6, "Fora") |
| Onde o código da tabela vive | `src/ui/limits.ts` (novo): `renderRules(rules)`, `addRuleRow(rule?)`, `usageRulesFromForm()`; `app.ts` importa e chama. O servidor serve `/ui/limits.js` com uma rota igual à de `/ui/app.js` | `app.ts` já passou de 400 linhas; a tabela é a única parte do formulário com estado próprio (linhas dinâmicas) e cabe num módulo. Rota explícita por arquivo, sem `static` genérico, como hoje |
| Dashboard | Sem mudança | Mostrar o sinal / teto efetivo e a faixa que disparou fica pro follow-up do issue (sobrepõe #13) |
| Fora | Ordenar / deduplicar faixas; tabela padrão sugerida; "por que está amarelo" no dashboard; editar `port` / `claudeArgs` pelo formulário | Escopo do issue; `port` e `claudeArgs` continuam só no arquivo |

## Config

Sem mudança de formato. O formulário passa a produzir o mesmo JSON que hoje se escreve à mão:

```jsonc
{
  "budget": { "maxTokensPerHour": 2000000, "maxTokensPerDay": 20000000 },
  "usageRules": [
    { "percent": 50, "maxWorkers": 4 },
    { "percent": 80, "signal": "yellow" }
  ]
}
```

## Tipos

```ts
interface SetupBody {
  // …campos anteriores…
  /** The form always sends it (empty table = []); an API caller that omits it keeps the current rules. */
  usageRules?: UsageRule[];
}
```

`UsageRule`, `Config` e `State` não mudam.

## Formulário (`src/ui/index.html`)

Depois de `máx. workers`:

```html
<fieldset id="limits">
  <legend>limites</legend>
  <div class="row">
    <label>tokens por hora <input id="budget-hour" type="number" min="0" step="1"></label>
    <label>tokens por dia <input id="budget-day" type="number" min="0" step="1"></label>
  </div>
  <div class="hint">totais por hora e por dia; ao estourar, nenhum job novo abre (os que estão rodando terminam). Vazio = sem limite.</div>
  <table id="rules">
    <thead><tr><th>% do orçamento</th><th>máx. workers</th><th>sinal</th><th></th></tr></thead>
    <tbody></tbody>
  </table>
  <button type="button" id="add-rule">adicionar faixa</button>
  <div class="hint">faixas cumulativas: ao passar de uma faixa, valem todas as anteriores (o pior sinal e o menor teto). O sinal manual do dashboard vence quando é mais restritivo.</div>
</fieldset>
```

CSS: `legend` com o mesmo estilo do `h2` reduzido; `#rules` com `width: 100%`, inputs dentro da célula herdam o estilo de `#setup input`; `#rules td button` pequeno. `<script type="module" src="/ui/app.js">` continua sendo o único script; `app.js` importa `./limits.js`.

## `src/ui/limits.ts` (novo)

```ts
export function renderRules(rules: UsageRule[]): void; // clears tbody and adds one row per rule
export function addRuleRow(rule?: UsageRule): void;    // appends a row (empty when no rule); wires its "remover"
export function usageRulesFromForm(): UsageRule[];      // throws Error('faixa N: informe máx. workers ou sinal') for a row with no effect
```

Cada linha: `percent` de `input.value` (`Number`), `maxWorkers` só quando o campo não está vazio, `signal` só quando o select não é `—`. Chaves ausentes nunca viram `undefined` explícito (o JSON gravado fica limpo, como `budgetFromForm`).

## `src/ui/app.ts`

- `openSetup`: `renderRules(config?.usageRules ?? [])`.
- `saveSetup`: `usageRules: usageRulesFromForm()` no corpo, dentro do `try` que já mostra `setupError` (a exceção da linha sem efeito cai no mesmo caminho e o `POST` não acontece).
- Listener: `$('add-rule')` → `addRuleRow()`.

## Servidor (`src/server.ts`)

- `saveSetup`: `usageRules: body.usageRules ?? current?.usageRules` (comentário atual "not in the form" sai).
- Rota `app.get('/ui/limits.js', …)` igual à de `/ui/app.js`.

## Testes

- `test/setup.test.ts`: o teste "usageRules come from the file only" vira "POST /setup with usageRules writes them, GET /setup returns them and the State carries them": corpo com duas regras → arquivo, `GET /setup` e `getState()` batem; um segundo `POST` sem a chave mantém as do arquivo; `[]` limpa; `{ percent: 101 }` e `{ percent: 50 }` (sem efeito) → 400 com `usageRules[0]` na mensagem e nada gravado. (+0 testes, o existente é reescrito; +1 pro caso de erro.)
- `src/ui/limits.ts` é DOM puro e fica fora do `node:test`, como o resto de `src/ui/`. Verificação manual (`pnpm start`): abrir o setup com a config de exemplo acima → a tabela mostra as duas linhas; remover uma, adicionar uma sem efeito e salvar → erro `faixa 2: …` sem `POST`; corrigir e salvar → `hive.config.json` com as linhas na ordem da tabela; `GET /setup` devolve as mesmas.

## Critério de pronto

1. Com `hive.config.json` sem `usageRules`, abrir o setup mostra a seção `limites` com os dois campos de orçamento explicados e uma tabela vazia; adicionar `{ 80, —, yellow }` e salvar grava `usageRules: [{ "percent": 80, "signal": "yellow" }]` e o `State` vivo já usa a faixa (sinal efetivo amarelo acima de 80%, como no item 6).
2. Reabrir o setup mostra a mesma linha; salvar sem mexer não altera o arquivo.
3. `pnpm test` verde com o teste acima; `parseConfig`, o orquestrador e o medidor não mudam.
