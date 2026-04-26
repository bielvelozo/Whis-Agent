---
status: draft
feature: scheduled-messages
created: 2026-04-26
shipped: null
---
# Skill `scheduled-messages` — Whis com lembretes e mensagens agendadas

**Status:** Draft
**Scope:** Adicionar a segunda skill funcional do Whis: agendar mensagens proativas pro Gabriel via Telegram. Cobre dois casos canônicos — (1) **recorrente dinâmico** *"todo dia 8h me manda bom dia + meus compromissos do dia"* e (2) **one-shot literal** *"amanhã 10h me lembra de comprar pão"* — mais captura por anotação livre *"lembrar de ir lavar o carro segunda"* sem o user dizer "agenda". Storage próprio em SQLite (separado do Google Calendar). Engine de disparo é loop tick interno do worker (60s, DB-driven, idempotente). Tools expostas via in-process MCP server (sem subprocess), aproveitando o slot `inProcessMcpServers` já cabeado no `ClaudeCodeBackend`. Operações v1: criar, listar, cancelar, editar, pausar/reativar — todas writes seguem o protocolo absoluto de confirmação humana.

## Context

A spec 0001 entregou o pipeline base do Whis. A spec 0002 entregou o canal Telegram. A spec 0003 entregou a primeira skill funcional (`google-calendar`) — Whis virou interlocutor da agenda formal do Gabriel. Agora chega a hora da **segunda skill de produtividade**: lembretes e mensagens proativas. Isso fecha um gap fundamental: hoje o Whis só fala quando recebe mensagem; com `scheduled-messages` ele passa a iniciar conversa em momentos pré-combinados.

Os dois casos canônicos cobrem extremos diferentes:

- *"todo dia 8h me manda bom dia + meus compromissos do dia"* — conteúdo **dinâmico** (a agenda muda todo dia), recorrente, requer LLM no horário do disparo pra consultar Calendar e formatar.
- *"amanhã 10h me lembra de comprar pão"* — conteúdo **fixo conhecido na criação**, one-shot, basta gravar texto literal e enviar no horário sem custo de LLM.

A escolha de design refletiu isso com **modo híbrido `kind: 'literal' | 'agent'`** — gravamos qual modo na linha; o dispatcher executa caminho diferente pra cada. Literal manda texto cru via `channel.send()` (zero LLM, custo zero por trigger). Agent fabrica `IncomingMessage` sintético com `[scheduled_trigger]` no contexto e roda o turno completo via `core.bind()`, com continuidade de sessão — Gabriel responde "ah, e cancela a 1x1" e a conversa segue natural.

A escolha de **engine in-process com loop tick a cada 60s** (em vez de `node-cron` registrando jobs em memória) elimina a divergência possível entre estado in-memory e DB. Single source of truth = SQLite. Granularidade de 60s é mais que suficiente pra uso pessoal de bem-estar/produtividade.

A escolha de **storage separado do Google Calendar** é uma decisão de fronteira: Calendar é pra eventos formais (reuniões, freebusy, compromissos com pessoas); `scheduled-messages` é pro lembrete pessoal leve que não precisa virar evento na agenda. O agente decide qual usar baseado nos sinais do enunciado, e a skill `google-calendar` ganha uma nota explícita de "quando NÃO usar" pra evitar roteamento errado.

**Decisões fundantes confirmadas no brainstorming (2026-04-26):**

