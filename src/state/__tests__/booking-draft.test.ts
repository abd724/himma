import { describe, expect, test } from '@jest/globals';
import type { BookingDraft } from '@/services/contracts/booking';
import { draftReducer } from '@/state/booking-session-context';

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
