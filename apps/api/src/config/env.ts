import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';
import { z } from 'zod';

// The single .env file lives at the repository root; the API usually runs from apps/api.
loadDotenv({ path: [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')], quiet: true } as never);

const secret = z.string().min(32, 'must be at least 32 characters');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    DATABASE_URL: z.string().min(1),
    JWT_ACCESS_SECRET: secret,
    JWT_REFRESH_SECRET: secret,
    WEB_URL: z.url().default('http://localhost:5173'),
    API_URL: z.url().default('http://localhost:4000'),
    CORS_ORIGINS: z
      .string()
      .default('http://localhost:5173')
      .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),
    PAYMENT_PROVIDER: z.enum(['none', 'dev', 'razorpay']).default('none'),
    PAYMENT_API_KEY: z.string().default(''),
    PAYMENT_API_SECRET: z.string().default(''),
    PAYMENT_WEBHOOK_SECRET: z.string().default(''),
    STORAGE_PROVIDER: z.enum(['local', 'database']).default('local'),
    // The interactive API reference. Off in production unless switched on deliberately.
    API_DOCS: z.enum(['on', 'off']).optional(),
    EMAIL_PROVIDER: z.enum(['dev', 'resend']).default('dev'),
    EMAIL_API_KEY: z.string().default(''),
    EMAIL_FROM: z.string().default('ServeOS <no-reply@serveos.local>'),
  })
  .superRefine((env, ctx) => {
    if (env.PAYMENT_PROVIDER === 'dev' && env.PAYMENT_WEBHOOK_SECRET.length < 32) {
      ctx.addIssue({ code: 'custom', path: ['PAYMENT_WEBHOOK_SECRET'], message: 'must be at least 32 characters when PAYMENT_PROVIDER=dev' });
    }
    if (env.PAYMENT_PROVIDER === 'razorpay') {
      if (!/^rzp_(test|live)_\w+$/.test(env.PAYMENT_API_KEY)) ctx.addIssue({ code: 'custom', path: ['PAYMENT_API_KEY'], message: 'must be a Razorpay key id (rzp_test_... or rzp_live_...)' });
      if (env.PAYMENT_API_SECRET.length < 10) ctx.addIssue({ code: 'custom', path: ['PAYMENT_API_SECRET'], message: 'is required when PAYMENT_PROVIDER=razorpay' });
      if (env.PAYMENT_WEBHOOK_SECRET.length < 16) ctx.addIssue({ code: 'custom', path: ['PAYMENT_WEBHOOK_SECRET'], message: 'must be the webhook secret set in the Razorpay dashboard (at least 16 characters)' });
    }
    if (env.EMAIL_PROVIDER === 'resend' && env.EMAIL_API_KEY.length < 10) {
      ctx.addIssue({ code: 'custom', path: ['EMAIL_API_KEY'], message: 'is required when EMAIL_PROVIDER=resend' });
    }
    if (env.NODE_ENV === 'production' && env.PAYMENT_PROVIDER === 'dev') {
      ctx.addIssue({ code: 'custom', path: ['PAYMENT_PROVIDER'], message: 'the simulated "dev" gateway cannot be used in production' });
    }
    if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
      ctx.addIssue({ code: 'custom', path: ['JWT_REFRESH_SECRET'], message: 'must differ from JWT_ACCESS_SECRET' });
    }
  });

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || 'env'}: ${i.message}`);
    // Names only: never print the values of secrets.
    const message = `Invalid environment configuration:\n${lines.join('\n')}\nSee .env.example.`;
    if (process.env.JEST_WORKER_ID) throw new Error(message);
    // A plain message and a clean exit read better than a stack trace when the server will not start.
    console.error(message);
    process.exit(1);
  }
  return parsed.data;
}

export const env: Env = load();
export const isProduction = env.NODE_ENV === 'production';
