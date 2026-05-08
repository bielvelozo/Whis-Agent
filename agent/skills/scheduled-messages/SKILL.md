---
name: scheduled-messages
description: Use quando o Gabriel pedir lembretes, agendamentos de mensagens proativas, "me lembra de X", "todo dia faz Y", "amanhã às 10h manda Z", ou anotar tarefas com prazo embutido ("preciso lavar o carro segunda"). Storage próprio do Whis — NÃO confundir com Google Calendar (eventos formais).
---

# Scheduled Messages

Skill que dá ao Whis a capacidade de agendar mensagens proativas pra si mesmo enviar via Telegram. Cobre lembretes one-shot ("amanhã 9h: comprar pão"), agendamentos recorrentes ("todo dia 8h: bom dia + agenda"), e captura por anotação livre ("lembrar de lavar o carro segunda" sem o user dizer "agenda").

Storage **separado** do Google Calendar. Sempre confirma antes de qualquer escrita.

## Quando usar

- Lembretes one-shot: *"me lembra de X amanhã 10h"*, *"daqui 2h me lembra de ligar pro João"*.
- Agendamentos recorrentes: *"todo dia 8h: bom dia + agenda"*, *"toda sexta 18h: resumo da semana"*.
- Captura por anotação livre: *"lembrar de lavar o carro segunda"* — perceba a intenção temporal embutida.
- Listar/cancelar/editar/pausar/reativar agendamentos existentes.

## Quando NÃO usar (use `google-calendar` em vez)

- Reuniões com outras pessoas, freebusy, agenda formal de trabalho.
- Eventos com hora+local definidos que precisam aparecer no app Google Calendar.

**Regra de ouro:** se o "lembrete" envolve outras pessoas ou local físico → Calendar. Se é só o Whis te avisando algo → scheduled-messages.

## Ferramentas disponíveis

**Reads — executa direto, sem confirmar:**
- `schedule_list` — lista agendamentos (filter: 'active'|'paused'|'all', default 'active'; limit default 20)

**Writes — sempre confirme antes:**
- `schedule_create` — cria novo agendamento (one-shot ou recorrente)
- `schedule_edit` — edita campos (title, payload, when, timezone)
- `schedule_cancel` — deleta (sem soft-delete)
- `schedule_pause` — pausa recorrente (não dispara mais)
- `schedule_resume` — reativa pausado

> **⚠️ NUNCA use `CronCreate` / `CronDelete` / `CronList` / `ScheduleWakeup`.** Essas são ferramentas built-in do harness Claude Code (routines remotas na infra Anthropic / sleep do agente) — elas não têm acesso ao Telegram do Whis nem ao banco local, e silenciosamente não fazem nada útil pra agendar lembrete. Sempre use as tools `schedule_*` listadas acima (MCP local). Se elas não aparecerem disponíveis, pare e avise o Gabriel — não improvise com ferramenta de schedule de outro sistema.

## Protocolo de confirmação (OBRIGATÓRIO antes de toda write)

Sempre 3 passos pra `schedule_create`, `schedule_edit`, `schedule_cancel`, `schedule_pause`, `schedule_resume`:

1. **Monte o resumo + envie no chat ANTES de chamar a tool.** Inclua:
   - Título do agendamento
   - Quando (one-shot: "sex 26/04 às 09:00"; recorrente: "todo dia 08:00")
   - Modo (literal: o texto que será enviado; agent: o que o Whis vai fazer no horário)
   - Mudanças relevantes (em edit: o que muda; em cancel: o que deleta)
   - Termina com "Confirma?"

2. **Aguarde resposta do Gabriel.** Se "sim/ok/confirma/manda" → executa. Se "não/cancela" → aborta. Se correção → re-monte resumo e pergunte de novo.

3. **Pós-execução, confirme sucesso** com o `id` do agendamento e próximo disparo.

**Reads NÃO seguem esse protocolo** — `schedule_list` executa direto.

## Modo `literal` vs `agent` — como decidir

**Regra de ouro:** O conteúdo da mensagem depende de dados que mudam com o tempo?

- **NÃO** → `kind: 'literal'`. Texto fixo gravado direto. Sem custo de LLM no horário.
  - Exemplos: *"comprar pão"*, *"lavar o carro"*, *"ligar pra mãe"*.
- **SIM** → `kind: 'agent'`. Prompt sintético gravado; no horário, Whis roda turno completo (pode usar outras skills).
  - Exemplos: *"bom dia + agenda do dia"* (agenda muda), *"resumo do que fiz na semana"* (depende de vault), *"lembra do que ficou pendente"* (estado dinâmico).

Na dúvida, pergunta uma vez ao Gabriel.

## Heurística de classe → horário default

Quando Gabriel pedir lembrete sem horário explícito (ex: *"lembrar de lavar o carro segunda"*), classifique pra escolher horário sensato. Sempre passa pelo "confirma?" — se Gabriel quiser outro, ele corrige na hora.

| Classe                                    | Horário default |
|-------------------------------------------|-----------------|
| Tarefa do dia (lavar, comprar, pagar)     | 09:00           |
| Compromisso pessoal noturno               | 19:00           |
| Bom-dia recorrente                        | 08:00           |
| Boa-noite recorrente                      | 22:00           |
| Genérico sem pista                        | 09:00           |

## Formato do `when` ao chamar `schedule_create`

- **One-shot:** ISO 8601 absoluto com offset Brasil. Ex: `"2026-04-27T09:00:00-03:00"`.
- **Recorrente:** cron 5-field. Ex: `"0 8 * * *"` = todo dia 8h. `"0 22 * * 0"` = todo domingo 22h. `"0 18 * * 5"` = toda sexta 18h.

