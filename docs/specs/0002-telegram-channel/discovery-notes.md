---
feature: telegram-channel
spec: "[[spec]]"
plan: "[[plan]]"
created: 2026-04-25
---
# Discovery — Telegram Channel (0002)

**Data:** 2026-04-25
**Verificado por:** Gabriel + Claude assistente

## 1. grammy

**Versão atual:** `1.42.0` (npm latest em 2026-04-25).

**IMPORTANTE — divergência da spec:** spec/plan inicialmente referenciaram "grammy 2.x". A versão estável atual é `1.42.x` — major 2 ainda não foi released. Seguir com `1.42.0` (último patch publicado). Atualização de referências aplicada em `spec.md` linha 116 e `plan.md` campo "Tech Stack" — substituído por `^1.42.0`.

**Engines:** `node ^12.20.0 || >=14.13.1`. Compat com Node 24 (já é o nosso runtime). ✓

**Tamanho transitivo:** dependências mínimas (`debug`, `@grammyjs/types`). Sem peer deps obrigatórios.

## 2. Polling lifecycle

Validado contra source `https://raw.githubusercontent.com/grammyjs/grammY/v1.42.0/src/bot.ts`.

**`bot.start()`:**
- Assinatura: `async start(options?: PollingOptions): Promise<void>`
- "This method returns a Promise that will never resolve except if your bot is stopped. **You don't need to await the call to bot.start.**"
- Pattern correto: `void bot.start()` (fire-and-forget). Bloquearia indefinidamente se awaited.

**`PollingOptions`:**
```typescript
{
  timeout?: number;                                                    // segundos, default 30
  allowed_updates?: ReadonlyArray<Exclude<keyof Update, "update_id">>; // filtrar por tipo
  drop_pending_updates?: boolean;
}
```

**Pra Whis MVP:** chamar `void bot.start()` sem options (defaults OK). Não filtramos updates a priori — `bot.on('message:text', ...)` já filtra na camada handler.

**`bot.stop()`:** `async stop(): Promise<void>`. Não espera middlewares pendentes. Pra shutdown limpo, parar antes de fechar DB/server (já é a ordem em `index.ts`).

**Healthcheck antes do polling:** `await bot.api.getMe()` antes de `void bot.start()` é seguro — não há race. Se `getMe()` falha, captura no try/catch e segue (loga `telegram_health_failed`); polling pode tentar e eventualmente sucedir.

## 3. setMessageReaction

Bot API 7.0+ (jan/2024), suportado pela conta gerada via `@BotFather` em qualquer momento.

**Contrato:**
```typescript
bot.api.setMessageReaction(
  chat_id: number | string,
  message_id: number,
  options: {
    reaction?: ReactionType[];
    is_big?: boolean;
  },
): Promise<true>
```

**`ReactionType` (union):**
```typescript
type ReactionType =
  | { type: 'emoji'; emoji: string }
  | { type: 'custom_emoji'; custom_emoji_id: string }
  | { type: 'paid' };
```

**Pra Whis MVP:** só `{ type: 'emoji', emoji: '👀' }`. Sem `custom_emoji` (exigem premium e gerenciamento de IDs).

**Remoção:** `reaction: []` (array vazia). Confirmado em comments da issue oficial e padrão Bot API.

**Emojis suportados:** lista limitada de Telegram (~70 emojis padrão). `👀` está incluído. Se um dia adicionarmos mapping pra outros (✅, ⚠️ que mapeiam pra `white_check_mark`, `warning`), validar emoji-by-emoji — Telegram pode rejeitar com `BAD_REQUEST: REACTION_INVALID` se o emoji não for da lista permitida.

## 4. Update.message shape

Confirmado contra `core.telegram.org/bots/api#message` e tipos do `@grammyjs/types`.

```typescript
interface Update {
  update_id: number;
  message?: Message;
  edited_message?: Message;
  callback_query?: CallbackQuery;
  // ... outros tipos não usados no MVP
}

interface Message {
  message_id: number;
  date: number;
  chat: { id: number; type: 'private' | 'group' | 'supergroup' | 'channel'; first_name?: string; username?: string; };
  from?: { id: number; is_bot: boolean; first_name: string; username?: string; };
  text?: string;
  // ... + voice, photo, sticker, etc (filtrados out por MVP)
}
```

**Pra `normalize.ts`:**
- Filtrar `update.message` ausente → `null`.
- Filtrar `chat.type !== 'private'` → `null`.
- Filtrar `chat.id !== ownerChatId` → `null` (whitelist).
- Filtrar ausência ou whitespace-only de `text` → `null`.
- `messageRef = String(message_id)`.
- `userId = conversationId = 'tg:' + chat.id` (keyspace prefixed).
- `correlationId = randomUUID()`.

## 5. Error handling

```typescript
import { GrammyError, HttpError } from 'grammy';

bot.catch((err) => {
  const ctx = err.ctx;        // BotError.ctx — mensagem do update que falhou
  const e = err.error;        // BotError.error — instance do erro original
  if (e instanceof GrammyError) {
    // Telegram retornou ok: false. e.description é a string do Telegram (ex: "Unauthorized").
    // Códigos relevantes: 401 (token inválido), 409 (conflito de polling), 429 (flood).
  } else if (e instanceof HttpError) {
    // Não conseguiu falar com api.telegram.org (rede caída, DNS).
  } else {
    // Outro erro do nosso handler.
  }
});
```

**Pra Whis MVP:** logar tudo via `logger.error({ event: 'telegram_polling_error', err: String(e) })` no `bot.catch`. Não traduzir os erros pra usuário (não chega na UI — bot só responde a mensagens válidas; erros internos só viram log).

**Caso especial — 409 Conflict:** acontece se outra instância do worker está rodando com mesmo token. grammy não retenta automaticamente — segue logando e o `bot.start()` retornará error. Documentado no troubleshooting de SMOKE.md.

## Verdict

**OK pra prosseguir** com Tasks 1-11. Nenhuma divergência material da spec.

**Amendments aplicados:**
1. Pinar versão `grammy ^1.42.0` (em vez de `^2.0.0` aspirado na spec).
2. Comentário em `TelegramChannel.start()` documentando padrão `void bot.start()`.
3. Mapping de reactions limitado a `eyes` (👀) na v1; outros emojis ficam guardados no `REACTION_EMOJI` map mas só `eyes` é usado pelo `AgentCore`.

**Risco residual:** Telegram pode mudar Bot API e quebrar `setMessageReaction` com BAD_REQUEST. Mitigação: `bot.catch` loga, agente continua respondendo (reaction é cosmético).
