import { BookingSessionProvider } from '@/state/booking-session-context';
import { colors } from '@/theme';
import { Stack, useLocalSearchParams } from 'expo-router';

/**
 * Booking flow stack — docs/21 §3. Root-level (dock hidden structurally);
 * the BookingSessionProvider mounts here so the draft's lifetime equals the
 * flow's lifetime (docs/09 §21.13) and each program gets its own fresh draft.
 */
export default function BookingLayout() {
  const params = useLocalSearchParams<{ programId?: string }>();
  const programId = typeof params.programId === 'string' ? params.programId : '';

  return (
    <BookingSessionProvider key={programId} programId={programId}>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.background.main },
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="participant" />
        <Stack.Screen name="summary" />
      </Stack>
    </BookingSessionProvider>
  );
}
