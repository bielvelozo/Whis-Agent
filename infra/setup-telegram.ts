#!/usr/bin/env -S tsx
// Helper one-time pra descobrir TELEGRAM_OWNER_CHAT_ID.
// Lê TELEGRAM_BOT_TOKEN do profile/.env, faz getMe, espera primeira mensagem
// pelo bot via long-polling, imprime chat_id e encerra.

import { readFileSync } from 'node:fs';
import { Bot } from 'grammy';

function readEnvFromFile(path: string): Record<string, string> {
  try {
    const raw = readFileSync(path, 'utf8');
    const out: Record<string, string> = {};
    for (const line of raw.split('\n')) {
      const m = line.match(/^([A-Z_][A-Z_0-9]*)=(.*)$/);
      if (m?.[1]) out[m[1]] = (m[2] ?? '').replace(/^["']|["']$/g, '');
    }
    return out;
  } catch {
    return {};
  }
}

const env = readEnvFromFile('profile/.env');
const token = env.TELEGRAM_BOT_TOKEN ?? process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  console.error(
    'TELEGRAM_BOT_TOKEN vazio em profile/.env (ou variável de ambiente).\n' +
      '1. Abre @BotFather no Telegram\n' +
      '2. /newbot, escolhe nome e username\n' +
      '3. Cola o token retornado em profile/.env como TELEGRAM_BOT_TOKEN=...\n' +
      '4. Roda este script de novo.',
  );
  process.exit(1);
}

const bot = new Bot(token);

const TIMEOUT_MS = 5 * 60 * 1000; // 5min
const timeout = setTimeout(() => {
  console.error('\nTimeout: nenhuma mensagem recebida em 5min. Abortando.');
  void bot.stop().finally(() => process.exit(1));
}, TIMEOUT_MS);

async function main(): Promise<void> {
  const me = await bot.api.getMe();
  console.log(`Bot pareado: @${me.username} (id ${me.id})`);
  console.log(
    '\nIMPORTANTE: pare o worker (`pnpm run docker:down`) antes de continuar — só uma\n' +
      'instância pode estar em polling com o mesmo token (Telegram retorna 409 Conflict).\n',
  );
  console.log('Agora abre o Telegram e manda /start (ou qualquer mensagem) pro teu bot.\n');

  bot.on('message', async (ctx) => {
    clearTimeout(timeout);
    const chatId = ctx.chat.id;
    console.log('\nDescoberto!\n');
    console.log(`TELEGRAM_OWNER_CHAT_ID=${chatId}`);
    console.log('\nCola essa linha em profile/.env e roda `pnpm run docker:up`.');
    try {
      await ctx.reply('Capturado teu chat_id. Volta pro terminal pra continuar o setup.');
    } catch {
      /* não-crítico */
    }
    await bot.stop();
    process.exit(0);
  });

  bot.catch((err) => {
    console.error('\nErro do grammy:', err.error ?? err);
    clearTimeout(timeout);
    process.exit(1);
  });

  await bot.start();
}

void main().catch((err) => {
  clearTimeout(timeout);
  console.error('Falhou:', err instanceof Error ? err.message : err);
  process.exit(1);
});
