/**
 * Customer entitlement-acquisition HTTP surface — S6-1 (docs/35 §13, §24).
 *
 * Exactly the bounded acquisition contracts and NOTHING of S6-2/S6-3:
 * acquisition quote (unit-less; server-authored money + immutable terms),
 * zero-price confirmation (no payment state of any kind), paid initiation
 * (the generalized W5 orchestration — identifiers + idempotency key only;
 * no amount/currency/uses/validity/commission/revision field exists on any
 * wire), the converged purchase payment-status read, and the own-purchase
 * read. Every route is `authenticatedCustomer`; cross-account ids are
 * not-found-shaped by the services.
 *
 * Deliberately ABSENT (structurally locked by the route-inventory test):
 * reservation quote creation, `confirmEntitlementReservation`, entitlement
 * list/detail ("My Passes & Memberships" — S6-3), credential generation,
 * redemption, attendance (S6-2), and any customer payment-success
 * authority (BOTH trusted paid-confirmation seams stay route-less — the
 * source-level lock scans this directory too).
 */
import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';

import type { Db } from '../../../db/kysely';
import { requirePrincipal } from '../../identity/http/auth-plugin';
import { sendOutcome, type HttpOutcomeName } from '../../identity/http/http-outcomes';
import type { CustomerPaymentComposition } from '../../booking/http/booking-customer-routes';
import { customerEntitlementPurchasePaymentStatus } from '../../payment/services/customer-payment-read';
import { startPaidEntitlementCheckout } from '../../payment/services/checkout-orchestration';
import {
  confirmFreeEntitlementPurchase,
  getEntitlementPurchase,
} from '../services/entitlement-acquisition';
import { requestEntitlementQuote } from '../services/entitlement-quote';

const BODY_LIMIT = 16_384;
const Uuid = Type.String({ format: 'uuid' });
const ErrorBody = Type.Object({ code: Type.String(), message: Type.String() });
const ERRORS = {
  400: ErrorBody,
  401: ErrorBody,
  403: ErrorBody,
  404: ErrorBody,
  409: ErrorBody,
  422: ErrorBody,
  429: ErrorBody,
  500: ErrorBody,
  503: ErrorBody,
};
const IdempotencyKey = Type.String({ minLength: 8, maxLength: 128 });
const NullableString = Type.Union([Type.String(), Type.Null()]);

const FulfillmentTermsSchema = Type.Object({
  usageKind: Type.Union([Type.Literal('finite'), Type.Literal('unlimited')]),
  usesTotal: Type.Optional(Type.Integer()),
  validityKind: Type.Union([
    Type.Literal('daysFromConfirmation'),
    Type.Literal('fixedEndDate'),
    Type.Literal('none'),
  ]),
  validityDays: Type.Optional(Type.Integer()),
  validityEndDate: Type.Optional(Type.String()),
  reservationRequired: Type.Boolean(),
  walkInAllowed: Type.Boolean(),
});

const EntitlementQuoteSchema = Type.Object({
  quoteId: Uuid,
  programId: Uuid,
  organizationId: Uuid,
  participantId: Uuid,
  optionKind: Type.String(),
  totalFils: Type.Integer(),
  currency: Type.Literal('AED'),
  priceKind: Type.Literal('oneOff'),
  taxTreatment: Type.Literal('notConfigured'),
  lines: Type.Array(
    Type.Object({
      lineNo: Type.Integer(),
      kind: Type.Literal('base'),
      labelEn: Type.String(),
      amountFils: Type.Integer(),
    }),
  ),
  expiresAt: Type.String(),
  fulfillment: FulfillmentTermsSchema,
});

const EntitlementSchema = Type.Object({
  entitlementId: Uuid,
  usageKind: Type.Union([Type.Literal('finite'), Type.Literal('unlimited')]),
  usesTotal: Type.Optional(Type.Integer()),
  validFrom: Type.String(),
  validUntil: Type.Optional(Type.String()),
  reservationRequired: Type.Boolean(),
  walkInAllowed: Type.Boolean(),
});

const EntitlementPurchaseSchema = Type.Object({
  purchaseId: Uuid,
  referenceCode: NullableString,
  state: Type.String(),
  programId: Uuid,
  organizationId: Uuid,
  participantId: Uuid,
  totalFils: Type.Integer(),
  currency: Type.Literal('AED'),
  createdAt: Type.String(),
  confirmedAt: NullableString,
  entitlement: Type.Optional(EntitlementSchema),
});

