---
status: draft
feature: telegram-channel
created: 2026-04-25
shipped: null
---
# Telegram Channel — Whis multi-canal com WhatsApp dormente

**Status:** Draft
**Scope:** Adicionar Telegram como canal alternativo ao WhatsApp no Whis, via lib `grammy` em modo long-polling. Manter o `WhatsAppChannel` existente intacto, mas dormente (não-instanciado em runtime, container Evolution + Postgres não sobem) até o Gabriel comprar um chip dedicado e flipar a flag. A composição passa a aceitar uma lista de canais ativos selecionada por flags `TELEGRAM_ENABLED` / `WHATSAPP_ENABLED`. AgentCore, SessionRepo, ClaudeCodeBackend, vault Obsidian — tudo do MVP 0001 segue inalterado.

## Context

A spec 0001 entregou o MVP do Whis com WhatsApp via Evolution API como único canal. Durante o smoke test (Phase 14, registrado em `0001-whis-mvp/smoke-results.md`) o Gabriel descobriu que o chip dedicado planejado estava cancelado pela operadora, o que forçou um patch single-number (commit `86286d3`) usando o próprio número principal do Gabriel via "Mensagem enviada a mim mesmo". Funcionou, mas a UX foi pobre — chat consigo mesmo no WhatsApp não é o lugar natural pra um assistente pessoal viver.

Esta spec resolve o problema imediato (Whis precisa de um canal usável **agora**, sem custo de chip novo) e prepara o caminho pra quando o canal WhatsApp dedicado voltar (sem deletar código, sem refator). A solução é adicionar um segundo canal — Telegram, via `grammy` — operando em paralelo conceitualmente, mas com flags por canal que permitem rodar **só Telegram hoje** (default) e flipar pra **ambos** quando o chip vier.

Telegram é a escolha natural porque: (1) `BotFather` permite criar bots gratuitos sem chip dedicado em ~2min, (2) a Bot API é estável e bem documentada (não é unofficial como Baileys), (3) `grammy` é a lib TypeScript-first padrão de fato em 2026 com types de primeira categoria, e (4) suporta reactions de mensagem nativas via `setMessageReaction` (Bot API 7.0+, jan/2024) — paridade com a UX 👀 que o Whis já entrega no WhatsApp.

**Decisões fundantes confirmadas no brainstorming (2026-04-25):**

- **Lib:** `grammy` (TypeScript-first, types nativos, comunidade ativa). Outras opções (`telegraf`, `node-telegram-bot-api`) descartadas — grammy é o padrão atual.
- **Transport:** long-polling (zero infra pública necessária; Telegram aceita longa idle conn HTTPS de saída). Webhook fica como refator de ~30min se um dia latência/escala horizontal demandar — não cria dívida técnica.
- **Run mode:** flags por canal, não exclusividade. `TELEGRAM_ENABLED=true` (default) e `WHATSAPP_ENABLED=false` (default) determinam quais sobem em runtime; o código de ambos coexiste no repo. Compose usa profiles (`whatsapp`) pra que os containers Evolution+Postgres só subam quando `--profile whatsapp` for passado.
- **Reactions:** implementadas. `setMessageReaction` cobre o `react('eyes')` 👀 entrar/sair durante processamento — paridade visual completa com WhatsApp.
- **Format:** novo `channels/telegram/format.ts` independente, com escape MarkdownV2 (mais agressivo que o WhatsApp markdown). Stage-based com placeholders ASCII, mesmo padrão do `whatsapp/format.ts` que já existe.
- **Sessões isoladas por canal:** `SessionRepo` indexa por `chatId`. Keyspaces distintos por construção — WhatsApp usa `<jid>@s.whatsapp.net`, Telegram usa `tg:<chat_id>`. Conversa no Telegram não compartilha contexto curto com conversa no WhatsApp; memória durável (vault Obsidian) é compartilhada por desenho.
- **Identidade compartilhada:** mesmo `agent/SOUL.md` e `profile/USER.md`. Whis tem uma personalidade única, expressa em qualquer canal.

## Problem Statement

O Whis hoje só funciona via WhatsApp Web (Evolution + Baileys), que tem três limitações que ficaram visíveis no smoke do MVP:

