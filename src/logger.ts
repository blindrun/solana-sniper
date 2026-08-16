import fs from 'node:fs';
import path from 'node:path';
import type { LogLevel } from './config.js';

const LEVEL_RANK: Record<LogLevel, number> = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40,
};

/**
 * Anything matching these is scrubbed before a line is written. The private key
 * is never intentionally passed to the logger, but a stack trace or an axios-style
 * error dump can carry one by accident, so the filter is unconditional.
 */
const SECRET_KEYS = /^(walletPrivateKey|privateKey|secretKey|WALLET_PRIVATE_KEY|apiKey|api_key)$/i;

let currentLevel: LogLevel = 'INFO';
let logDir: string | null = null;
let openDate = '';
let stream: fs.WriteStream | null = null;

export function configureLogger(level: LogLevel, dir: string): void {
  currentLevel = level;
  logDir = dir;
  fs.mkdirSync(dir, { recursive: true });
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Daily rotation: the filename is derived per write, so a long-running process rolls over on its own. */
function sink(): fs.WriteStream | null {
  if (!logDir) return null;
  const date = today();
  if (stream && openDate === date) return stream;
  stream?.end();
  openDate = date;
  stream = fs.createWriteStream(path.join(logDir, `bot-${date}.log`), { flags: 'a' });
  stream.on('error', (err) => {
    process.stderr.write(`logger: write failed: ${String(err)}\n`);
  });
  return stream;
}

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth-limit]';
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEYS.test(k) ? '[REDACTED]' : scrub(v, depth + 1);
  }
  return out;
}

/** Structured, one JSON object per line. `event` is the machine-readable discriminator. */
export function log(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[currentLevel]) return;

  const record = {
    ts: new Date().toISOString(),
    level,
    event,
    ...(scrub(fields) as Record<string, unknown>),
  };

  let line: string;
  try {
    line = JSON.stringify(record, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  } catch {
    line = JSON.stringify({
      ts: record.ts,
      level: 'ERROR',
      event: 'LOG_SERIALIZE_FAILED',
      original_event: event,
    });
  }

  process.stdout.write(line + '\n');
  sink()?.write(line + '\n');
}

export const logger = {
  debug: (event: string, fields?: Record<string, unknown>) => log('DEBUG', event, fields),
  info: (event: string, fields?: Record<string, unknown>) => log('INFO', event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => log('WARN', event, fields),
  error: (event: string, fields?: Record<string, unknown>) => log('ERROR', event, fields),
};

export function closeLogger(): void {
  stream?.end();
  stream = null;
}