- **Modo de disparo híbrido (`kind: 'literal' | 'agent'`)** — Whis decide na criação baseado em "o conteúdo depende de dados que mudam?". Literal: texto cru no DB, enviado direto. Agent: prompt sintético no DB, roda LLM no horário com `core.bind()` + flag synthetic.
- **Storage SQLite próprio** em nova tabela `scheduled_messages` — separação dura de Google Calendar.
- **Resolução de horário ambíguo via heurística de classe** — *"lavar o carro segunda"* sem horário → Whis classifica ("tarefa do dia") → escolhe default (9h) → tudo passa pelo "confirma?" antes de gravar.
- **Operações v1: criar + listar + cancelar + editar + pausar/reativar.** Sem snooze pós-disparo (exigia correlação temporal com mensagens recebidas — fora do escopo).
- **Catch-up só pra one-shots dentro de janela de 24h.** Recorrentes atrasadas: dispatcher recalcula `next_fire_at` pra próxima ocorrência futura, sem disparar retroativo. One-shots fora da janela: descarte silencioso com log.
- **Engine A2 (loop tick 60s, DB-driven)** — `setInterval(tick, 60_000)` no worker. Cada tick faz `SELECT WHERE next_fire_at <= now AND paused = 0`. Sem `node-cron`. Cron strings ainda são usadas como **formato de armazenamento** pra recorrência (parsed via `cron-parser` lib).
- **Trigger model B1 (reusa `core.bind`)** — modo agent fabrica `IncomingMessage` sintético com `userId='system:scheduler'` e flag `scheduledTrigger` no wrapper de contexto. Continuidade conversacional preservada.
- **Tools via `inProcessMcpServers`** — slot já cabeado no `ClaudeCodeBackend` (comentário "e.g. cron tools" no código existente). Tools criadas via `createSdkMcpServer` do Claude Agent SDK rodam in-process, com acesso direto ao `ScheduledMessageRepo` por closure. Sem subprocess, sem SQLite duplo.
- **Confirmação enforced via SKILL.md + nova regra absoluta no SOUL.md** — paralela à regra do Calendar (commit `32d2c92`). Reads (`schedule_list`) executam direto. Todas as outras (`create`/`edit`/`cancel`/`pause`/`resume`) seguem protocolo de 3 passos: resumo → "confirma?" → executa → confirma sucesso com `id`.
- **Time parsing acontece no LLM, não no worker.** Worker só recebe formato canônico (ISO 8601 absoluto pra one-shot, cron 5-field string pra recorrente). LLM converte "amanhã 10h" / "todo dia 8h" usando o `current_time` injetado pelo wrapper de contexto.

## Problem Statement

Hoje o Whis só fala quando o Gabriel fala primeiro. Isso impede dois usos óbvios e diários:

1. **Bom-dia + agenda do dia.** Gabriel quer abrir o Telegram às 8:01 e já ter a mensagem do Whis com os compromissos do dia. Hoje precisaria pedir manualmente todo dia.
2. **Lembretes pessoais leves.** Anotar *"lembrar de lavar o carro segunda"* num momento aleatório e ter o Whis lembrando no dia certo, sem precisar ele mesmo virar um app de tarefas.

A spec resolve esse problema entregando:

- **Mensagens proativas no Telegram** disparadas em horários pré-combinados (one-shot ou recorrentes).
- **Captura natural do intent de agendamento** — Gabriel diz *"lembrar de X segunda"* e o Whis percebe sozinho que isso é pedido de scheduling, propõe agendamento com horário inferido por heurística, pede confirmação, grava.
- **Edição/cancelamento conversacional** — *"cancela o lembrete do carro"* / *"muda o bom-dia pra 7h"* / *"pausa o bom-dia essa semana"*.
- **Continuidade conversacional após disparo agent** — quando o Whis manda o bom-dia + agenda às 8h, Gabriel pode responder *"e cancela a 1x1 com Marcos"* e a conversa segue natural na mesma sessão Claude.

A skill **não automatiza decisões** — todo schedule é criado/editado/cancelado por pedido explícito do Gabriel, com confirmação humana antes de qualquer write. É um agente que **guarda intenções temporais** e dispara no horário, não um app de produtividade autônoma.

## Non-Goals

Explicitamente **fora do escopo** desta spec:

