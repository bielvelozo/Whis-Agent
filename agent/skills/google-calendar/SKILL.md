---
name: google-calendar
description: Use quando o Gabriel mencionar agenda, eventos, reuniões, compromissos, "tô livre", "agenda X", "cancela Y", "adia Z", "que horas é", "reunião com [pessoa]", ou similares. Suporta accounts personal e work via inferência semântica.
---

# Google Calendar

Skill que dá ao Whis acesso à agenda Google do Gabriel via MCP server `@cocal/google-calendar-mcp`. Multi-account (`personal` + `work`), timezone Brasil, sempre confirma antes de escrita.

## Quando usar

- Listar eventos: "que reuniões hoje?", "minha agenda da semana", "próxima reunião com X"
- Criar: "agenda almoço com Pedro sex 12h", "cria reunião 1x1 com Marcos quarta 11h"
- Editar/adiar: "adia minha reunião pra próxima", "muda a 1x1 pra 14h"
- Cancelar: "cancela a daily de amanhã", "remove o evento X"
- Disponibilidade: "tô livre amanhã 14h?", "quando tenho horário sexta?"
- Responder convite: "aceita o convite da reunião X", "recusa o evento Y"

## Quando NÃO usar (use `scheduled-messages` em vez disso)

- Lembretes pessoais leves sem hora/local definidos: *"me lembra de comprar pão amanhã"*, *"me lembra de lavar o carro segunda"*. Vai pra `scheduled-messages`.
- Agendamentos de mensagens proativas do Whis: *"todo dia 8h me manda bom dia + agenda"*, *"me dá um resumo da semana toda sexta 18h"*. Vai pra `scheduled-messages`.
- Anotações com prazo embutido sem componente social: *"preciso lembrar de pagar conta de luz quinta"*. Vai pra `scheduled-messages`.

**Regra de ouro:** Calendar = compromisso formal com hora+local+pessoas (real ou implícito como "academia 18h"). `scheduled-messages` = lembrete pessoal interno do Whis pro Gabriel.

## Ferramentas disponíveis (via MCP)

**Reads — executa direto, sem confirmar:**
- `list-calendars` — quais calendários cada account tem
- `list-events` — eventos por range de data
- `search-events` — busca por keyword
- `get-event` — detalhe de 1 evento por ID
- `get-freebusy` — slots livres em range
- `get-current-time` — agora em timezone do calendar

**Writes — sempre confirme antes:**
- `create-event` — novo evento
- `update-event` — edita evento existente
- `delete-event` — remove evento
- `respond-to-event` — accept/decline/tentative em convite

**Auth/admin:**
- `manage-accounts` — adicionar/listar/remover Google accounts conectadas

## Protocolo de confirmação (OBRIGATÓRIO antes de toda write)

Sempre 3 passos pra `create-event`, `update-event`, `delete-event`, `respond-to-event`:

1. **Monte o resumo + envie no chat ANTES de chamar a tool.** Inclua:
   - Título do evento
   - Data + horário (formato: "sex 26/04 das 14:00 às 15:00")
   - Calendar (`personal` ou `work`)
   - Mudanças relevantes (em update: o que muda; em delete: confirma o que deleta)
   - Termina com "Confirma?"

2. **Aguarde resposta do Gabriel.** Se "sim/ok/confirma/manda" → executa. Se "não/cancela" → aborta. Se correção → re-monte resumo e pergunte de novo.

3. **Pós-execução, confirme sucesso** com link do evento (`htmlLink`) ou ID.

**Reads NÃO seguem esse protocolo** — são idempotentes.

## Roteamento de account (`personal` vs `work`)

Inferir do conteúdo da mensagem usando os mesmos sinais que o SOUL.md já distingue:

- **work**: "cliente X", "reunião com [nome] da empresa Y", "1x1", "stand-up", "daily", "review", "retro", "kickoff", contextos profissionais
- **personal**: "médico", "academia", "família", "almoço com [nome]" (sem contexto profissional), "aniversário", "viagem", "compras"
- **Ambíguo** → pergunte antes de tudo: *"vai no calendário pessoal ou trabalho?"*

Quando não tiver certeza, lembre-se: o protocolo de confirmação pré-write já é o catch-all — o Gabriel pode corrigir o roteamento ali.

## Timezone

**Sempre `America/Sao_Paulo` em toda criação/busca.** Passe explícito no payload:

```json
{
  "summary": "Café com José",
  "start": { "dateTime": "2026-04-26T10:00:00", "timeZone": "America/Sao_Paulo" },
  "end": { "dateTime": "2026-04-26T11:00:00", "timeZone": "America/Sao_Paulo" }
}
```

Se precisar saber "agora", chame `get-current-time` (não chute pelo conhecimento do modelo).

## Formato de eventos no Telegram (MarkdownV2)

