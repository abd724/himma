/**
 * W6-1 — vendor-neutral structured production logging (docs/37 §24).
 *
 * Fastify's built-in pino is configured — no cloud SDK, no transport
 * vendor: production writes JSON lines to stdout for whatever collector
 * the platform provides.
 *
 * NEVER-LOG discipline (docs/37 §24, test-pinned): bearer/refresh material,
 * cookies, CSRF tokens, webhook signatures/secrets, redemption codes and
 * credential secrets, Stripe/API secrets, database passwords, and raw
 * request bodies never reach a log line. Enforcement is structural where
 * possible: the request serializer emits ONLY bounded metadata (method +
 * query-stripped path + ids) — arbitrary headers and bodies are simply
 * never serialized — and `redact` covers the header paths pino's own
 * hooks could otherwise surface.
 */

export type RuntimeRoleTag = 'api' | 'worker' | 'maintenance' | 'migrate' | 'dev';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

const LOG_LEVELS: readonly LogLevel[] = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'];

export function parseLogLevel(raw: string | undefined, fallback: LogLevel = 'info'): LogLevel {
  if (raw === undefined || raw === '') return fallback;
  if ((LOG_LEVELS as readonly string[]).includes(raw)) return raw as LogLevel;
  throw new Error(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')} — received "${raw}"`);
}

const MAX_LOGGED_PATH_LENGTH = 200;

/** Bounded, query-stripped route path — never query params, never bodies. */
export function safeLogPath(url: string | undefined): string {
  if (url === undefined) return '';
  const withoutQuery = url.split('?')[0] ?? '';
  return withoutQuery.slice(0, MAX_LOGGED_PATH_LENGTH);
}

interface SerializableRequest {
  method?: string;
  url?: string;
  id?: unknown;
}

interface SerializableReply {
  statusCode?: number;
}

/**
 * Pino/Fastify logger options for a production runtime role. The returned
 * object is passed straight to Fastify's `logger` option (docs/37 §24).
 */
export function buildLoggerOptions(input: { role: RuntimeRoleTag; level: LogLevel }): object {
  return {
    level: input.level,
    base: { role: input.role },
    // Belt-and-braces: these paths are redacted even though the bounded
    // request serializer below never emits headers in the first place.
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-csrf-token"]',
        'req.headers["stripe-signature"]',
        'headers.authorization',
        'headers.cookie',
      ],
      censor: '[redacted]',
    },
    serializers: {
      req(request: SerializableRequest) {
        return {
          method: request.method,
          path: safeLogPath(request.url),
          id: request.id,
        };
      },
      res(reply: SerializableReply) {
        return { statusCode: reply.statusCode };
      },
    },
  };
}