1. **Snooze pós-disparo** ("adia 30min" como resposta ao lembrete que acabou de chegar). Exige correlação temporal entre mensagem recebida e dispatch recente, e o `TelegramChannel` hoje não tem `waitForReaction` real (`adapter.ts:127` retorna sempre `null`). v2.
2. **Editar conteúdo do payload via texto livre.** v1 edit aceita `title`, `when`, `payload` como campos discretos — Whis re-monta payload do zero. v2: diff inteligente.
3. **Múltiplos destinatários.** v1 sempre dispara pro `TELEGRAM_OWNER_CHAT_ID`. Sem `chat_id` de terceiros. v2 abre quando WhatsApp dual-canal voltar.
4. **Lembretes que viram eventos no Calendar.** Decisão arquitetural — `scheduled-messages` e `google-calendar` têm storages disjuntos. Cross-channel sincronia (lembrete → evento, evento → lembrete) é v3+.
5. **Catch-up retroativo de recorrentes.** Bom-dia perdido por container down não dispara retroativo. Decisão #5 do brainstorming.
6. **Catch-up de one-shots > 24h atrasadas.** Descarte silencioso com log. Mesma decisão.
7. **Snooze automático em caso de erro de LLM** (rate-limit, token expirado) na hora do disparo agent. Loga `scheduled_dispatch_failed`, recorrente tenta na próxima ocorrência, one-shot perde-se. Sem retry pra evitar tsunami de mensagens.
8. **Notificação push fora do Telegram.** Whis fala só pelos canais ativos.
9. **Agendamento por voz/áudio.** v1 só texto (Telegram channel já é só texto).
10. **UI/dashboard pra ver/editar agendamentos.** Tudo via chat — listar é uma mensagem MarkdownV2.
11. **Backup/export dos agendamentos** pra fora do SQLite. Volume Docker `whis_data` já persiste `whis.db`; restore é via cópia do volume.
12. **Lembretes condicionais** ("me lembra se chover sábado", "se eu não tiver feito X até quinta"). Fora — exigiria integração com APIs externas e estado.
13. **Anexos/links no payload literal além de texto plano.** v1 só texto MarkdownV2 escapado. v2: imagens, áudio.
14. **Suporte a WhatsApp na v1.** WhatsApp segue dormente (spec 0002). Skill funciona em qualquer canal ativo via `chat_id` na linha; validação manual desta spec é via Telegram. Quando WhatsApp voltar, skill já estará pronta.

## Constraints

**Técnicas:**

- Node ≥18 (já é Node 24 no container).
- TypeScript strict + Vitest mantidos. Quality gate (`pnpm run quality-gate`) precisa continuar verde.
- SQLite via `better-sqlite3` — single-process, single-connection (constraint atual do worker).
- Lib `cron-parser` (~50KB, sem deps nativas) pra parsing/computação de `next_fire_at` em cron strings. Validar peso e API na Task 0 do plan.
- `setInterval` a cada 60s — drift aceito de até ±2s (suficiente pra contexto de uso pessoal).
- In-process MCP server registrado via `createSdkMcpServer` do `@anthropic-ai/claude-agent-sdk`. API já usada pelo `ClaudeCodeBackend` no slot `inProcessMcpServers` (atualmente vazio).
- Wrapper de contexto Telegram (`core.ts:wrapWithTelegramContext`) ganha campo opcional `scheduled_trigger: { id, title }` no header — agente percebe que é disparo automático.
- Migration `002_scheduled_messages` é additive only — sem touch em tabelas `sessions` ou `messages`.

**Organizacionais:**

- Single user (Gabriel). Sem concorrência multi-user. Sem locks distribuídos.
- Sem SLA — ferramenta pessoal. Disparo perdido por <60s drift é aceitável; perdido por container down >24h é descarte silencioso (log).

**De arquitetura (pra evitar débito imediato):**

