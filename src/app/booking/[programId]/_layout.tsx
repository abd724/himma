import { BookingSessionProvider, qaRevalidateFromParam } from '@/state/booking-session-context';
import { colors } from '@/theme';
import { Stack, useGlobalSearchParams, useLocalSearchParams } from 'expo-router';

/**
 * Booking flow stack — docs/21 §3. Root-level (dock hidden structurally);
 * the BookingSessionProvider mounts here so the draft's lifetime equals the
 * flow's lifetime (docs/09 §21.13) and each program gets its own fresh draft.
 */
export default function BookingLayout() {
  const params = useLocalSearchParams<{ programId?: string }>();
  const programId = typeof params.programId === 'string' ? params.programId : '';
  // Dev-only review affordance (docs/22 §7.10) — rides the flow's entry URL.
  // Global (not local) search params: query params belong to the focused
  // route, and the layout's own params never include them on native.
  const globalParams = useGlobalSearchParams<{ 'qa-revalidate'?: string }>();
  const qaRevalidate = __DEV__ ? qaRevalidateFromParam(globalParams['qa-revalidate']) : undefined;

  return (
    <BookingSessionProvider key={programId} programId={programId} qaRevalidate={qaRevalidate}>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.background.main },
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="participant" />
        <Stack.Screen name="summary" />
        <Stack.Screen name="checkout" />
      </Stack>
    </BookingSessionProvider>
  );
}