export interface EntitlementCustomerRouteDeps {
  db: Db;
  /** Absent → paid acquisition keeps the fail-closed refusal shaping. */
  payment?: CustomerPaymentComposition;
}

export function registerEntitlementCustomerRoutes(
  rawApp: FastifyInstance,
  deps: EntitlementCustomerRouteDeps,
): void {
  const app = rawApp.withTypeProvider<TypeBoxTypeProvider>();
  const serviceDeps = { db: deps.db };

  function accountOf(request: { principal: unknown }): string | undefined {
    const principal = requirePrincipal(
      (request as { principal: Parameters<typeof requirePrincipal>[0] }).principal,
    );
    return principal.accountId;
  }

  function failure(reply: FastifyReply, kind: string): FastifyReply {
    const name: HttpOutcomeName =
      kind === 'programNotFound' ||
      kind === 'programNotBookable' ||
      kind === 'priceOptionNotFound' ||
      kind === 'participantNotFound' ||
      kind === 'quoteNotFound' ||
      kind === 'purchaseNotFound'
        ? 'notFound'
        : kind === 'participantIneligible'
          ? 'participantIneligible'
          : kind === 'optionNotEntitlement' || kind === 'quoteNotAcquisition'
            ? 'invalidQuote'
            : kind === 'quoteExpired'
              ? 'quoteExpired'
              : kind === 'fulfillmentUnavailable'
                ? 'fulfillmentUnavailable'
                : kind === 'notFreeQuote'
                  ? 'notFreeQuote'
                  : kind === 'paymentNotRequired'
                    ? 'paymentNotRequired'
                    : kind === 'quoteAlreadyUsed' || kind === 'alreadyAcquired'
                      ? 'alreadyConfirmed'
                      : kind === 'purchaseConcluded'
                        ? 'checkoutConcluded'
                        : kind === 'paymentUnavailable' ||
                            kind === 'commissionTermsUnavailable'
                          ? 'paymentUnavailable'
                          : kind === 'checkoutAlreadyActive'
                            ? 'checkoutAlreadyActive'
                            : kind === 'intentNotLive'
                              ? 'checkoutConcluded'
                              : kind === 'checkoutCreateFailed'
                                ? 'checkoutCreateFailed'
                                : kind === 'checkoutPending'
                                  ? 'checkoutPending'
                                  : kind === 'idempotencyConflict'
                                    ? 'idempotencyConflict'
                                    : 'internalError';
    return sendOutcome(reply, name);
  }

  // -------------------------------------------------------------------------
  // Acquisition quote — the unit-less branch of the certified quote authority
  // -------------------------------------------------------------------------

  app.post(
    '/customer/entitlement-purchases/quote',
    {
      config: { authPolicy: 'authenticatedCustomer' },
      bodyLimit: BODY_LIMIT,
      schema: {
        body: Type.Object(
          { programId: Uuid, priceOptionId: Uuid, participantId: Uuid },
          { additionalProperties: false },
        ),
        response: { 201: Type.Object({ quote: EntitlementQuoteSchema }), ...ERRORS },
      },
    },
    async (request, reply) => {
      const accountId = accountOf(request);
      if (accountId === undefined) return sendOutcome(reply, 'notFound');
      const result = await requestEntitlementQuote(serviceDeps, { accountId }, request.body);
      if (result.kind !== 'quoteIssued') return failure(reply, result.kind);
      return reply.status(201).send({ quote: result.quote });
    },
  );

  // -------------------------------------------------------------------------
  // Zero-price acquisition — atomic Purchase + Entitlement, NO payment state
  // -------------------------------------------------------------------------

  app.post(
    '/customer/entitlement-purchases/confirm-free',
    {
      config: { authPolicy: 'authenticatedCustomer' },
      bodyLimit: BODY_LIMIT,
      schema: {
        body: Type.Object(
          { quoteId: Uuid, idempotencyKey: IdempotencyKey },
          { additionalProperties: false },
        ),
        response: { 201: Type.Object({ purchase: EntitlementPurchaseSchema }), ...ERRORS },
      },
    },
    async (request, reply) => {
      const accountId = accountOf(request);
      if (accountId === undefined) return sendOutcome(reply, 'notFound');
      const run = await confirmFreeEntitlementPurchase(serviceDeps, { accountId }, {
        quoteId: request.body.quoteId,
        idempotencyKey: request.body.idempotencyKey,
      });
      if (run.outcome.kind !== 'purchaseConfirmed') return failure(reply, run.outcome.kind);
      return reply.status(201).send({ purchase: run.outcome.purchase });
    },
  );

  // -------------------------------------------------------------------------
  // Paid acquisition initiation — the generalized W5 orchestration; the
  // customer supplies ONLY identifiers + the idempotency key.
  // -------------------------------------------------------------------------

  const EntitlementCheckoutStartedSchema = Type.Object({
    purchaseId: Uuid,
    /** Transient hosted-Checkout redirect — returned, never persisted. */
    redirectUrl: Type.String(),
    /** The purchase abandonment window (commercial metadata only). */
    expiresAt: Type.String(),
  });

  app.post(
    '/customer/entitlement-purchases/initiate',
    {
      config: { authPolicy: 'authenticatedCustomer' },
      bodyLimit: BODY_LIMIT,
      schema: {
        body: Type.Object(
          { quoteId: Uuid, idempotencyKey: IdempotencyKey },
          { additionalProperties: false },
        ),
        response: {
          201: Type.Object({ checkout: EntitlementCheckoutStartedSchema }),
          ...ERRORS,
        },
      },
    },
    async (request, reply) => {
      const accountId = accountOf(request);
      if (accountId === undefined) return sendOutcome(reply, 'notFound');
      const payment = deps.payment;
      if (
        payment === undefined ||
        payment.resolution.kind !== 'configured' ||
        payment.checkoutUrls === undefined
      ) {
        // Fail-closed: same posture as the certified Booking boundary —
        // typed refusal, zero mutations, no readiness flag.
        return sendOutcome(reply, 'paymentUnavailable');
      }
      const result = await startPaidEntitlementCheckout(
        { db: deps.db, provider: payment.resolution },
        { accountId },
        {
          quoteId: request.body.quoteId,
          idempotencyKey: request.body.idempotencyKey,
          returnUrl: payment.checkoutUrls.successUrl,
          cancelUrl: payment.checkoutUrls.cancelUrl,
        },
      );
      if (result.kind !== 'checkoutStarted') return failure(reply, result.kind);
      return reply.status(201).send({
        checkout: {
          purchaseId: result.purchaseId,
          redirectUrl: result.redirectUrl,
          expiresAt: result.purchaseExpiresAt.toISOString(),
        },
      });
    },
  );

  // -------------------------------------------------------------------------
  // Converged purchase payment status — pure read (the D-RI-5 vocabulary)
  // -------------------------------------------------------------------------

  app.get(
    '/customer/entitlement-purchases/:purchaseId/payment',
    {
      config: { authPolicy: 'authenticatedCustomer' },
      schema: {
        params: Type.Object({ purchaseId: Uuid }),
        response: {
          200: Type.Object({
            payment: Type.Object({
              status: Type.Union([
                Type.Literal('awaitingPayment'),
                Type.Literal('processing'),
                Type.Literal('confirmed'),
                Type.Literal('expired'),
                Type.Literal('compensationPending'),
                Type.Literal('compensated'),
              ]),
              purchaseExpiresAt: Type.Optional(Type.String()),
              referenceCode: Type.Optional(Type.String()),
            }),
          }),
          ...ERRORS,
        },
      },
    },
    async (request, reply) => {
      const accountId = accountOf(request);
      if (accountId === undefined) return sendOutcome(reply, 'notFound');
      const result = await customerEntitlementPurchasePaymentStatus(
        { db: deps.db },
        { accountId },
        { purchaseId: request.params.purchaseId },
      );
      if (result.kind !== 'paymentStatus') return failure(reply, result.kind);
      return reply.status(200).send({ payment: result.payment });
    },
  );

  // -------------------------------------------------------------------------
  // Own-purchase read (recovery/reconciliation for the acquisition flow)
  // -------------------------------------------------------------------------

  app.get(
    '/customer/entitlement-purchases/:purchaseId',
    {
      config: { authPolicy: 'authenticatedCustomer' },
      schema: {
        params: Type.Object({ purchaseId: Uuid }),
        response: { 200: Type.Object({ purchase: EntitlementPurchaseSchema }), ...ERRORS },
      },
    },
    async (request, reply) => {
      const accountId = accountOf(request);
      if (accountId === undefined) return sendOutcome(reply, 'notFound');
      const result = await getEntitlementPurchase(serviceDeps, { accountId }, {
        purchaseId: request.params.purchaseId,
      });
      if (result.kind !== 'purchase') return failure(reply, result.kind);
      return reply.status(200).send({ purchase: result.purchase });
    },
  );
}
