// apps/worker/src/config.ts
import { z } from 'zod';

const schema = z
  .object({
    CLAUDE_CODE_OAUTH_TOKEN: z.string().min(1),

    // WhatsApp (opcional — validado por refine quando WHATSAPP_ENABLED=true)
    WHATSAPP_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    EVOLUTION_BASE_URL: z.string().url().optional(),
    EVOLUTION_API_KEY: z.string().min(1).optional(),
    EVOLUTION_INSTANCE: z.string().min(1).default('whis'),
    WHATSAPP_OWNER_NUMBER: z
      .string()
      .regex(/^\d{10,15}$/, { message: 'must be digits only (e.g. 5511999999999)' })
      .optional(),

    // Telegram (default canal — validado por refine quando TELEGRAM_ENABLED=true)
    TELEGRAM_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
    TELEGRAM_OWNER_CHAT_ID: z.coerce.number().int().optional(),

    // Worker
    WORKSPACE_DIR: z.string().default('/app/context'),
    DATA_DIR: z.string().default('/app/data'),
    WEBHOOK_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    WEBHOOK_REQUIRE_APIKEY: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    SESSION_IDLE_HOURS: z.coerce.number().int().min(1).max(168).default(6),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    WHIS_BACKEND: z.enum(['claude-code', 'mock']).default('claude-code'),
  })
  .refine((env) => env.WHATSAPP_ENABLED || env.TELEGRAM_ENABLED, {
    message: 'pelo menos um canal deve estar habilitado: WHATSAPP_ENABLED ou TELEGRAM_ENABLED',
  })
  .refine(
    (env) =>
      !env.WHATSAPP_ENABLED ||
      (!!env.EVOLUTION_BASE_URL && !!env.EVOLUTION_API_KEY && !!env.WHATSAPP_OWNER_NUMBER),
    {
      message:
        'WHATSAPP_ENABLED=true exige EVOLUTION_BASE_URL, EVOLUTION_API_KEY, WHATSAPP_OWNER_NUMBER',
    },
  )
  .refine(
    (env) => !env.TELEGRAM_ENABLED || (!!env.TELEGRAM_BOT_TOKEN && !!env.TELEGRAM_OWNER_CHAT_ID),
    { message: 'TELEGRAM_ENABLED=true exige TELEGRAM_BOT_TOKEN e TELEGRAM_OWNER_CHAT_ID' },
  );

export interface Config {
  claude: { oauthToken: string };
  whatsapp: {
    enabled: boolean;
    ownerNumber: string | null;
  };
  evolution: {
    baseUrl: string | null;
    apiKey: string | null;
    instance: string;
  };
  telegram: {
    enabled: boolean;
    botToken: string | null;
    ownerChatId: number | null;
  };
  workspaceDir: string;
  dataDir: string;
  webhookPort: number;
  webhookRequireApiKey: boolean;
  sessionIdleHours: number;
  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  backend: 'claude-code' | 'mock';
}

export function loadConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${issues}`);
  }
  const e = parsed.data;
  return {
    claude: { oauthToken: e.CLAUDE_CODE_OAUTH_TOKEN },
    whatsapp: {
      enabled: e.WHATSAPP_ENABLED,
      ownerNumber: e.WHATSAPP_OWNER_NUMBER ?? null,
    },
    evolution: {
      baseUrl: e.EVOLUTION_BASE_URL ?? null,
      apiKey: e.EVOLUTION_API_KEY ?? null,
      instance: e.EVOLUTION_INSTANCE,
    },
    telegram: {
      enabled: e.TELEGRAM_ENABLED,
      botToken: e.TELEGRAM_BOT_TOKEN ?? null,
      ownerChatId: e.TELEGRAM_OWNER_CHAT_ID ?? null,
    },
    workspaceDir: e.WORKSPACE_DIR,
    dataDir: e.DATA_DIR,
    webhookPort: e.WEBHOOK_PORT,
    webhookRequireApiKey: e.WEBHOOK_REQUIRE_APIKEY,
    sessionIdleHours: e.SESSION_IDLE_HOURS,
    logLevel: e.LOG_LEVEL,
    backend: e.WHIS_BACKEND,
  };
}
