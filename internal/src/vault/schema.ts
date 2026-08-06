import { z } from 'zod';

export const ProxySchema = z.object({
  type: z.enum(['http', 'https', 'socks5']),
  host: z.string(),
  port: z.number().int().positive(),
  username: z.string().optional(),
  password: z.string().optional(),
});

export const CapsolverSchema = z.object({
  apiKey: z.string().min(1),
  preferredTask: z.string().default('AntiTurnstileTaskProxyLess'),
});

export const AccountSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(/^[a-zA-Z0-9_-]+$/, 'name must be alphanumeric + dash/underscore'),
    /** EOA private key used to sign AGW messages and transactions. May accompany a JWT. */
    privateKey: z
      .string()
      .regex(/^0x[a-fA-F0-9]{64}$/, 'EOA private key (32 bytes hex)')
      .optional(),
    /** Pre-baked Gigaverse JWT extracted from browser localStorage. */
    jwt: z
      .string()
      .regex(/^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, 'JWT format')
      .optional(),
    /** AGW smart-account address. Required when only JWT is provided (cannot derive from EOA). */
    agwAddress: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/)
      .optional(),
    /** Stable local identifier for a browser-approved Abstract device session. */
    sessionId: z
      .string()
      .regex(/^[a-f0-9]{32,64}$/)
      .optional(),
    /** Optional per-account dungeon override. 1 = Dungeon 5000, 3 = Underhaul. Falls back to CLI default. */
    dungeon: z.union([z.literal(1), z.literal(3)]).optional(),
    proxy: ProxySchema,
    capsolver: CapsolverSchema.optional(),
    notes: z.string().optional(),
  })
  .refine((a) => a.privateKey || a.jwt || a.agwAddress, {
    message: 'account must have a private key, JWT, or Abstract address',
  });

export const VaultSchema = z.object({
  version: z.literal(2).default(2),
  accounts: z.array(AccountSchema).default([]),
});

export type Proxy = z.infer<typeof ProxySchema>;
export type Capsolver = z.infer<typeof CapsolverSchema>;
export type Account = z.infer<typeof AccountSchema>;
export type Vault = z.infer<typeof VaultSchema>;
