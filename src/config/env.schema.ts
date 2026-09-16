import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  GOOGLE_API_KEY: z.string().optional().default(''),
  GROQ_API_KEY: z.string().optional().default(''),
  EMBEDDING_PROVIDER: z.enum(['local', 'gemini']).default('local'),
  CHAT_PROVIDER: z.enum(['gemini', 'groq']).default('gemini'),
  DATA_DIR: z.string().default('./data'),
  // Bounded deliberately (DEF-006): unbounded, every impossible value passed
  // here and failed later inside `app.listen()`, where the error no longer
  // names the variable that caused it. `0` is excluded on purpose — Node
  // accepts it and binds an arbitrary free port, so it is the one bad value
  // that *starts successfully*, on a port nobody can predict.
  PORT: z.coerce
    .number()
    .int('PORT must be a whole number')
    .min(1, 'PORT must be between 1 and 65535')
    .max(65535, 'PORT must be between 1 and 65535')
    .default(3000),
  NODE_ENV: z.string().default('development'),
  LLM_CACHE: z.enum(['on', 'off']).default('on'),
  // 32 random bytes, base64 — decoded and length-checked in credentials/crypto.util.ts,
  // not here, since that's where the "must decode to exactly 32 bytes" reasoning lives.
  CREDENTIAL_KEY: z.string().optional().default(''),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    throw new Error(
      `Invalid environment configuration:\n${result.error.toString()}`,
    );
  }
  return result.data;
}
