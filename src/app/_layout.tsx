import { AccountProvider } from '@/state/account-context';
import { AreaProvider } from '@/state/area-context';
import { AuthProvider } from '@/state/auth-context';
import { FavouritesProvider } from '@/state/favourites-context';
import { ParticipantProvider } from '@/state/participant-context';
import { ProfilesProvider } from '@/state/profiles-context';
import { ResultsSessionProvider } from '@/state/results-session-context';
import { colors } from '@/theme';
import {
  Manrope_400Regular,
  Manrope_500Medium,
  Manrope_600SemiBold,
  Manrope_700Bold,
  Manrope_800ExtraBold,
  useFonts,
} from '@expo-google-fonts/manrope';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    Manrope_400Regular,
    Manrope_500Medium,
    Manrope_600SemiBold,
    Manrope_700Bold,
    Manrope_800ExtraBold,
  });

  useEffect(() => {
    if (fontsLoaded) SplashScreen.hideAsync();
  }, [fontsLoaded]);

  if (!fontsLoaded) return null;

  return (
    <SafeAreaProvider>
      <AuthProvider>
      <ProfilesProvider>
      <AccountProvider>
      <ParticipantProvider>
        <AreaProvider>
          <FavouritesProvider>
            <ResultsSessionProvider>
            <View style={{ flex: 1, backgroundColor: colors.background.main }}>
              <StatusBar style="dark" />
              {/* Search, Map, and detail surfaces are root-level pushes: the
                  dock (owned by the tab navigator) is hidden on them
                  structurally — docs/16 §6, docs/20 §2.1. */}
              <Stack
                screenOptions={{
                  headerShown: false,
                  contentStyle: { backgroundColor: colors.background.main },
                }}
              >
                <Stack.Screen name="(tabs)" />
                <Stack.Screen name="auth/sign-in" />
                <Stack.Screen name="auth/sign-up" />
                <Stack.Screen name="account/participants/index" />
                <Stack.Screen name="account/participants/new" />
                <Stack.Screen name="account/participants/[participantId]" />
                <Stack.Screen name="search" />
                <Stack.Screen name="map" />
                <Stack.Screen name="program/[programId]" />
                <Stack.Screen name="provider/[providerId]" />
                <Stack.Screen name="booking/[programId]" />
                <Stack.Screen name="bookings/return" />
                <Stack.Screen name="bookings/status/[bookingId]" />
                <Stack.Screen name="bookings/confirmed/[bookingId]" />
                <Stack.Screen name="bookings/check-in/[bookingId]" />
                <Stack.Screen name="bookings/[bookingId]" />
                <Stack.Screen name="passes/[entitlementId]" />
                <Stack.Screen name="passes/reserve/[entitlementId]" />
                <Stack.Screen name="passes/status/[purchaseId]" />
                <Stack.Screen name="checkin/[credentialId]" />
              </Stack>
            </View>
            </ResultsSessionProvider>
          </FavouritesProvider>
        </AreaProvider>
      </ParticipantProvider>
      </AccountProvider>
      </ProfilesProvider>
      </AuthProvider>
    </SafeAreaProvider>
  );
}