- **Tabela própria `scheduled_messages`.** Sem reuso de `messages` ou `sessions`. Storage físico isolado da Google Calendar.
- **Worker é single-process; dispatcher e tools rodam no mesmo Node process com acesso direto ao repo via closure.** Sem IPC, sem subprocess, sem SQLite duplo.
- **`ScheduledDispatcher` é instanciado em `index.ts`, `start()` rodado no boot APÓS canais subirem, `stop()` no shutdown handler existente.** Sem mudança no fluxo de boot atual; só mais 1 componente.
- **Modo agent reusa `core.bind()` via novo método `dispatchSynthetic(msg)`** — não duplica a lógica de session resume / error handling / wrapping. Diferenças mínimas: pula `react`/`unreact` (sem `messageRef` real); injeta flag `scheduled_trigger` no wrapper.
- **Skill é puramente markdown** em `agent/skills/scheduled-messages/SKILL.md`. Comportamento de classificação (literal vs agent), heurística de horário (tarefa do dia → 9h, etc), e protocolo de confirmação vivem todos no markdown. **Nenhuma regra de negócio dura no TS.**
- **`SOUL.md` ganha 1 linha nova** — paridade com a regra do Calendar.
- **Skill `google-calendar` ganha nota de "quando NÃO usar"** apontando pra `scheduled-messages` — evita roteamento errado pra eventos pessoais leves.

**De comunicação:**

- Idioma: PT-BR (herdado do SOUL).
- Formato de listagem: MarkdownV2 do Telegram. Agrupamento por status (ativos/pausados) e ordenação por `next_fire_at` ascendente.
- Tom: igual ao SOUL — calmo, direto, irônico leve. Confirmações curtas: *"Vou agendar **X** terça 09:00. Confirma?"*.
- Prefixo de catch-up em modo literal: *"(atrasado, era HH:MM) "*. Em modo agent: contexto incluído no prompt sintético, deixa o LLM decidir como verbalizar.

## User Stories / Scenarios

**SM1 — Criar lembrete literal one-shot:**

1. Gabriel: *"me lembra de comprar pão amanhã"*
2. Whis classifica: conteúdo fixo → `kind: 'literal'`. Sem horário explícito → heurística "tarefa do dia" → 9h.
3. Whis monta resumo: *"Vou criar lembrete **comprar pão** pra amanhã (sáb 27/04) às 09:00. Confirma?"*
4. Gabriel: *"sim"*
5. Whis chama `schedule_create` com `kind: 'literal'`, `payload: 'comprar pão'`, `when: '2026-04-27T09:00:00-03:00'`.
6. Whis confirma: *"Pronto. Agendado #5."*
7. Sábado 09:00: container ativo → tick às 09:00 vê linha due → `channel.send(target, "comprar pão")`. DELETE row.

**SM2 — Criar agendamento agent one-shot:**

1. Gabriel: *"amanhã 9h me manda um resumo da minha agenda do dia"*
2. Whis classifica: depende de dados que mudam (agenda) → `kind: 'agent'`. Horário explícito → 9h.
3. Whis monta payload sintético: *"é 9h da manhã. Liste os compromissos do Gabriel hoje (use a skill google-calendar) e formate em MarkdownV2 padrão."*
4. Whis monta resumo + confirma + cria.
5. Sábado 09:00: tick dispara → `dispatchSynthetic(msg)` → backend roda → Whis chama `list-events` (Google Calendar) → formata → envia.
6. Gabriel pode responder na thread (*"e cancela a primeira"*) e a conversa segue na sessão Claude resumida.

**SM3 — Criar agendamento agent recorrente:**

1. Gabriel: *"todo dia 8h: bom dia + agenda do dia"*
2. Whis classifica: `kind: 'agent'`, recorrente → cron `0 8 * * *`.
3. Resumo + confirma + cria com `recurrence: '0 8 * * *'`.
4. Cada 08:00: dispatcher dispara, recalcula `next_fire_at` pra +24h.

**SM4 — Captura por anotação livre (sem dizer "agenda"):**

