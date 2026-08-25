/**
 * RI-1 — the REAL HTTP adapters for the identity/session/participant
 * contracts. These are the only implementations that may be composed into
 * the running app (source-locked — no mock exists for these contracts).
 *
 * `createDevIdentityGateway` targets the backend's DEVELOPMENT-ONLY
 * /dev/identity token routes — the certified stand-in for the Cognito
 * client flows. Production sign-in (real Cognito email/password + Sign in
 * with Apple + Google, D-RI-3) replaces ONLY this gateway in composition;
 * `SessionApi`/`ParticipantApi` are the certified contracts and never
 * change with the identity provider.
 */
import type {
  CustomerProfile,
  IdentityGateway,
  IdentityTokens,
  ParticipantApi,
  ParticipantProfile,
  SessionApi,
} from '@/services/contracts/identity';
import type { HttpClient } from '@/services/http/http-client';

export function createDevIdentityGateway(client: HttpClient): IdentityGateway {
  return {
    async signUp(input) {
      return client.request<IdentityTokens>('POST', '/dev/identity/signup', {
        body: input,
        auth: false,
      });
    },
    async signIn(input) {
      return client.request<IdentityTokens>('POST', '/dev/identity/signin', {
        body: input,
        auth: false,
      });
    },
    async refresh(refreshToken) {
      return client.request<{ accessToken: string; expiresAt: string }>(
        'POST',
        '/dev/identity/refresh',
        { body: { refreshToken }, auth: false },
      );
    },
  };
}

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
