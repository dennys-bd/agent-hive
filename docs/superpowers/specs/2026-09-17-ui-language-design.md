# Agent Hive — idioma da interface configurável (pt, en)

Extensão da v1 (`2026-09-15-agent-hive-design.md`), do setup pela interface (`2026-09-16-hive-cli-and-setup-design.md`, aba geral de #33) e dos limites de plano (`2026-09-16-rate-limits-design.md`). Issue: [#44](https://github.com/dennys-bd/agent-hive/issues/44). Objetivo: a interface deixa de ser só em português. O idioma vem da config (`pt` ou `en`); sem config, é o idioma do sistema, e inglês quando o sistema não é português. Pré-requisito: o estado persistido (`state.json`) e o que o reducer grava nele passam a ser dados neutros (chaves), e o texto só existe na hora de mostrar.

## Decisões fechadas

| Decisão | Escolha | Motivo |
|---|---|---|
| Idiomas | `pt` e `en`; `type Language = 'pt' \| 'en'` em `src/types.ts` | O que a issue pede; um terceiro idioma é um dicionário a mais, sem mudança de estrutura |
| Config | `language?: Language`, opcional; ausente = idioma do sistema | Um `hive.config.json` antigo continua válido e ganha o comportamento novo sem edição |
| Fallback | Locale que começa com `pt` → `pt`; qualquer outro (ou desconhecido) → `en` | A issue fixa inglês como fallback |
| Fonte do locale | Electron: `app.getLocale()`; `run.js` / CLI: `Intl.DateTimeFormat().resolvedOptions().locale` (Node lê `LANG`) | Cada modo tem a fonte que conhece; o servidor recebe só o resultado |
| Onde a UI descobre | `GET /setup` devolve `language` efetivo (config ou sistema) | É a primeira chamada do `app.ts`, antes de qualquer render, e existe também em modo setup |
| Formulário | Select `idioma` na aba geral, opções `pt` / `en`, pré-selecionado com o idioma efetivo; salvar grava explícito | Cabe na aba geral (#33); depois do primeiro save o arquivo é a verdade, como os outros campos |
| Status do slot | `Status = 'empty' \| 'working' \| 'waiting' \| 'review'` substitui `vazio` / `trabalhando` / `esperando_voce` / `aguardando_review` | Chave neutra no estado, no log e nas classes CSS; o texto vem do dicionário |
| `lastEvent` | Vira `SlotEvent = { kind, detail? }` com `kind ∈ starting \| prompt \| tool \| waiting \| pr \| paused \| turn` | O reducer não escreve mais frase nenhuma; o dado sobrevive a uma troca de idioma |
| `state.json` legado | `loadState` mapeia os quatro status antigos; status desconhecido → slot vazio (mantém o `id`); `lastEvent` string → descartado | Um Hive atualizado abre um estado antigo sem crash; o boot já dá todo slot ocupado como morto |
| Dicionário | `src/ui/i18n.ts`: `MESSAGES: Record<Language, Messages>`, `t(key, vars?)`, `setLanguage`, `applyTranslations`, `LOCALE` | Um arquivo, servido como `/ui/i18n.js`; testável por `node:test` como o `highlight.ts` |
| HTML estático | Só chaves (`data-i18n`, `data-i18n-html`, `data-i18n-placeholder`); o texto em inglês do dicionário é a única fonte | Sem texto duplicado entre HTML e dicionário; `html[lang]` acompanha |
| Datas e números | `toLocale*` com `LOCALE[language]` (`pt-BR` / `en-US`) | Hoje é `pt-BR` fixo |
| Linha de status do worker | `formatRateLimits(limits, language)`: `sessão` / `semana` em pt, `session` / `week` em en | É texto mostrado ao usuário, gerado pelo servidor; o servidor conhece o idioma |
| Diálogo do Electron | Título do `showOpenDialog` no idioma do sistema | Aparece antes da config existir; duas strings |
| Fora | Mensagens de erro das rotas, dos adapters, do `parseConfig`, do console e do `hive.log` | Diagnóstico com nome de campo, não interface; hoje já é misto. Fica pra outra issue se incomodar |

`docs/superpowers/specs/2026-09-15-agent-hive-design.md` continua valendo pro que não está aqui.

## Config

```json
{ "board": { "type": "github", "owner": "@me", "number": 6 }, "language": "en" }
```

- `language` ∈ `pt` | `en`; valor fora disso → erro do `parseConfig` nomeando o campo. Ausente → chave ausente no `Config` (nunca `undefined` explícito, pra `writeConfigFile` manter o arquivo limpo).
- `POST /setup`: `body.language ?? current?.language`; o formulário sempre manda. Um caller da API que omite mantém o atual.
- README: linha `language` na tabela de config (`sistema` como padrão, `pt` ou `en`, formulário).

## Tipos

```ts
type Language = 'pt' | 'en';
type Status = 'empty' | 'working' | 'waiting' | 'review';
type SlotEventKind = 'starting' | 'prompt' | 'tool' | 'waiting' | 'pr' | 'paused' | 'turn';
interface SlotEvent { kind: SlotEventKind; detail?: string } // detail: the tool summary, or the notification kind

interface Slot { …; status: Status; lastEvent?: SlotEvent; … }
interface Config { …; language?: Language }
interface SetupBody { …; language?: Language }
interface SetupInfo { …; language: Language } // effective: config's, else the system's
```

Mapeamento do reducer (`src/orchestrator.ts`), sem mudar nenhuma regra:

| Antes | Depois |
|---|---|
| `status: 'vazio'` | `'empty'` |
| `status: 'trabalhando'` | `'working'` |
| `status: 'esperando_voce'` | `'waiting'` |
| `status: 'aguardando_review'` | `'review'` |
| `lastEvent: 'iniciando'` | `{ kind: 'starting' }` |
| `lastEvent: 'prompt enviado'` | `{ kind: 'prompt' }` |
| `lastEvent: describeTool(p)` | `{ kind: 'tool', detail: describeTool(p) }` |
| `lastEvent: \`aguardando: ${kind}\`` | `{ kind: 'waiting', detail: kind }` |
| `lastEvent: 'PR aberto'` | `{ kind: 'pr' }` |
| `lastEvent: 'pausado: sinal red'` | `{ kind: 'paused' }` |
| `lastEvent: 'turno encerrado'` | `{ kind: 'turn' }` |

`src/server.ts` e `src/log.ts` só trocam o literal `'vazio'` por `'empty'` (e `'aguardando_review'` por `'review'` na regra de kill após PR). As linhas do `hive.log` (`slot 1: working → review`) passam a sair com as chaves novas.

## Detecção (`src/language.ts`)

```ts
export const LANGUAGES: readonly Language[] = ['pt', 'en'];
export function languageFrom(locale: string | undefined): Language; // /^pt\b/i → 'pt', else 'en'
export function systemLanguage(): Language; // languageFrom(Intl.DateTimeFormat().resolvedOptions().locale)
```

- `bootHive(repo, { locale? })`: `locale` vem do Electron (`app.getLocale()`); ausente, usa `systemLanguage()`. Passa `systemLanguage: Language` em `ServerDeps`.
- `createServer`: `deps.systemLanguage ?? 'en'`. Idioma efetivo = `(live?.runtime.config ?? deps.setupFallback?.config)?.language ?? systemLanguage`. Usado em `GET /setup` e em `POST /hooks/status` (`formatRateLimits`).
- `src/main.ts`: `languageFrom(app.getLocale())` escolhe o título do diálogo e vai pro `bootHive`.

## UI

- `src/ui/i18n.ts`: `MESSAGES` (`en` é o `Messages` de referência; `pt: Record<keyof typeof en, string>`), `LOCALE`, `setLanguage(lang)`, `t(key, vars?)` (`{placeholder}` substituído, pra frases com número ou id no meio), `slotEventText(event)` (o texto de cada `kind`, com `detail` onde cabe), `statusText(status)`, `applyTranslations()` (varre `[data-i18n]` → `textContent`, `[data-i18n-html]` → `innerHTML` só pros hints com `<code>`; o dicionário é código, não entrada, e `[data-i18n-placeholder]` → `placeholder`; e põe `document.documentElement.lang`).
- `src/ui/index.html`: todo texto visível vira chave. Texto dentro de `<label>` que também tem um input vai num `<span data-i18n>` pra não apagar o input. Variáveis e classes CSS: `--empty`, `--working`, `--waiting`; `.card.working`, `.card.waiting`, `.card.review`. Novo campo na aba geral: `<label><span data-i18n="setup.language"></span><select id="language"><option value="pt">português</option><option value="en">English</option></select></label>` (nomes dos idiomas ficam na própria língua, sem tradução).
- `src/ui/app.ts`: `init()` chama `GET /setup`, `setLanguage(setupInfo.language)`, `applyTranslations()`, e só então segue. Depois de um save, `setupInfo` é relido e o mesmo par roda de novo antes de `render()`. `STATUS_LABEL`, `SIGNAL_HINT`, `WINDOW_LABEL` e toda string literal mostrada (banners, `confirm`, `vazia`, `bloqueada por`, `sem orçamento`, `reseta`, `às`, `workers ativos`, `informe …`, `nenhum project …`, `escolha um project`, `reinicie o Hive …`) passam por `t`. `clock`, `toLocaleString`, `toLocaleTimeString` usam `LOCALE[language]`.
- `src/ui/limits.ts`: `remover` e `faixa N: informe …` por `t`; o `—` fica.
- `src/server.ts`: rota `GET /ui/i18n.js`.
- Texto em inglês: minúsculo onde o português é minúsculo (mesmo tom: `save`, `cancel`, `queue`, `detail`, `active workers`, `configure`, `refresh board`).

## Testes

- `test/language.test.ts` (novo): `languageFrom` — `pt-BR`, `pt`, `PT-PT` → `pt`; `en-US`, `fr`, `''`, `undefined` → `en`.
- `test/i18n.test.ts` (novo): `pt` e `en` têm exatamente as mesmas chaves e nenhuma vazia; `statusText` e `slotEventText` nos dois idiomas (`tool` mostra o `detail`, `waiting` prefixa o `detail`).
- `test/config.test.ts`: `language` aceito (`pt`, `en`), rejeitado (`fr`), ausente → chave ausente.
- `test/state-store.test.ts`: os quatro status legados mapeados; status desconhecido → `{ id, status: 'empty' }`; `lastEvent` string descartado; `lastEvent` objeto mantido.
- `test/orchestrator.test.ts`: asserções existentes trocam os literais (`'vazio'` → `'empty'` etc.) e `lastEvent` vira `deepEqual` com o objeto.
- `test/rate-limits.test.ts`: `formatRateLimits(…, 'en')` → `session 23% · week 41%`; `'pt'` mantém o atual.
- `test/setup.test.ts` (onde essas rotas já são cobertas): `GET /setup` devolve `language` da config quando existe, senão `systemLanguage`, senão `en`; `POST /setup` com `language` grava no arquivo; `POST /hooks/status` responde no idioma efetivo.
- `test/hive.test.ts`: `bootHive(repo, { locale: 'pt-BR' })` sem config → `GET /setup` com `language: 'pt'`.
- UI (manual, no PR): `pnpm start` sem config → formulário no idioma do sistema; salvar com `en` → dashboard em inglês sem recarregar; card com evento `tool` mostra o comando nos dois idiomas.

## Critério de pronto

- `NODE_PATH= pnpm test` verde; nenhum literal em português no `orchestrator.ts`, no `state.json` novo nem nas classes CSS.
- Um `state.json` gravado pela versão anterior abre sem erro e os slots ficam vazios após o boot.
- Trocar `language` no formulário troca todo texto visível da UI, incluindo o que já estava na tela, e a linha de status do próximo worker.

## Fora

- Mensagens de erro do servidor, dos adapters, do `parseConfig`, do console e do `hive.log`.
- Idiomas além de `pt` e `en`; detecção por cabeçalho `Accept-Language` do browser (o Hive é local; o sistema e a config bastam).
- Traduzir o `promptTemplate` padrão (é o que o worker recebe, não interface).