1. Gabriel: *"lembrar de ir lavar o carro segunda"*
2. Whis percebe a intenção temporal embutida ("lembrar... segunda"). Classifica `kind: 'literal'`, payload `lavar o carro`. Sem horário → heurística "tarefa do dia" → 9h. Resolve "segunda" → próxima segunda.
3. Whis: *"Quer que eu te lembre disso? Vou criar lembrete **lavar o carro** segunda (29/04) às 09:00. Confirma?"*
4. Gabriel: *"sim, mas 7h"*
5. Whis re-monta: *"Lembrete **lavar o carro** segunda (29/04) às 07:00. Confirma?"*
6. *"sim"* → grava.

**SM5 — Listar e cancelar:**

1. Gabriel: *"que lembretes eu tenho?"*
2. Whis chama `schedule_list` (default `filter: 'active'`).
3. Resposta MarkdownV2:
   ```
   *Lembretes ativos:*
   • #5 sáb 27/04 09:00 — comprar pão _(literal)_
   • #6 seg 29/04 07:00 — lavar o carro _(literal)_
   • #7 todo dia 08:00 — bom dia + agenda _(agent, recorrente)_
   ```
4. Gabriel: *"cancela o do carro"*
5. Whis identifica `#6` por título. Resumo: *"Cancelar lembrete **lavar o carro** seg 29/04 07:00. Confirma?"*
6. *"sim"* → `schedule_cancel(id: 6)` → DELETE.

**SM6 — Editar:**

1. Gabriel: *"muda o bom-dia pra 7h"*
2. Whis identifica `#7`. Resumo: *"Vou mudar **bom dia + agenda** de todo dia 08:00 → todo dia 07:00. Confirma?"*
3. *"sim"* → `schedule_edit(id: 7, fields: { when: '0 7 * * *' })` → atualiza linha + recalcula `next_fire_at`.

**SM7 — Pausar e resumir:**

1. Gabriel: *"pausa o bom-dia essa semana, vou viajar"*
2. Whis: *"Vou pausar o **bom dia + agenda** (recorrente todo dia 07:00). Confirma?"* — sem prazo de retomada (v1 não tem TTL de pausa, é manual).
3. *"sim"* → `schedule_pause(id: 7)` → flag `paused=1`.
4. Dispatcher ignora linhas `paused=1`. Bom-dia não dispara.
5. Semana seguinte: Gabriel: *"reativa o bom-dia"* → Whis: *"Vou reativar **bom dia + agenda** (volta a disparar todo dia 07:00). Confirma?"* → *"sim"* → `schedule_resume(id: 7)` → `paused=0`, recalcula `next_fire_at` pra próxima ocorrência válida.

**SM8 — Catch-up de one-shot atrasado <24h:**

1. Gabriel cria lembrete pra daqui 5min: *"me lembra de ligar pra dentista daqui 5min"*.
2. Container cai 1min antes do disparo (host reboot, OOM, etc).
3. Container volta 10min depois. Boot do dispatcher detecta linha `next_fire_at` no passado, `last_fired_at IS NULL`, idade <24h.
4. Catch-up imediato: `channel.send(target, "(atrasado, era HH:MM) ligar pra dentista")`. DELETE row.
5. Log estruturado: `scheduler_boot_recovered { oneshot_caught_up: 1, ... }`.

**SM9 — Recorrente atrasada na boot:**

1. Container down das 07:30 às 09:00. `Bom dia + agenda` (recorrente `0 8 * * *`) deveria disparar 08:00.
2. Boot 09:00 detecta linha recorrente com `next_fire_at` no passado.
3. Recalcula `next_fire_at` pra amanhã 08:00. **Não dispara** retroativo. Log `scheduled_recurrent_skipped { id, was_due_at, next_fire_at }`.

## Success Criteria

A entrega tá **pronta** quando:

