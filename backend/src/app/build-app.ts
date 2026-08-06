/**
 * Fastify 5 application foundation (owner ruling 2; docs/25 §2).
 *
 * Slice-1 scope: framework foundation only — TypeBox type provider, typed
 * error envelope, and an internal health route. Business API routes arrive
 * with their owning slices as Fastify plugins (modular monolith, docs/25 §2),
 * each carrying JSON Schema request/response validation; schema-driven
 * OpenAPI generation is added when the first business routes land.
 */
import { Type } from '@sinclair/typebox';
import Fastify from 'fastify';
import type { FastifyError, FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';

import { isDbError } from '../db/errors';

export interface BuildAppOptions {
  logger?: boolean;
}

/** Typed error envelope per docs/24 §11.2. */
const ErrorBody = Type.Object({
  code: Type.String(),
  message: Type.String(),
});

const HealthResponse = Type.Object({
  status: Type.Literal('ok'),
});

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? false,
  }).withTypeProvider<TypeBoxTypeProvider>();

  app.setErrorHandler((error: FastifyError, request, reply) => {
    // Database errors are translated at the db boundary (docs/25 §7); here
    // they map to the docs/24 §11 typed vocabulary without leaking SQL detail.
    if (isDbError(error)) {
      request.log.error({ err: error }, 'database error');
      return reply.status(500).send({ code: 'internalError', message: 'Internal error' });
    }
    if (error.validation !== undefined) {
      return reply
        .status(422)
        .send({ code: 'validationError', message: error.message });
    }
    request.log.error({ err: error }, 'unhandled error');
    const statusCode = error.statusCode !== undefined && error.statusCode >= 400 ? error.statusCode : 500;
    return reply.status(statusCode).send({
      code: statusCode >= 500 ? 'internalError' : 'requestError',
      message: statusCode >= 500 ? 'Internal error' : error.message,
    });
  });

  app.get(
    '/internal/health',
    { schema: { response: { 200: HealthResponse, 500: ErrorBody } } },
    async () => ({ status: 'ok' as const }),
  );

  return app;
}
