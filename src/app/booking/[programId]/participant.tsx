import { bookingHref } from '@/features/booking/booking-navigation';
import { Redirect, useLocalSearchParams } from 'expo-router';

/**
 * Participant step — implemented in Commit 13 (docs/21 §18). Until then this
 * stub redirects to the flow start so deep links never dead-end and no
 * placeholder screen exists (docs/09 §17.2).
 */
export default function BookingParticipantRoute() {
  const params = useLocalSearchParams<{ programId?: string }>();
  const programId = typeof params.programId === 'string' ? params.programId : '';
  return <Redirect href={bookingHref(programId)} />;
}