1. **Migration `002_scheduled_messages`** rodada na boot do worker, schema bate com a Seção 2 do design (id/chat_id/title/kind/payload/recurrence/timezone/next_fire_at/last_fired_at/paused/created_at/created_correlation_id + índice em `(next_fire_at, paused)`).
2. **`ScheduledMessageRepo`** exportado de `@whis/storage`. Operações: `insert`, `findDue(now)`, `findById(id)`, `findByTitle(query)`, `list(filter, limit)`, `markFired(id, now, nextFireAt)`, `delete(id)`, `pause(id)`, `resume(id)`, `update(id, fields)`. 100% cobertas em `scheduled-message-repo.test.ts` (~15 cases).
3. **`ScheduledDispatcher`** instanciado em `apps/worker/src/index.ts`, `start()` no boot após canais subirem, `stop()` no shutdown handler. Boot logica catch-up implementada (recorrentes atrasadas recalculam sem disparar; one-shots <24h disparam com prefixo "(atrasado)"; one-shots >24h descartam com log).
4. **In-process MCP server `scheduled-messages`** registrado em `ClaudeCodeBackend` via `inProcessMcpServers`. 6 tools expostas (schedule_list/create/edit/cancel/pause/resume) com schemas Zod e validação de input (cron malformado, when no passado, id inexistente → erro estruturado).
5. **`AgentCore.dispatchSynthetic(msg)`** novo método. Pula `react`/`unreact`, mas mantém todo o resto do fluxo (session resume, backend.query, channel.send, error translate). +5 cases em `core.test.ts`.
6. **Wrapper `wrapWithTelegramContext`** ganha campo opcional `scheduled_trigger: { id, title }` no header. Testado em `core.test.ts`.
7. **`agent/skills/scheduled-messages/SKILL.md`** criado com seções 1-8 da Seção 4 do design (quando usar, tools, protocolo, heurística de classe, modo literal vs agent, padrões S1-S8 few-shot, comportamento em scheduled_trigger, coisas que NÃO devo fazer). ~150 linhas.
8. **`agent/SOUL.md`** ganha 1 regra absoluta nova na seção "Regras absolutas de segurança", paralela à do Calendar.
9. **`agent/skills/google-calendar/SKILL.md`** ganha 1 nota nova de "Quando NÃO usar" apontando pra `scheduled-messages` (evita roteamento errado).
10. **`pnpm run quality-gate`** verde — ~50 novos tests passando, zero regressão nos 91 atuais. Total ~140.
11. **`SMOKE.md`** ganha seção "Smoke `scheduled-messages`" com checklist SM1–SM9 marcáveis.
12. **SM1–SM9 todos manualmente validados** — checklist marcado em SMOKE.md, evidência opcional via screenshots na PR.
13. **`AGENTS.md`** atualizado: tabela "Locais de conhecimento" referencia spec 0004.
14. **Logs estruturados de operação** aparecem corretamente em `pnpm run docker:logs:local` durante SM1–SM9: `scheduler_boot_recovered`, `scheduled_dispatched_literal`, `scheduled_dispatched_agent`, `scheduled_dispatch_failed`, `scheduler_tick` (debug), `scheduled_recurrent_skipped`, `scheduled_dropped_stale`.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Modo agent dispara loop infinito (Whis cria scheduled que cria scheduled, recursivamente). | Tool `schedule_create` rejeita se `userId === 'system:scheduler'` no contexto da chamada. Só humano cria. Validado em `tools.test.ts`. |
| Cron malformado vindo do LLM (ex: `0 25 * * *`). | `cron-parser` valida no `schedule_create`; tool retorna erro estruturado, Whis traduz pro user. |
| Worker entra em loop de erro — tick falha a cada 60s e enche o log. | `dispatch()` faz `try/catch` por entry, isolado. Falha de uma linha não derruba o tick nem afeta as outras. |
| Drift de relógio do container (especialmente em hosts sem NTP rigoroso). | Docker host sincroniza NTP por default. Drift de ±2s por tick é aceitável pra contexto pessoal. Nenhum mecanismo de compensação na v1. |
| Lembrete agent falha (Claude rate-limit / token expired) na hora do disparo. | Loga `scheduled_dispatch_failed { id, err }`. Recorrente tenta na próxima ocorrência. One-shot perde-se silenciosamente — log é evidência suficiente pra debug em uso pessoal. **Sem retry** pra evitar tsunami se Claude estiver indisponível por horas. |
| Migration roda em DB existente em prod com dados — quebra. | Migration é idempotente (`CREATE TABLE` em tabela nova). Sem touch em tabelas existentes. Versionamento via `schema_version` já implementado. |
| Whis "esquece" de pedir confirmação antes de write (LLM falha de aderência). | Regra absoluta em `SOUL.md` (mesmo nível das `rm -rf`). SKILL.md tem 8 padrões few-shot do protocolo. Risco residual aceito — uso pessoal individual; se acontecer, é bug de prompt e ajustamos SKILL.md. |
| Volume `whis_data` corrompe / é deletado — todos os agendamentos somem. | Mesmo risco que `messages` e `sessions` hoje. Sem mitigação dedicada na v1. Backup do volume é responsabilidade do user (ferramenta pessoal). |
| Timezone DST — Brasil hoje sem horário de verão, mas se voltar. | `cron-parser` aceita campo `tz` na configuração; armazenamos `timezone` por linha. Já futuro-prova. |
| Dispatcher não para gracefully — tick em curso quando shutdown chama `stop()`. | `stop()` aguarda tick em curso (await na promise interna) com timeout de 5s. Sem flush de pendências (DB é fonte da verdade). |
| Telegram MarkdownV2 escape em payload literal contendo caracteres reservados (`*`, `_`, `[`, etc). | `dispatcher.dispatch` em modo literal passa pelo `toTelegramMarkdownV2` helper existente no `format.ts`. Cobertura em `dispatcher.test.ts`. |
| Concorrência: dois ticks sobrepuserem (não deveria — single-thread Node, mas se setInterval atrasar drasticamente). | `last_fired_at` checagem evita re-disparo da mesma linha no mesmo segundo. Sem locks distribuídos — single-process basta. |
| LLM cria payload agent muito longo / verboso (ex: 5KB de instrução). | Aceito na v1. Agent SDK aguenta. SKILL.md instrui a manter prompts concisos. |
| User pede edit em recorrente que altera `recurrence` — `next_fire_at` precisa ser recalculado, e a transação pode dar erro parcial. | `update()` no repo é transação atômica: ou atualiza tudo (incluindo `next_fire_at` recalculado) ou nada. Testado em `scheduled-message-repo.test.ts`. |

