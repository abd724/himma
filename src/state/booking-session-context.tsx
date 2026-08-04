import type { BookingDraft } from '@/services/contracts/booking';
import type { ParticipantId } from '@/types/domain';
import { createContext, useContext, useMemo, useReducer, type PropsWithChildren } from 'react';

/**
 * Temporary booking-draft state — docs/21 §10, docs/09 §21.13. Mounted inside
 * the booking stack's layout, so the draft's lifetime equals the flow's
 * lifetime: leaving the flow (back, exit, switching program, reload, app
 * termination) discards it structurally. In-memory only — never persisted,
 * never written to any other provider.
 */
export type BookingDraftAction =
  | { type: 'selectOption'; optionId: string }
  | { type: 'selectSession'; sessionId: string }
  | { type: 'selectParticipant'; participantId: ParticipantId }
  | { type: 'preselectParticipant'; participantId: ParticipantId }
  | { type: 'reset' };

/** Pure reducer — the unit-test surface (established pure-core pattern). */
export function draftReducer(draft: BookingDraft, action: BookingDraftAction): BookingDraft {
  switch (action.type) {
    case 'selectOption':
      if (action.optionId === draft.optionId) return draft;
      // Switching option invalidates any session picked under the old one.
      return { programId: draft.programId, optionId: action.optionId, participantId: draft.participantId };
    case 'selectSession':
      return { ...draft, sessionId: action.sessionId };
    case 'selectParticipant':
      return { ...draft, participantId: action.participantId };
    case 'preselectParticipant':
      // docs/21 §2: preselection never overrides an explicit user choice.
      return draft.participantId === undefined
        ? { ...draft, participantId: action.participantId }
        : draft;
    case 'reset':
      return { programId: draft.programId };
  }
}

interface BookingSessionContextValue {
  draft: BookingDraft;
  dispatch: (action: BookingDraftAction) => void;
}

const BookingSessionContext = createContext<BookingSessionContextValue | undefined>(undefined);

export function BookingSessionProvider({
  programId,
  children,
}: PropsWithChildren<{ programId: string }>) {
  const [draft, dispatch] = useReducer(draftReducer, { programId });
  const value = useMemo(() => ({ draft, dispatch }), [draft]);
  return (
    <BookingSessionContext.Provider value={value}>{children}</BookingSessionContext.Provider>
  );
}

export function useBookingSession(): BookingSessionContextValue {
  const value = useContext(BookingSessionContext);
  if (value === undefined) throw new Error('useBookingSession requires BookingSessionProvider');
  return value;
}
