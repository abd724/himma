/**
 * RI-1 — customer identity, session, and participant contracts (docs/34
 * §7 RI-1). These are the first REAL-API contracts in the app: no mock
 * implementation exists or may exist for them (source-locked) — the app
 * composition binds them to the HTTP adapters, and tests use local
 * doubles.
 *
 * `IdentityGateway` is TOKEN ACQUISITION — the stand-in for the Cognito
 * client flows (dev: the backend's /dev/identity routes; production: the
 * real Cognito pool later, swapped in composition only). `SessionApi` and
 * `ParticipantApi` are the certified Himma backend contracts.
 */

/** Provider token material as a Cognito client SDK would hold it. */
export interface IdentityTokens {
  accessToken: string;
  idToken?: string;
  refreshToken?: string;
  /** ISO instant the access token expires. */
  expiresAt: string;
}

export interface IdentityGateway {
  signUp(input: {
    email: string;
    password: string;
    displayName?: string;
  }): Promise<IdentityTokens>;
  signIn(input: { email: string; password: string }): Promise<IdentityTokens>;
  refresh(refreshToken: string): Promise<{ accessToken: string; expiresAt: string }>;
}

export interface EstablishedSession {
  userId: string;
  accountId?: string;
  sessionId: string;
  expiresAt: string;
}

export interface CustomerProfile {
  user: { id: string };
  account?: { id: string; displayName: string; contactEmail: string | null };
  participants: { id: string; kind: 'self'; firstName: string }[];
}

export interface SessionApi {
  /** `POST /auth/session` — first login + Himma session establishment. */
  establishSession(input: {
    accessToken: string;
    idToken?: string;
    deviceLabel?: string;
  }): Promise<EstablishedSession>;
  /** `GET /me` (bearer). */
  me(): Promise<CustomerProfile>;
  /** `POST /auth/logout` (bearer) — ends the CURRENT Himma session. */
  logout(): Promise<void>;
}

export interface ParticipantProfile {
  id: string;
  kind: 'self' | 'child';
  firstName: string;
  /** ISO date (YYYY-MM-DD); null for a self profile without one. */
  dateOfBirth: string | null;
  status: 'active' | 'archived';
  version: number;
}

export interface ParticipantApi {
  list(): Promise<ParticipantProfile[]>;
  createChild(input: { firstName: string; dateOfBirth: string }): Promise<ParticipantProfile>;
  update(
    participantId: string,
    input: { version: number; firstName?: string; dateOfBirth?: string },
  ): Promise<ParticipantProfile>;
  archive(participantId: string, version: number): Promise<ParticipantProfile>;
}
