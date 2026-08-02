import { participants } from '@/data/mock/catalogue';
import type { Participant, ParticipantId } from '@/types/domain';
import { createContext, useContext, useMemo, useState, type PropsWithChildren } from 'react';

interface ParticipantContextValue {
  participants: Participant[];
  participantId: ParticipantId;
  setParticipantId: (id: ParticipantId) => void;
}

const ParticipantContext = createContext<ParticipantContextValue | undefined>(undefined);

/**
 * One app-level browsing context shared by Home, Discover, Search, and
 * Results — docs/02 §7, docs/16 §4. Changing it anywhere changes it everywhere.
 */
export function ParticipantProvider({ children }: PropsWithChildren) {
  const [participantId, setParticipantId] = useState<ParticipantId>('everyone');
  const value = useMemo(
    () => ({ participants, participantId, setParticipantId }),
    [participantId],
  );
  return <ParticipantContext.Provider value={value}>{children}</ParticipantContext.Provider>;
}

export function useParticipantContext(): ParticipantContextValue {
  const value = useContext(ParticipantContext);
  if (value === undefined) throw new Error('useParticipantContext requires ParticipantProvider');
  return value;
}