**Listagem (próximos eventos):**

```
*Próximos eventos hoje:*
• 14:00–15:00 Reunião com Cliente Y _(work)_
• 18:00 Academia _(personal)_
```

**Múltiplos dias:**

```
*Próximos eventos:*

*🗓 Hoje (sex 25/04)*
• 14:00–15:00 Reunião com Cliente Y _(work)_
• 18:00 Academia _(personal)_

*🗓 Sáb 26/04*
• 10:00 Café com José _(personal)_
```

**Detalhe de 1 evento:**

```
*Reunião com Cliente Y*
📅 sex 25/04, 14:00–15:00
📍 Google Meet
👤 work
📝 Discutir proposta atualizada.
```

O `format.ts` do canal já cuida de escape MarkdownV2 — você escreve markdown normal.

## Padrões de uso

### G1 — Setup inicial (auth via chat)

Quando o Gabriel pedir "conecta meu calendário pessoal/trabalho":

1. Chame `manage-accounts` (action `add`, nickname `personal` ou `work`).
2. MCP levanta server local (port 3500-3505) e retorna URL longa de autorização.
3. Responda: *"Abre essa URL JÁ no browser — o auth server tem timeout de 5 minutos e fecha sozinho. Autorize logo:"* + URL.
4. Gabriel autoriza no browser → Google redireciona pro callback local → MCP captura code automaticamente.
5. MCP confirma sucesso na próxima resposta da tool.
6. Confirme no chat: *"Conectado. Posso listar eventos do calendário [personal/work]."*

**IMPORTANTE — timeout de 5 minutos.** O auth server fecha sozinho depois de 5min sem callback. Se o Gabriel demorar (ex: foi tomar café e voltou), a URL fica inválida e o callback dá `ERR_EMPTY_RESPONSE`. Sempre lembre disso na primeira mensagem.

**Sem paste-code.** O MCP usa callback HTTP automático. Garanta que o user abra a URL em browser na **mesma máquina** rodando o container — `localhost:3500-3505` precisa ser alcançável.

### G2 — Listar eventos

Gabriel: *"que reuniões eu tenho hoje?"*
- Chame `list-events` com range = today (00:00 a 23:59 no timezone Brasil), all accounts.
- Formate em MarkdownV2 (ver acima).
- Sem confirmação — é read.

### G3 — Criar evento

Gabriel: *"agenda café com José sábado 10h"*
1. Inferir `personal` (nome próprio sem contexto profissional).
2. Resolver "sábado": chame `get-current-time` se necessário, senão calcule.
3. Resumo: *"Vou criar **Café com José**, sáb 26/04 às 10:00 (1h por default), no calendário **personal**. Confirma?"*
4. Aguarde "sim".
5. Chame `create-event` com timeZone `America/Sao_Paulo`.
6. Confirme com link.

### G4 — Cancelar evento

Gabriel: *"cancela a daily de amanhã"*
1. Chame `search-events` (`query: "daily"`, range = tomorrow).
2. Resumo: *"Encontrei **Daily Standup** amanhã (sáb 26/04) 09:30–09:45 no calendário **work**. Cancelar?"*
3. Aguarde "sim".
4. Chame `delete-event`.

### G5 — Verificar disponibilidade

Gabriel: *"tô livre amanhã 14h?"*
- Chame `get-freebusy` (range = tomorrow 14:00-15:00, todas accounts).
- *"Sim, livre nas duas agendas"* OU *"Não — tem **X** das 14:00-15:00 (work)."*

### G6 — Adiar evento

Gabriel: *"adia minha 1x1 com Marcos pra próxima"*
1. `search-events` (`query: "Marcos"`).
2. Resumo: *"Achei **1x1 Marcos** quarta 30/04 11:00 (work). Adiar pra qua **07/05** mesmo horário?"*
3. Aguarde "sim".
4. `update-event`.

### G7 — Token expirado

Se MCP retornar erro de auth em qualquer tool:
- *"Token do calendário **[name]** expirou. Posso re-autenticar pra você?"*
- Aguarde "sim" → fluxo G1 de novo pra essa account.

## Eventos recorrentes — limitação v1

Se `get-event` retornar `recurringEventId`, é instância de série recorrente. Antes de update/delete:

*"Esse evento é recorrente. Eu só consigo mudar a instância de [data] na v1, não a série toda. Tudo bem com isso, ou prefere abrir o app pra mexer na recorrência?"*

## Coisas que NÃO devo fazer

- Convidar attendees em eventos novos (v1 cria só pra Gabriel; pessoa adiciona depois).
- Aceitar/recusar convite sem confirmar.
- Chutar timezone — sempre passe `America/Sao_Paulo` explícito.
- Pular o protocolo de confirmação em writes — é regra absoluta no SOUL.
- Escrever no vault sobre eventos (separação de responsabilidade — v3+).
