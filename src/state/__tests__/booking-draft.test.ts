import { describe, expect, test } from '@jest/globals';
import type { BookingDraft } from '@/services/contracts/booking';
import { draftReducer, qaRevalidateFromSearch } from '@/state/booking-session-context';

/**
 * Booking draft reducer — docs/21 §10. The draft is in-memory flow state
 * only (docs/09 §21.13); these tests pin its transitions.
 */
const start: BookingDraft = { programId: 'beginner-calisthenics' };

describe('draftReducer', () => {
  test('selectOption sets the option and keeps the participant', () => {
    const withParticipant = draftReducer(start, {
      type: 'selectParticipant',
      participantId: 'adam',
    });
    const next = draftReducer(withParticipant, { type: 'selectOption', optionId: 'option-a' });
    expect(next).toEqual({
      programId: 'beginner-calisthenics',
      optionId: 'option-a',
      participantId: 'adam',
    });
  });

  test('switching option clears a stale session choice', () => {
    const chosen = draftReducer(
      draftReducer(start, { type: 'selectOption', optionId: 'option-a' }),
      { type: 'selectSession', sessionId: 'session-1' },
    );
    const switched = draftReducer(chosen, { type: 'selectOption', optionId: 'option-b' });
    expect(switched.optionId).toBe('option-b');
    expect(switched.sessionId).toBeUndefined();
  });

  test('re-selecting the same option is a no-op that keeps the session', () => {
    const chosen = draftReducer(
      draftReducer(start, { type: 'selectOption', optionId: 'option-a' }),
      { type: 'selectSession', sessionId: 'session-1' },
    );
    expect(draftReducer(chosen, { type: 'selectOption', optionId: 'option-a' })).toBe(chosen);
  });

  test('selectSession and selectParticipant set their single fields', () => {
    const next = draftReducer(
      draftReducer(start, { type: 'selectSession', sessionId: 'session-1' }),
      { type: 'selectParticipant', participantId: 'me' },
    );
    expect(next.sessionId).toBe('session-1');
    // One participant per booking: a single id, never a list (docs/09 §21.2).
    expect(next.participantId).toBe('me');
  });

  test('preselection fills an empty choice but never overrides the user', () => {
    const preselected = draftReducer(start, {
      type: 'preselectParticipant',
      participantId: 'adam',
    });
    expect(preselected.participantId).toBe('adam');
    const explicit = draftReducer(preselected, { type: 'selectParticipant', participantId: 'me' });
    // A re-run of preselection (screen reload, participant-context change)
    // must not silently switch the user's explicit choice (docs/09 §21.15).
    expect(
      draftReducer(explicit, { type: 'preselectParticipant', participantId: 'adam' }),
    ).toBe(explicit);
  });

  test('participant selection preserves the chosen option and session', () => {
    const complete = draftReducer(
      draftReducer(start, { type: 'selectOption', optionId: 'option-a' }),
      { type: 'selectSession', sessionId: 'session-1' },
    );
    const withParticipant = draftReducer(complete, {
      type: 'selectParticipant',
      participantId: 'adam',
    });
    expect(withParticipant.optionId).toBe('option-a');
    expect(withParticipant.sessionId).toBe('session-1');
  });

  test('a later participant choice replaces the earlier one', () => {
    const next = draftReducer(
      draftReducer(start, { type: 'selectParticipant', participantId: 'me' }),
      { type: 'selectParticipant', participantId: 'adam' },
    );
    expect(next.participantId).toBe('adam');
  });

  test('reset returns to the empty per-program draft', () => {
    const busy = draftReducer(
      draftReducer(
        draftReducer(start, { type: 'selectOption', optionId: 'option-a' }),
        { type: 'selectSession', sessionId: 'session-1' },
      ),
      { type: 'selectParticipant', participantId: 'me' },
    );
    expect(draftReducer(busy, { type: 'reset' })).toEqual({
      programId: 'beginner-calisthenics',
    });
  });
});

describe('qaRevalidateFromSearch (Commit 18, docs/22 §7.10)', () => {
  test('accepts the spec review codes', () => {
    expect(qaRevalidateFromSearch('?qa-revalidate=sessionFull')).toBe('sessionFull');
    expect(qaRevalidateFromSearch('?qa-revalidate=priceChanged')).toBe('priceChanged');
    expect(qaRevalidateFromSearch('?qa-revalidate=offerExpired')).toBe('offerExpired');
  });

  test('every declared code is review-reachable (owner-directed visual review)', () => {
    expect(qaRevalidateFromSearch('?qa-revalidate=invalidDraft')).toBe('invalidDraft');
    expect(qaRevalidateFromSearch('?qa-revalidate=participantIneligible')).toBe(
      'participantIneligible',
    );
    expect(qaRevalidateFromSearch('?qa-revalidate=registrationClosed')).toBe('registrationClosed');
    expect(qaRevalidateFromSearch('?qa-revalidate=branchUnavailable')).toBe('branchUnavailable');
  });

  test('garbage, empty, and absent values resolve undefined', () => {
    expect(qaRevalidateFromSearch('?qa-revalidate=nonsense')).toBeUndefined();
    expect(qaRevalidateFromSearch('?qa-revalidate=')).toBeUndefined();
    expect(qaRevalidateFromSearch('?other=1')).toBeUndefined();
    expect(qaRevalidateFromSearch('')).toBeUndefined();
    expect(qaRevalidateFromSearch(undefined)).toBeUndefined();
  });

  test('composes with other qa params', () => {
    expect(qaRevalidateFromSearch('?qa-scenario=household&qa-revalidate=sessionFull')).toBe(
      'sessionFull',
    );
  });
});