1. **Exige chip dedicado pra UX boa.** Single-number mode funciona tecnicamente, mas conversar consigo mesmo no WhatsApp é estranho — não tem indicador visual de "este é o assistente", a entrada é entre outras mensagens autoenviadas, e qualquer feature futura de leitura de histórico vai entrelaçar conversas reais com diálogo do agente.
2. **Stack frágil.** Evolution v2 tem bug aberto há 8 meses (`stream:error code 515`, umbrella issue #2437) e exige um workaround instável (env `CONFIG_SESSION_PHONE_VERSION` que precisa ser atualizada manualmente quando o WhatsApp muda protocolo). Baileys é unofficial e pode banir conta a qualquer momento.
3. **Custo operacional permanente.** Mesmo com o agente parado, Evolution + Postgres consomem ~250-350MB RAM e geram ruído de log. Pra um agente pessoal que pode passar dias sem uso intenso, é desperdício.

Telegram resolve os três:
1. **Bot é entidade separada do usuário.** Whis é `@whis_bot` no chat list — claramente "o agente". Conversar com ele não polui chats reais.
2. **Bot API oficial.** Estável, documentada, sem proteção anti-spam que precise de workarounds. Sem risco de ban (uso normal).
3. **Polling é leve.** Worker mantém uma conexão HTTPS idle long-poll. RAM pequena, sem container extra.

A spec resolve essa lacuna **adicionando** o Telegram como caminho preferencial atual, **sem remover** o WhatsApp — o código do `WhatsAppChannel` permanece exercitado pelos tests existentes e pode ser reativado em uma flag flip + `pnpm run docker:up --profile whatsapp` quando o Gabriel adquirir chip dedicado.

## Non-Goals

Explicitamente **fora do escopo** desta spec:

1. **Grupos do Telegram.** Apenas DM 1:1 com `chat.type === 'private'`. Mensagens de grupo são ignoradas silenciosamente, paridade com WhatsApp.
2. **Mídias** (áudio, imagem, vídeo, documento, sticker, voice note, location). Apenas `message:text`. Mídia entra em iteração futura quando uma skill demandar.
3. **Inline mode** do Telegram (`@whisbot pergunta` em qualquer chat). Não aplicável pra agente pessoal whitelisted.
4. **Bot commands menu** via `setMyCommands` (`/start`, `/help`, etc). Whis responde a texto livre; não registra comandos formais. O setup helper aceita `/start` apenas pra capturar o chat_id, mas não persiste como comando registrado.
5. **Multi-user no Telegram.** Whitelist single de `TELEGRAM_OWNER_CHAT_ID`. Qualquer outro chat (incluindo grupos com Whis adicionado) é ignorado com log `dm_ignored_non_owner` (paridade WhatsApp).
6. **Webhook do Telegram.** Apenas long-polling. Webhook exigiria URL pública HTTPS — fora do escopo do MVP self-hosted local. Migração pra webhook futuro é refator de ~30min em `TelegramChannel` se necessário.
7. **Telegram Stars / payments / subscriptions.** Não usado.
8. **Voice note transcription** (Whisper inline na mensagem). Futuro.
9. **Migração / unificação de sessões** entre canais. Cada canal mantém sua janela rotativa de 6h por chatId. Conversar do Telegram não dá contexto pra conversa do WhatsApp e vice-versa.
10. **Personality per-canal** (SOUL adaptado por canal). Mesma identidade em ambos.
11. **Idempotência completa de Updates.** Telegram pode reentregar `Update` em retry de rede; risco aceito (uso pessoal individual). Fix planejado pós-spec via `UNIQUE (channel, message_ref)` no `MessageRepo`.
12. **Cron / proactive messaging via Telegram.** Whis só responde, não inicia. Cron entra em spec própria.
13. **HA / múltiplas instâncias do bot.** Telegram só aceita 1 instância polling por bot ativo. Pra agente pessoal single-instance, é suficiente forever.

## Constraints

**Técnicas:**

- `grammy` 2.x (validar versão exata em Task 0 do plan). Dependência runtime nova em `apps/worker/package.json`.
- Bot API 7.0+ exigida pra `setMessageReaction`. BotFather entrega bots já compatíveis com a versão atual.
- Long-polling exige outbound HTTPS pra `api.telegram.org` (port 443). Rede do compose precisa permitir saída — já é o default de Docker.
- Token do bot deve ficar em `profile/.env` (gitignored), nunca commitado.
- `TELEGRAM_OWNER_CHAT_ID` é numérico (int64), descoberto via helper interativo. Validado por zod com `z.coerce.number()`.
- Cada `Bot` do grammy é single-instance por token: rodar 2 workers com mesmo token causa `409 Conflict` em um deles. Aceito (1 instância só).
- TS strict mantido. Tests novos via Vitest, paridade com convenção do repo.

**Organizacionais:**

- Gabriel precisa criar o bot uma vez no `@BotFather` (~2min): `/newbot` → escolhe nome e username único → recebe token. Custo: zero.
- Gabriel precisa rodar `pnpm run telegram:setup` uma vez pra capturar `TELEGRAM_OWNER_CHAT_ID`. UX: helper imprime instrução, espera primeira mensagem, captura, sai. Idempotente.
- Sem SLA — ferramenta pessoal.

**De arquitetura (pra evitar débito imediato):**

- `Channel` interface (`apps/worker/src/channels/types.ts`) não muda. `TelegramChannel` é mais uma implementação ao lado de `WhatsAppChannel`.
- `AgentCore` aceita uma lista de canais via `bind(channels: Channel[])` em vez de canal único. Ele monta um `Map<platform, Channel>` internamente e roteia respostas pelo `IncomingMessage.platform`.
- `apps/worker/src/channels/telegram/` espelha a estrutura de `whatsapp/`: `adapter.ts`, `normalize.ts`, `format.ts`, `*.test.ts`. Sem subpasta `evolution-client.ts` equivalente — `grammy` já encapsula HTTP da Bot API.
- Composição em `index.ts` constrói a lista condicionalmente baseado em `config.telegram.enabled` e `config.whatsapp.enabled`. Boot falha se ambos forem false.
- Compose ganha `profiles: [whatsapp]` em `evolution-api` e `postgres` — quando WhatsApp dormente, `pnpm run docker:up` (sem `--profile whatsapp`) só sobe o `whis-worker`.
- Tests do canal são unit (mock do `Bot` do grammy). Smoke ponta-a-ponta é manual via SMOKE.md atualizado.

**De comunicação:**

- Idioma e tom: idênticos ao WhatsApp (PT-BR padrão, herdado do SOUL.md). Mesma personalidade.
- Format: MarkdownV2 do Telegram (`*bold*`, `_italic_`, `__underline__`, `~strikethrough~`, `` `code` ``, ```` ```block``` ````). Caracteres especiais (`_*[]()~`>#+-=|{}.!`) precisam escape `\` quando não fazem parte de marcação. Implementado em `format.ts` próprio.

## User Stories / Scenarios

**T1 — Setup inicial do bot Telegram (uma vez):**

1. Gabriel abre o Telegram, fala com `@BotFather`, manda `/newbot`, escolhe nome (`Whis`) e username (ex: `whis_gabriel_bot`). BotFather responde com token formato `123456789:ABCdef...`.
2. Gabriel cola `TELEGRAM_BOT_TOKEN=123...` em `profile/.env`.
3. Roda `pnpm run telegram:setup`. Helper imprime: *"Bot pareado: @whis_gabriel_bot. Manda /start ou qualquer mensagem pro teu bot."*
4. Gabriel abre o chat com `@whis_gabriel_bot` no app, manda `/start`. Helper detecta a mensagem, imprime: *"TELEGRAM_OWNER_CHAT_ID=123456789. Cola em profile/.env"*, manda no chat *"Capturado o teu chat_id. Volta pro terminal."*, encerra.
5. Gabriel cola `TELEGRAM_OWNER_CHAT_ID=123456789` em `profile/.env`.
6. `pnpm run docker:up`. Worker boota, `telegram_health_ok` aparece nos logs, `whis_online` em seguida.

**T2 — Caminho feliz (smoke):**

1. Gabriel abre `@whis_gabriel_bot` no Telegram, manda `oi`.
2. grammy entrega o `Update` ao handler do `TelegramChannel`. `normalize.ts` valida (DM, owner, texto), monta `IncomingMessage` com `platform: 'telegram'`.
3. `AgentCore.handleMessage` consulta `SessionRepo` (chave `tg:123456789`), monta system prompt SOUL+USER, chama `ClaudeCodeBackend.query()`.
4. `react('eyes')` — `setMessageReaction` adiciona 👀 na mensagem original. Aparece no chat em ~2s.
5. Claude responde. `WhatsAppChannel` está dormente, então só `TelegramChannel.send(target, text)` executa: `bot.api.sendMessage(chatId, formatted, { parse_mode: 'MarkdownV2' })`.
6. `unreact('eyes')` — `setMessageReaction` com array vazia remove o 👀.
7. `MessageRepo` grava in/out com `correlationId` consistente. `SessionRepo.upsert(chatId, sessionId, now)`.
8. Logs estruturados mostram a sequência completa, todos com `channel: 'telegram'`.

**T3 — Mensagem de número não autorizado:**

1. Outro usuário do Telegram abre `@whis_gabriel_bot` e manda mensagem.
2. grammy entrega o `Update` ao handler.
3. `normalize.ts` checa `chat.id` contra `TELEGRAM_OWNER_CHAT_ID` — não bate.
4. Mensagem descartada com log `dm_ignored_non_owner`. Sem reaction, sem resposta.

**T4 — Modo dual-canal (futuro, quando WhatsApp voltar):**

1. Gabriel compra chip novo, pareia na Evolution.
2. Edita `profile/.env`: `WHATSAPP_ENABLED=true`. Mantém `TELEGRAM_ENABLED=true`.
3. `pnpm run docker:up --profile whatsapp` — Postgres + Evolution + worker sobem.
4. Mensagem do WhatsApp e mensagem do Telegram chegam em paralelo. Cada uma cria/resume sua sessão isolada (`<jid>@s.whatsapp.net` vs `tg:<chat_id>`). Logs filtraveis por `"channel":"whatsapp"` ou `"channel":"telegram"`.

**T5 — Hot-reload do prompt (paridade S7 do MVP):**

1. Gabriel edita `agent/SOUL.md` no host.
2. `ProfileWatcher` (já existe, canal-agnóstico) recompõe `systemPrompt`.
3. Próxima mensagem em qualquer canal usa o prompt atualizado.

**T6 — Token do bot inválido / revogado:**

1. Gabriel revogou o token via BotFather (acidente).
2. `getMe()` no boot retorna 401. `telegram_health_failed` é logado.
3. Worker continua subindo (não-fatal), mas `bot.start()` vai retentar e falhar. Whis fica acessível só pelo WhatsApp se também ativo, ou totalmente offline se Telegram era único.
4. Gabriel pega novo token no BotFather, cola em `profile/.env`, `pnpm run docker:up -d --force-recreate`.

## Success Criteria

Esta entrega está **pronta** quando todos os seguintes são observáveis:

1. `pnpm install` adiciona `grammy` à árvore de deps (`@whis/worker` package.json).
2. `pnpm run quality-gate` passa com **70+ tests** (53 atuais + ~17-20 novos). Cobertura nova inclui ao menos:
   - `apps/worker/src/channels/telegram/normalize.test.ts` — fixtures Telegram `Update`: DM válido do owner; `chat.type !== 'private'` (grupo/supergrupo); chat fora da whitelist; tipos não-texto.
   - `apps/worker/src/channels/telegram/format.test.ts` — escape MarkdownV2 (caracteres especiais), `**bold**` → `*bold*`, `*italic*` → `_italic_`, code blocks preservados, mistura.
   - `apps/worker/src/channels/telegram/adapter.test.ts` — `start()` chama `getMe()` antes do polling; `send()` invoca `sendMessage` com `parse_mode: 'MarkdownV2'`; `react`/`unreact` chamam `setMessageReaction`; `stop()` para o polling.
   - `apps/worker/src/agent/core.test.ts` — adicionar tests cobrindo `bind(channels[])` multi-canal + isolamento de sessões entre platforms (mesmo userId teórico em platforms distintas não compartilha sessionId).
   - `apps/worker/src/config.test.ts` — refine condicional: `TELEGRAM_ENABLED=true` sem TOKEN/OWNER falha; ambos canais false falha; ambos true OK; só Telegram OK; só WhatsApp OK.
3. `cp profile/.env.example profile/.env` traz as 3 envs novas: `TELEGRAM_ENABLED`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_CHAT_ID`. Defaults: `TELEGRAM_ENABLED=true`, `WHATSAPP_ENABLED=false`.
4. `pnpm run telegram:setup` (script novo) lê o token, faz `getMe`, espera primeira mensagem do user, imprime `TELEGRAM_OWNER_CHAT_ID=<n>`, encerra. Idempotente — se token vazio falha rápido com mensagem clara.
5. `pnpm run docker:up` (sem `--profile whatsapp`) só sobe `whis-worker`. `evolution-api` e `postgres` ficam parados. `pnpm run docker:logs` mostra `telegram_health_ok` (com username do bot) seguido de `whis_online`.
6. **T2 (caminho feliz Telegram) funciona ponta-a-ponta** em <30s **steady state** (turno seguinte ao primeiro após boot, paridade com a métrica de S1 da spec 0001): `oi` no chat com o bot → 👀 reage → resposta personalizada do `hello-world` em PT-BR mencionando o nome do Gabriel → 👀 sai. **Cold start** (1ª mensagem após `docker:up`) pode levar 45-60s; aceitável.
7. **T3 (não-owner)** funciona — outro usuário escrevendo pro bot é silenciosamente ignorado, log `dm_ignored_non_owner` aparece com `channel: 'telegram'`.
8. **T6 (token revogado)** loga `telegram_health_failed` no boot. Worker continua subindo se WhatsApp também estiver ativo; se Telegram for único, fica em retry loop com warns claros.
9. Logs JSON estruturados ganham campo `channel` em todos os events do AgentCore (`message_received`, `session_*`, `backend_*`, `response_sent`, `handler_failed`).
10. Endpoint `/health` retorna estado por canal: `{ "channels": { "telegram": { "enabled": true, "ping": true }, "whatsapp": { "enabled": false } } }`.
11. `pnpm run docker:up --profile whatsapp` (com flag) sobe os 3 containers (worker + evolution + postgres). T4 (dual ativo) é observável via 2 sequências de log paralelas com `channel` distinto.
12. Sessões isoladas: dois `chatId` diferentes (Telegram e WhatsApp) NÃO compartilham `sessionId` no `SessionRepo`. Validado por test em `agent/core.test.ts`.
13. `format.ts` do Telegram gera MarkdownV2 com escape correto pra todos os caracteres especiais. Validado por test cobrindo casos típicos (pontuação, code blocks, mistura).
14. `AGENTS.md` e `SMOKE.md` atualizados com seção "Setup Telegram" e troubleshooting Telegram-específico.
15. `profile/.env`, `profile/USER.md`, `profile/mcp.json`, e `context/` permanecem no `.gitignore` (sem regressão de segurança).

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| `grammy` 2.x recente pode ter mudanças incompatíveis com a documentação que verifiquei. | Discovery (Task 0 do plan) valida versão exata + minimal example funcionando antes do código. |
| Token do bot vazado expõe o bot pro mundo (qualquer um pode chamá-lo). | Whitelist `TELEGRAM_OWNER_CHAT_ID` rejeita tudo que não é o owner. Mesmo se o token vazar, atacante não consegue acionar Whis (chat_id dele não bate). Token segue gitignored em `profile/.env`. |
| `setMessageReaction` foi adicionado em Bot API 7.0 (jan/2024). Bots criados antes podem ter cache da versão antiga? | Não. A API é por endpoint, não versionada por bot. Bots criados em 2026-04 têm acesso pleno. |
| Long-polling fica suscetível a timeouts/blips de rede. | `grammy` retenta automaticamente. `bot.catch()` pega erros não-recuperáveis e loga. Em uso pessoal individual, blips raros são aceitáveis. |
| Migração pra webhook no futuro pode exigir reescrita maior do que estimei. | Escopo do refator está confinado a `TelegramChannel.start()` + uma rota nova em `webhook/server.ts` + 1 env opcional. Risco real baixo. |
| Mesmo `chatId` em platforms diferentes (improvável mas possível: Telegram chat_id `5511999999999` colidindo com WhatsApp `5511999999999@s.whatsapp.net`) cria ambiguidade. | Keyspace prefixed `tg:` para Telegram garante separação. WhatsApp keep `<jid>` literal. |
| Discovery script (`pnpm run telegram:setup`) é interativo — usuário esquece de mandar mensagem e o script trava. | Timeout de 5min no helper; após isso imprime erro e encerra. Documentado em SMOKE.md. |
| Erro "409 Conflict" se duas instâncias do worker tentarem polling com mesmo token. | Documentado em troubleshooting. Solução: garantir 1 worker por token. Pra setup pessoal, é o caso já. |

## Open Questions

Nenhuma bloqueante. Todas as decisões arquiteturais foram resolvidas no brainstorming de 2026-04-25 (lib, transport, flags, reactions, format, sessões).

Itens menores resolvíveis na implementação (Task 0 do plan):

- Versão exata de `grammy` a pinar — verificar npm latest, validar compat com Node 24 + ESM strict.
- Confirmar shape do `Update` payload em fixtures reais — `chat.type` enum (`'private' | 'group' | 'supergroup' | 'channel'`), shape do `from`, etc. Fixar em `normalize.test.ts`.
- Confirmar comportamento de `bot.start()` no grammy: bloqueante ou retorna Promise? `grammy` 1.x era bloqueante; 2.x pode ter mudado. Validar antes de wirar em `index.ts`.
