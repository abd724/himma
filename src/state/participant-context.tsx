import { useAccount } from '@/state/account-context';
import type { Participant, ParticipantId } from '@/types/domain';
import { createContext, useContext, useMemo, useState, type PropsWithChildren } from 'react';

interface ParticipantContextValue {
  participants: Participant[];
  participantId: ParticipantId;
  setParticipantId: (id: ParticipantId) => void;
}

const ParticipantContext = createContext<ParticipantContextValue | undefined>(undefined);

/** The structural browsing-context entry — not a person, never persisted. */
const everyone: Participant = { id: 'everyone', label: 'Everyone', kind: 'everyone' };

/**
 * One app-level browsing context shared by Discover, Search, and Results —
 * docs/02 §7, docs/16 §4. Home is context-complete and ignores it
 * (docs/18 §8). The browsing list derives from the account's real
 * participant list ('Everyone' + account participants); a guest has no
 * participant chips.
 */
export function ParticipantProvider({ children }: PropsWithChildren) {
  const account = useAccount();
  const [participantId, setParticipantId] = useState<ParticipantId>('everyone');
  const value = useMemo(
    () => ({
      participants: account.account === null ? [] : [everyone, ...account.participants],
      participantId,
      setParticipantId,
    }),
    [account, participantId],
  );
  return <ParticipantContext.Provider value={value}>{children}</ParticipantContext.Provider>;
}

export function useParticipantContext(): ParticipantContextValue {
  const value = useContext(ParticipantContext);
  if (value === undefined) throw new Error('useParticipantContext requires ParticipantProvider');
  return value;
}
