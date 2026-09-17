# Agent Hive — sessão do worker dentro do app

Extensão dos workers embutidos (`2026-09-16-embedded-workers-design.md`), que já entregam o painel de detalhe com a saída ao vivo (`GET /slots/:id/output`) e a linha de input (`POST /slots/:id/input`). Este item completa a "sessão dentro do app": a saída passa a ser renderizada com realce de sintaxe em blocos de código e diffs, as edições do worker aparecem como diff, e o Hive detecta quando o worker parou esperando uma resposta. Issue: <https://github.com/dennys-bd/agent-hive/issues/8>.

## Decisões fechadas

| Decisão | Escolha | Motivo |
|---|---|---|
| Fonte do transcript | O stdout já capturado pelo pool (`workers.ts`), não o `transcript_path` do hook `Stop` | Já existe, é ao vivo e sem I/O de arquivo; o transcript em disco só valeria após um restart, e a decisão da v1 é que saída de processo morto não interessa |
| Realce de sintaxe | Sem dependência nova: `src/ui/highlight.ts` puro (string → HTML) com fences markdown, `diff` por linha e um tokenizador por regex (comentário, string, número, palavra-chave) para os outros blocos | Regra do repo (sem dependência de runtime sem dizer); highlight.js via CDN não funciona offline e não passa por teste `node:test`. O realce leve cobre o que o worker escreve (código, diffs, comandos) |
| De onde vem o diff | O `tool_use` de `Edit` vira um bloco ```` ```diff ```` com `old_string` em `-` e `new_string` em `+` (máx. 40 linhas por lado); `Write` continua `▶ Write: <path>` | É o único lugar do stream onde um diff existe: tool results (`user`) são descartados desde a v1 e o conteúdo de um `Write` pode ser enorme |
| Como detectar "esperando resposta" | A linha `result` carrega o texto final (`result: string`). O pool passa esse texto em `onResult(workerId, text)`; o server despacha `{ type: 'idle', workerId, question }` quando o slot não tem PR | Em modo print não há `Notification` de pergunta/permissão: o worker faz a pergunta em texto e encerra o turno. Um `result` sem PR significa que nada mais acontece até alguém digitar |
| O que `idle` faz no reducer | Slot com `prUrl` → nada (o server já fecha o stdin); sem PR → `status: 'esperando_voce'`, `question: <texto até 500 chars>`, `lastEvent: 'aguardando resposta'`; `paused` não é tocado | Reusa o status e o blink do card que já existem para `Notification`; `UserPromptSubmit` já limpa `question` e `paused` quando a resposta chega |
| Ordem `Stop` × `result` | `Stop` (hook, síncrono) chega antes do `result` e volta o slot para `trabalhando`; o `idle` chega depois e sobrescreve | É a ordem que o `claude` garante (hooks bloqueiam o fim do turno); não precisa de flag intermediária |
| Render do painel | `#output` vira `<div>` com `innerHTML = renderOutput(lines)`; pula o re-render quando o texto não mudou; continua rolando pro fim | Mesmo contrato do polling atual; só a formatação muda |
| Escape | Todo texto do worker passa por `esc()` antes de qualquer markup do realce | O worker escreve o que quiser (inclusive `<script>`); o painel é `innerHTML` |
| Foco/UX extra | Nada além do placeholder do input mudar para "responder ao worker" quando o slot está `esperando_voce` | O card já pisca; o resto é YAGNI |

## Config e tipos

Sem config nova. Em `src/types.ts`:

```ts
type HiveEvent =
  | /* como hoje */
  | { type: 'idle'; workerId: string; question: string }; // a `result` line without a PR: the worker waits for input
```

`StartWorker.onResult` passa a ser `(workerId: string, text: string) => void`.

## `src/workers.ts`

- `parseLine` também lê `result?: string` e `input.old_string` / `input.new_string`.
- `describeBlock` para `tool_use` com `name === 'Edit'`: `['▶ Edit: <file_path>', '```diff', ...oldLines.map('-' + l), ...newLines.map('+' + l), '```']` com cada lado cortado em `DIFF_MAX = 40` linhas (uma linha `…` marca o corte). Os outros tools continuam como hoje.
- `onResult(workerId, String(parsed.result ?? ''))`.

## `src/ui/highlight.ts` (novo, puro)

- `renderOutput(lines: string[]): string`: junta com `\n`, quebra em segmentos por fence (```` ```lang ````…```` ``` ````); texto fora de fence → `esc()` com `` `inline` `` virando `<code>`; fence → `<pre class="code" data-lang="<lang>">` com o corpo por `highlight(lang, body)`.
- `highlight(lang, body)`: `diff` → cada linha em `<span class="add|del|hunk">` conforme `+` / `-` / `@@`; qualquer outro → escapa e aplica, nesta ordem e sem sobreposição, `comment` (`//…`, `#…`, `/*…*/`), `string` (`'…'`, `"…"`, `` `…` ``), `number`, `keyword` (lista curta comum a TS/JS/Python/Go/Rust/shell). Um tokenizador de uma passada com regex alternada; nada de gramática por linguagem.
- Sem DOM: testável com `node:test`.

## `src/server.ts`

- `onResult: (workerId, text) => void onTurnEnd(workerId, text)`: se o slot está em `aguardando_review` → `pool.end(workerId)`; senão `dispatch({ type: 'idle', workerId, question: text })`.

## `src/orchestrator.ts`

- Caso `idle`: slot desconhecido, `vazio` ou com `prUrl` → `none`; senão `patch(... { status: 'esperando_voce', question: question.slice(0, QUESTION_MAX), lastEvent: 'aguardando resposta' })`.

## UI

- `index.html`: `<pre id="output">` → `<div id="output">`; CSS para `.code`, `.add`, `.del`, `.hunk`, `.comment`, `.string`, `.number`, `.keyword`, `code`.
- `app.ts`: `loadOutput` usa `renderOutput`; placeholder do input conforme o status.

## Testes

- `test/highlight.test.ts` (novo): fence `diff` colore `+`/`-`/`@@`; fence `ts` marca string, comentário, número e palavra-chave; texto fora de fence é escapado (`<script>` vira `&lt;script&gt;`); inline code; fence sem fechamento é tratada como aberta até o fim.
- `test/workers.test.ts`: `Edit` gera o bloco diff (com corte em 40); `onResult` recebe o texto do `result`.
- `test/orchestrator.test.ts`: `idle` sem PR → `esperando_voce` + `question`; com PR → estado inalterado; worker desconhecido → inalterado.
- `test/server.test.ts`: `result` sem PR → slot `esperando_voce` com a pergunta; com PR → `end` no handle (como hoje).

## Critério de pronto

1. `pnpm start`, worker rodando: um bloco de código na saída aparece com fundo próprio e tokens coloridos; um `Edit` aparece como diff verde/vermelho.
2. O worker termina o turno com uma pergunta e sem PR: o card pisca `esperando você`, o painel mostra a pergunta em "pendente", responder pelo input volta o card para `trabalhando`.
3. `pnpm test` verde.

## Fora

Cena do robô; leitura do `transcript_path`; aprovação de permissão pelo dashboard; realce por gramática de linguagem; streaming parcial.
