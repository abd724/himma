/**
 * RI-1 — the real participant-profile store (docs/34 §7 RI-1). PostgreSQL
 * is authoritative: the list loads from the backend whenever a customer is
 * authenticated, every mutation applies the SERVER-RETURNED row (no
 * optimistic fiction — a failed create/update changes nothing), and the
 * state survives app reloads because the truth was never local.
 */
import { participantApi } from '@/services/composition';
import type { ParticipantProfile } from '@/services/contracts/identity';
import { useAuth } from '@/state/auth-context';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from 'react';

export type ProfilesStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface ProfilesContextValue {
  status: ProfilesStatus;
  /** Active participant profiles (self first) — [] until `ready`. */
  profiles: ParticipantProfile[];
  reload(): void;
  createChild(input: { firstName: string; dateOfBirth: string }): Promise<ParticipantProfile>;
  update(
    participantId: string,
    input: { version: number; firstName?: string; dateOfBirth?: string },
  ): Promise<ParticipantProfile>;
  archive(participantId: string, version: number): Promise<ParticipantProfile>;
}

const ProfilesContext = createContext<ProfilesContextValue | undefined>(undefined);

export function ProfilesProvider({ children }: PropsWithChildren) {
  const auth = useAuth();
  const [status, setStatus] = useState<ProfilesStatus>('idle');
  const [profiles, setProfiles] = useState<ParticipantProfile[]>([]);
  const [loadAttempt, setLoadAttempt] = useState(0);

  const authenticated = auth.status === 'authenticated';

  // Auth transitions adjust state during render (the React-endorsed
  // pattern) so the fetch effect performs no synchronous state writes.
  const [prevAuthenticated, setPrevAuthenticated] = useState(authenticated);
  if (prevAuthenticated !== authenticated) {
    setPrevAuthenticated(authenticated);
    if (authenticated) {
      setStatus('loading');
    } else {
      setStatus('idle');
      setProfiles([]);
    }
  }

  useEffect(() => {
    if (!authenticated) return;
    let cancelled = false;
    participantApi.list().then(
      (rows) => {
        if (cancelled) return;
        setProfiles(rows);
        setStatus('ready');
      },
      () => {
        if (!cancelled) setStatus('error');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [authenticated, loadAttempt]);

  const replaceRow = useCallback((row: ParticipantProfile) => {
    setProfiles((current) => {
      const archivedGone = row.status === 'archived';
      const exists = current.some((profile) => profile.id === row.id);
      if (archivedGone) return current.filter((profile) => profile.id !== row.id);
      if (!exists) return [...current, row];
      return current.map((profile) => (profile.id === row.id ? row : profile));
    });
  }, []);

  const value = useMemo<ProfilesContextValue>(
    () => ({
      status,
      profiles,
      reload() {
        setStatus('loading');
        setLoadAttempt((attempt) => attempt + 1);
      },
      async createChild(input) {
        const created = await participantApi.createChild(input);
        replaceRow(created);
        return created;
      },
      async update(participantId, input) {
        const updated = await participantApi.update(participantId, input);
        replaceRow(updated);
        return updated;
      },
      async archive(participantId, version) {
        const archived = await participantApi.archive(participantId, version);
        replaceRow(archived);
        return archived;
      },
    }),
    [status, profiles, replaceRow],
  );

  return <ProfilesContext.Provider value={value}>{children}</ProfilesContext.Provider>;
}

export function useProfiles(): ProfilesContextValue {
  const value = useContext(ProfilesContext);
  if (value === undefined) throw new Error('useProfiles requires ProfilesProvider');
  return value;
}
