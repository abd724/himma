/**
 * RI-1 — the REAL HTTP adapters for the identity/session/participant
 * contracts. These are the only implementations that may be composed into
 * the running app (source-locked — no mock exists for these contracts).
 *
 * RI-6: the DEVELOPMENT-ONLY token gateway moved to its own module
 * (dev-identity-gateway.ts) loaded lazily behind `__DEV__` — a production
 * bundle contains no /dev/identity wire at all. `SessionApi`/
 * `ParticipantApi` are the certified contracts and never change with the
 * identity provider.
 */
import type {
  CustomerProfile,
  ParticipantApi,
  ParticipantProfile,
  SessionApi,
} from '@/services/contracts/identity';
import type { HttpClient } from '@/services/http/http-client';

export function createSessionApi(client: HttpClient): SessionApi {
  return {
    async establishSession(input) {
      const response = await client.request<{
        status: 'authenticated';
        userId: string;
        accountId?: string;
        session: { id: string; expiresAt: string };
      }>('POST', '/auth/session', { body: input, auth: false });
      return {
        userId: response.userId,
        ...(response.accountId !== undefined ? { accountId: response.accountId } : {}),
        sessionId: response.session.id,
        expiresAt: response.session.expiresAt,
      };
    },
    async me() {
      return client.request<CustomerProfile>('GET', '/me');
    },
    async logout() {
      await client.request<{ status: string }>('POST', '/auth/logout', { body: {} });
    },
  };
}

export function createParticipantApi(client: HttpClient): ParticipantApi {
  return {
    async list() {
      const response = await client.request<{ participants: ParticipantProfile[] }>(
        'GET',
        '/customer/participants',
      );
      return response.participants;
    },
    async createChild(input) {
      const response = await client.request<{ participant: ParticipantProfile }>(
        'POST',
        '/customer/participants',
        { body: input },
      );
      return response.participant;
    },
    async update(participantId, input) {
      const response = await client.request<{ participant: ParticipantProfile }>(
        'PATCH',
        `/customer/participants/${participantId}`,
        { body: input },
      );
      return response.participant;
    },
    async archive(participantId, version) {
      const response = await client.request<{ participant: ParticipantProfile }>(
        'POST',
        `/customer/participants/${participantId}/archive`,
        { body: { version } },
      );
      return response.participant;
    },
  };
}