## Open Questions

Nenhuma bloqueante. Todas as decisões core resolvidas no brainstorming 2026-04-26.

Itens menores resolvíveis na implementação (Task 0 do plan):

- **Lib de cron parsing.** `cron-parser` é o default proposto (~50KB, sem deps nativas, mantida). Validar peso final, API e suporte a timezone na primeira task do plan. Alternativa: `croner` (lib mais nova, escrita em TS).
- **Formato exato do `payload_preview`** em `schedule_list`: cortar em quantos chars? Pra `kind: 'agent'`, mostrar payload cru ou hint legível? Decidir na implementação.
- **Telegram MarkdownV2 escape no payload literal.** Reusar `toTelegramMarkdownV2` do `format.ts` ou aceitar payload já escapado pelo LLM? Default proposto: escapar no dispatcher (defensivo). Confirmar na implementação.
- **Hook `onCronsChanged` do `ProfileWatcher` (existente, atualmente no-op).** Esta spec NÃO usa esse hook (agendamentos vivem em SQLite, não em arquivo de profile). O hook permanece no-op. Avaliar deletar em refactor futuro (fora do escopo desta spec).
- **Comportamento em sessão Claude expirada quando dispara modo agent.** `core.bind` já tem retry com `resumeSessionId: undefined` (linha 108-130 do `core.ts`). `dispatchSynthetic` herda esse comportamento por reuso. Validar no SM3.
