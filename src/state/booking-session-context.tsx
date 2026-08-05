import type { BookingDraft } from '@/services/contracts/booking';
import type { CheckoutIssueCode } from '@/services/contracts/checkout';
import type { ParticipantId } from '@/types/domain';
import {
  createContext,
  useContext,
  useMemo,
  useReducer,
  useState,
  type PropsWithChildren,
} from 'react';

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

/**
 * QA review-state selection — docs/22 §7.10, docs/09 §22.10: the mid-checkout
 * revalidation states are reachable only via `?qa-revalidate` on the flow's
 * entry URL (established `?qa-*` pattern; pushed routes drop search params,
 * so the value is captured once at flow entry, exactly like the
 * account-context `?qa-scenario` capture). The value arrives as an Expo
 * Router param from the booking layout, so web URLs and native deep links
 * (cold and warm) behave identically; the layout's `__DEV__` gate keeps it
 * out of production behavior. Review/QA only — deterministic demonstrations
 * of the future backend contract; never customer-reachable, no implied live
 * polling, no simulated contention. All declared issue codes are
 * review-reachable so every CheckoutIssueCard design can be inspected
 * (owner-directed visual review, 2026-08-05).
 */
const QA_REVALIDATE_CODES = [
  'sessionFull',
  'registrationClosed',
  'priceChanged',
  'offerExpired',
  'participantIneligible',
  'branchUnavailable',
  'invalidDraft',
] as const;

/** Router-param form: validates a `useLocalSearchParams` value. */
export function qaRevalidateFromParam(value: unknown): CheckoutIssueCode | undefined {
  const single = Array.isArray(value) ? value[0] : value;
  return QA_REVALIDATE_CODES.find((code) => code === single);
}

interface BookingSessionContextValue {
  draft: BookingDraft;
  dispatch: (action: BookingDraftAction) => void;
  /** QA-only review-state code captured at flow entry; undefined otherwise. */
  qaRevalidate: CheckoutIssueCode | undefined;
}

const BookingSessionContext = createContext<BookingSessionContextValue | undefined>(undefined);

export function BookingSessionProvider({
  programId,
  qaRevalidate: qaRevalidateParam,
  children,
}: PropsWithChildren<{ programId: string; qaRevalidate?: CheckoutIssueCode }>) {
  const [draft, dispatch] = useReducer(draftReducer, { programId });
  // First-valid-wins latch, discarded with the flow like the draft (the
  // layout remounts this provider per program via `key`). Native navigation
  // state hydrates a render after mount, so a mount-time capture would miss
  // cold deep links; once latched the value never changes for the flow's
  // lifetime — the same boundary as the previous entry-URL capture.
  const [qaRevalidate, setQaRevalidate] = useState(qaRevalidateParam);
  if (qaRevalidate === undefined && qaRevalidateParam !== undefined) {
    setQaRevalidate(qaRevalidateParam);
  }
  const value = useMemo(() => ({ draft, dispatch, qaRevalidate }), [draft, qaRevalidate]);
  return (
    <BookingSessionContext.Provider value={value}>{children}</BookingSessionContext.Provider>
  );
}

export function useBookingSession(): BookingSessionContextValue {
  const value = useContext(BookingSessionContext);
  if (value === undefined) throw new Error('useBookingSession requires BookingSessionProvider');
  return value;
}