Whis pode resolver "amanhã" / "segunda" / "todo dia 8h" usando o `current_time` injetado no contexto Telegram. **Sempre passe `timezone: "America/Sao_Paulo"` explícito** (default da tool é esse, mas seja explícito quando claro do enunciado).

## Formato de listagem (Telegram MarkdownV2)

```
*Lembretes ativos:*
• #5 sáb 27/04 09:00 — comprar pão _(literal)_
• #6 seg 29/04 07:00 — lavar o carro _(literal)_
• #7 todo dia 08:00 — bom dia + agenda _(agent, recorrente)_
```

Use `_(paused)_` ao listar com filter='paused' ou 'all'.

## Padrões de uso (S1-S9 da spec)

### S1 — One-shot literal

Gabriel: *"me lembra de comprar pão amanhã"*

1. Classifica: literal (texto fixo). Sem horário → heurística → 9h.
2. Resumo: *"Vou criar lembrete **comprar pão** pra amanhã (sáb 27/04) às 09:00. Confirma?"*
3. Aguarda "sim".
4. `schedule_create({ title: "comprar pão", kind: "literal", payload: "comprar pão", when: "2026-04-27T09:00:00-03:00", correlationId: "<from context>" })`
5. Confirma: *"Pronto. Agendado #5."*

### S2 — One-shot agent

Gabriel: *"amanhã 9h me manda um resumo da minha agenda do dia"*

1. Classifica: agent (depende de Calendar). Horário explícito → 9h.
2. Payload sintético: *"é 9h da manhã. Liste os compromissos do Gabriel hoje (use a skill google-calendar) e formate em MarkdownV2 padrão."*
3. Resumo + confirma + cria.
4. No horário, Whis recebe `[scheduled_trigger]` no contexto, executa, envia.

### S3 — Recorrente agent

Gabriel: *"todo dia 8h: bom dia + agenda"*

1. Classifica: agent, recorrente.
2. Cron: `"0 8 * * *"`.
3. Resumo: *"Vou criar **bom dia + agenda** todo dia às 08:00 (modo agent — eu vou consultar sua agenda no horário). Confirma?"*
4. Confirma + `schedule_create({ kind: "agent", when: "0 8 * * *", payload: "..." })`.

### S4 — Captura por anotação livre

Gabriel: *"lembrar de ir lavar o carro segunda"* (sem dizer "agenda" ou "lembra").

1. Detecta intenção temporal embutida. Classifica literal, payload "lavar o carro". Heurística → 9h. Resolve "segunda".
2. *"Quer que eu te lembre disso? Vou criar lembrete **lavar o carro** segunda (29/04) às 09:00. Confirma?"*
3. Se Gabriel ajustar (ex: "sim mas 7h"), re-monte e pergunte de novo.
4. Confirma → cria.

### S5 — Listar e cancelar

*"que lembretes eu tenho?"* → `schedule_list({})` → formate.

*"cancela o do carro"*:
1. `schedule_list` se necessário, identifica id por título.
2. *"Cancelar lembrete **lavar o carro** seg 29/04 07:00. Confirma?"*
3. Confirma → `schedule_cancel({ id })`.

### S6 — Editar

*"muda o bom-dia pra 7h"*:
1. Identifica id (#7).
2. *"Vou mudar **bom dia + agenda** de todo dia 08:00 → todo dia 07:00. Confirma?"*
3. Confirma → `schedule_edit({ id: 7, fields: { when: "0 7 * * *" } })`.

### S7 — Pausar/Resumir

*"pausa o bom-dia essa semana, vou viajar"*:
1. Identifica id.
2. *"Vou pausar o **bom dia + agenda** (recorrente todo dia 07:00). Confirma?"* — sem TTL automático na v1, é manual.
3. Confirma → `schedule_pause({ id })`.

Pra reativar: *"reativa o bom-dia"* → resumo → confirma → `schedule_resume({ id })`.

### S8 — Catch-up de one-shot atrasada

Tratamento é automático no boot do dispatcher. Whis NÃO precisa fazer nada específico — só receberá a mensagem com prefixo "(atrasado, era HH:MM)" se aplicável.

### S9 — Recorrente atrasada

Tratamento automático: dispatcher recalcula `next_fire_at` pra próxima ocorrência. Whis nunca dispara recorrente atrasada retroativo.

## Quando você foi acordado por um agendamento

Se você ver `scheduled_trigger:` no header `[telegram_context]`, isso significa que **você não foi mensageado pelo Gabriel — você foi acordado por um agendamento que ele criou antes**. Execute o que o `text` (payload) pede e envie a resposta. **NÃO responda "oi" nem "alguma novidade?"**. O Gabriel pode ou não responder; se responder, a conversa segue normal.

## Coisas que NÃO devo fazer

- **Usar `CronCreate`/`CronDelete`/`CronList`/`ScheduleWakeup`** — são built-ins do harness Claude Code, não têm relação com o scheduler do Whis. Use só as `schedule_*` do MCP local.
- Criar agendamento sem confirmação humana (regra absoluta no SOUL).
- Misturar storage com Google Calendar — lembrete pessoal NUNCA vira evento Calendar nem vice-versa.
- Inventar `id` — sempre busque via `schedule_list` antes de chamar `schedule_cancel`/`edit`/`pause`/`resume`.
- Disparar one-shot atrasado mais de 24h sob pedido — o dispatcher já trata, e além disso é decisão do user (decisão #5 da spec).
- Criar agendamento que dispara outro agendamento (loop). A tool `schedule_create` rejeita se chamada por `system:scheduler`, mas evite por design.
