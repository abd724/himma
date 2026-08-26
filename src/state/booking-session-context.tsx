import { BookingCommerceController, type HoldIntent } from '@/features/booking/commerce-session';
import { commerceApi } from '@/services/composition';
import type { BookingDraft, BookingSummary } from '@/services/contracts/booking';
import type { CheckoutIssueCode } from '@/services/contracts/checkout';
import type { CapacityHold } from '@/services/contracts/commerce';
import type { ParticipantId } from '@/types/domain';
import {
  createContext,
  useCallback,
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
  /**
   * RI-3 — the flow's commerce state. ONE authoritative quote travels
   * summary → hold → checkout (never re-derived behind the customer's
   * back); the controller owns the stable idempotency keys and the hold
   * lifecycle discipline.
   */
  commerce: BookingCommerceController;
  /** The summary (with its server quote) the flow is committing to. */
  summary: BookingSummary | null;
  setSummary: (summary: BookingSummary | null) => void;
  /** The authoritative hold, reactive for countdown/CTA rendering. */
  hold: CapacityHold | undefined;
  /** Claim (or idempotently reuse) the hold for the stored summary. */
  claimHold: (intent: HoldIntent) => Promise<CapacityHold>;
  /** Explicit, idempotent abandonment of the current hold. */
  releaseHold: () => Promise<void>;
  /** Forget hold state after the server consumed/expired it. */
  forgetHold: () => void;
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

  // RI-3 commerce state — same lifetime as the draft (flow-scoped).
  const [commerce] = useState(() => new BookingCommerceController(commerceApi));
  const [summary, setSummary] = useState<BookingSummary | null>(null);
  const [hold, setHold] = useState<CapacityHold | undefined>(undefined);

  const claimHold = useCallback(
    async (intent: HoldIntent) => {
      const claimed = await commerce.ensureHold(intent);
      setHold(claimed);
      return claimed;
    },
    [commerce],
  );

  const releaseHold = useCallback(async () => {
    setHold(undefined);
    await commerce.releaseCurrentHold();
  }, [commerce]);

  const forgetHold = useCallback(() => {
    setHold(undefined);
    commerce.forgetHold();
  }, [commerce]);

  // A MATERIAL draft change (option/session/participant) abandons the
  // current hold explicitly IN THE EVENT HANDLER — never silently kept,
  // never a duplicate claim on rerender (owner RI-3 §9/§10). Expiry stays
  // authoritative if the release call is ever lost.
  const guardedDispatch = useCallback(
    (action: BookingDraftAction) => {
      const signature = commerce.currentSignature;
      if (signature !== undefined) {
        const [, optionId, , unitId, participantId] = signature.split('|');
        const changes =
          (action.type === 'selectOption' && action.optionId !== optionId) ||
          (action.type === 'selectSession' && action.sessionId !== unitId) ||
          (action.type === 'selectParticipant' &&
            String(action.participantId) !== participantId) ||
          action.type === 'reset';
        if (changes) {
          setHold(undefined);
          setSummary(null);
          void commerce.releaseCurrentHold();
        }
      }
      dispatch(action);
    },
    [commerce],
  );

  const value = useMemo(
    () => ({
      draft,
      dispatch: guardedDispatch,
      qaRevalidate,
      commerce,
      summary,
      setSummary,
      hold,
      claimHold,
      releaseHold,
      forgetHold,
    }),
    [draft, guardedDispatch, qaRevalidate, commerce, summary, hold, claimHold, releaseHold, forgetHold],
  );
  return (
    <BookingSessionContext.Provider value={value}>{children}</BookingSessionContext.Provider>
  );
}

export function useBookingSession(): BookingSessionContextValue {
  const value = useContext(BookingSessionContext);
  if (value === undefined) throw new Error('useBookingSession requires BookingSessionProvider');
  return value;
}
