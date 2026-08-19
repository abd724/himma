/**
 * Himma-admin organization lifecycle routes (docs/27 §13.3) — S3-4.
 *
 * Internal admin surface: every route declares the `adminStepUp` policy
 * (live session + MFA assurance + recent MFA factor + ≥1 active database
 * admin role, B2-6C — the pre-split semantics, deliberately retained by
 * the W3-1 baseline/step-up separation), and the services additionally
 * require the
 * `operations` role fresh per transaction. Provider memberships and
 * Cognito claims satisfy nothing here. Registration shares the admin
 * surface's production capability gate in build-app; the D-S3-3
 * verification-evidence gate additionally fail-closes verify/go-live in
 * production (no bypass — see organization-admin.ts).
 */
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';

import { requirePrincipal } from '../../identity/http/auth-plugin';
import { sendOutcome, type HttpOutcomeName } from '../../identity/http/http-outcomes';
import {
  createOrganization,
  transitionOrganization,
  type AdminLifecycleAction,
  type OrganizationAdminDeps,
} from '../services/organization-admin';

const ADMIN_ORG_BODY_LIMIT = 16_384;
const Uuid = Type.String({ format: 'uuid' });
const ErrorBody = Type.Object({ code: Type.String(), message: Type.String() });
const ADMIN_ORG_ERRORS = {
  401: ErrorBody,
  403: ErrorBody,
  404: ErrorBody,
  409: ErrorBody,
  422: ErrorBody,
  429: ErrorBody,
  500: ErrorBody,
  503: ErrorBody,
};

/** Safe machine-readable reason slug — never free-text private notes. */
const ReasonCode = Type.Optional(Type.String({ pattern: '^[a-z0-9_]{1,64}$' }));

const TransitionBody = Type.Object({
  expectedVersion: Type.Integer({ minimum: 1 }),
  reasonCode: ReasonCode,
});
const TransitionResponse = Type.Object({
  status: Type.Literal('organizationTransitioned'),
  state: Type.String(),
  version: Type.Integer(),
});

function transitionOutcomeName(
  kind: Exclude<
    Awaited<ReturnType<typeof transitionOrganization>>['kind'],
    'organizationTransitioned'
  >,
): HttpOutcomeName {
  switch (kind) {
    case 'forbidden':
      return 'forbidden';
    case 'organizationNotFound':
      return 'notFound';
    case 'lifecycleConflict':
      return 'lifecycleConflict';
    case 'verificationEvidenceUnavailable':
      return 'verificationEvidenceUnavailable';
    case 'staleVersion':
      return 'staleVersion';
  }
}

export function registerOrganizationAdminRoutes(
  instance: FastifyInstance,
  deps: OrganizationAdminDeps,
): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>();

  // ---------------------------------------------------------------------
  // POST /admin/organizations — draft organization + public-profile shell
  // + founding Owner invitation, ONE transaction (docs/27 §10 step 2).
  // ---------------------------------------------------------------------
  app.post(
    '/admin/organizations',
    {
      config: { authPolicy: 'adminStepUp' },
      bodyLimit: ADMIN_ORG_BODY_LIMIT,
      schema: {
        body: Type.Object({
          legalName: Type.String({ minLength: 1, maxLength: 200 }),
          tradeName: Type.String({ minLength: 1, maxLength: 120 }),
          displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
          foundingOwnerEmail: Type.String({ format: 'email', maxLength: 320 }),
        }),
        response: {
          200: Type.Object({
            status: Type.Literal('organizationCreated'),
            organizationId: Uuid,
            invitationId: Uuid,
            expiresAt: Type.String(),
            mailDelivery: Type.Union([Type.Literal('delivered'), Type.Literal('failed')]),
          }),
          ...ADMIN_ORG_ERRORS,
        },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request.principal);
      const result = await createOrganization(deps, { userId: principal.userId }, request.body);
      if (result.kind === 'organizationCreated') {
        return reply.status(200).send({
          status: 'organizationCreated',
          organizationId: result.organizationId,
          invitationId: result.invitationId,
          expiresAt: result.expiresAt.toISOString(),
          mailDelivery: result.mailDelivery,
        });
      }
      return sendOutcome(reply, 'forbidden');
    },
  );

  // ---------------------------------------------------------------------
  // Lifecycle transitions — §5.1 admin edges only; the S3-1 trigger stays
  // the final authority beneath the typed pre-checks.
  // ---------------------------------------------------------------------
  const transitionRoutes: [string, AdminLifecycleAction][] = [
    ['/admin/organizations/:organizationId/verification/start-review', 'start_review'],
    ['/admin/organizations/:organizationId/verification/verify', 'verify'],
    ['/admin/organizations/:organizationId/verification/reject', 'reject'],
    ['/admin/organizations/:organizationId/go-live', 'go_live'],
    ['/admin/organizations/:organizationId/suspend', 'suspend'],
    ['/admin/organizations/:organizationId/reinstate', 'reinstate'],
    ['/admin/organizations/:organizationId/offboard', 'offboard'],
  ];
  for (const [url, action] of transitionRoutes) {
    app.post(
      url,
      {
        config: { authPolicy: 'adminStepUp' },
        bodyLimit: ADMIN_ORG_BODY_LIMIT,
        schema: {
          params: Type.Object({ organizationId: Uuid }),
          body: TransitionBody,
          response: { 200: TransitionResponse, ...ADMIN_ORG_ERRORS },
        },
      },
      async (request, reply) => {
        const principal = requirePrincipal(request.principal);
        const result = await transitionOrganization(deps, { userId: principal.userId }, {
          organizationId: request.params.organizationId,
          action,
          expectedVersion: request.body.expectedVersion,
          ...(request.body.reasonCode !== undefined
            ? { reasonCode: request.body.reasonCode }
            : {}),
        });
        if (result.kind === 'organizationTransitioned') {
          return reply.status(200).send({
            status: 'organizationTransitioned',
            state: result.state,
            version: result.version,
          });
        }
        return sendOutcome(reply, transitionOutcomeName(result.kind));
      },
    );
  }
}
