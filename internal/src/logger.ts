import { mkdirSync, chmodSync, openSync, closeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pino, destination, type DestinationStream, type Logger } from 'pino';

const REDACT_PATHS = [
  'privateKey',
  '*.privateKey',
  'jwt',
  '*.jwt',
  'masterPassword',
  '*.masterPassword',
  'password',
  '*.password',
  'sessionToken',
  '*.sessionToken',
  'authorization',
  '*.authorization',
  'cookie',
  '*.cookie',
  'x-privy-token',
  '*.x-privy-token',
  'signature',
  '*.signature',
  'proxy.password',
  'proxy.username',
];

// Defensive scrub: any 64-hex (private keys) or JWT-looking strings that leak
// through error messages, stack traces, or string fields get masked.
const HEX64 = /0x[a-fA-F0-9]{64}/g;
const JWT = /eyJ[A-Za-z0-9_-]{20,}/g;

function scrubString(input: string): string {
  return input.replace(HEX64, '[REDACTED-HEX]').replace(JWT, '[REDACTED-JWT]');
}

/**
 * Resolve the pino destination for the current run.
 *
 * Rules (in priority order):
 *  1. If `opts.destination` is explicitly provided → use it (tests always do this).
 *  2. If `GIGABOT_VERBOSE=true` is set → write JSON to process.stderr (old raw mode).
 *  3. Otherwise (default pretty mode) → write JSON to a timestamped log file so the
 *     terminal shows only the human-readable presenter output.
 *
 * The log-file path can be overridden with the `LOG_FILE` env variable.
 */
function resolveDestination(
  provided: DestinationStream | undefined,
): DestinationStream | undefined {
  if (provided !== undefined) return provided;

  const verbose = process.env.GIGABOT_VERBOSE === 'true';
  if (verbose) return undefined; // pino defaults to stdout/stderr

  // Pretty mode: write JSON to a file so it doesn't pollute the terminal.
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const gigabotHome = resolve(process.env['GIGABOT_HOME'] ?? resolve(homedir(), '.gigabot'));
  const logFile = process.env.LOG_FILE ?? resolve(gigabotHome, 'logs', `play-${ts}.jsonl`);

  // Ensure the directory exists (best-effort — never crash the bot over this).
  try {
    mkdirSync(dirname(logFile), { recursive: true });
  } catch {
    // If we can't create the dir, fall through and let pino use stdout.
    return undefined;
  }

  // Restrict log file to owner-only before writing; logs may contain session tokens.
  try {
    // Touch the file first so chmod has a target even before pino opens it.
    closeSync(openSync(logFile, 'a', 0o600));
    chmodSync(logFile, 0o600);
  } catch {
    // best-effort
  }

  return destination({ dest: logFile, sync: false });
}

export function createLogger(opts: { destination?: DestinationStream } = {}): Logger {
  const dest = resolveDestination(opts.destination);
  return pino(
    {
      // In pretty (default) mode suppress console noise — all structured output
      // goes to the log file; the presenter handles the human-readable terminal.
      level:
        process.env.GIGABOT_VERBOSE === 'true'
          ? (process.env.LOG_LEVEL ?? 'info')
          : (process.env.LOG_LEVEL ?? 'info'),
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      serializers: {
        err: (err: Error & { status?: number; body?: unknown }) => ({
          name: err.name,
          message: scrubString(err.message),
          ...(err.stack ? { stack: scrubString(err.stack) } : {}),
          ...(err.status !== undefined ? { status: err.status } : {}),
          ...(err.body !== undefined
            ? { body: scrubString(JSON.stringify(err.body).slice(0, 500)) }
            : {}),
        }),
      },
      formatters: {
        log: (obj: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(obj)) {
            if (typeof v === 'string') obj[k] = scrubString(v);
          }
          return obj;
        },
      },
      hooks: {
        // Scrub the positional message string (pino's `msg` field) as well —
        // formatters.log only sees the merging object, not the message.
        logMethod(args, method) {
          const scrubbed = args.map((a) => (typeof a === 'string' ? scrubString(a) : a));
          return method.apply(this, scrubbed as Parameters<typeof method>);
        },
      },
    },
    dest,
  );
}
