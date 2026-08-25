/**
 * RI-1 — shared form primitives for the auth/account surfaces (HMA-003 /
 * HMA-030 scope), styled strictly from the existing token system: the
 * search-field input treatment, the booking primary-action button, and
 * the standard error/loading vocabulary. No new visual language.
 */
import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { colors, fontFamily, radii, spacing, typography } from '@/theme';
import { ActivityIndicator, StyleSheet, Text, TextInput, View } from 'react-native';
import type { ComponentProps } from 'react';

export function FormField(props: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  secureTextEntry?: boolean;
  autoCapitalize?: ComponentProps<typeof TextInput>['autoCapitalize'];
  keyboardType?: ComponentProps<typeof TextInput>['keyboardType'];
  autoComplete?: ComponentProps<typeof TextInput>['autoComplete'];
  accessibilityLabel?: string;
  testID?: string;
}) {
  return (
    <View style={styles.fieldGroup}>
      <Text style={styles.fieldLabel}>{props.label}</Text>
      <View style={styles.field}>
        <TextInput
          style={styles.input}
          value={props.value}
          onChangeText={props.onChangeText}
          placeholder={props.placeholder}
          placeholderTextColor={colors.text.secondary}
          secureTextEntry={props.secureTextEntry}
          autoCapitalize={props.autoCapitalize ?? 'none'}
          keyboardType={props.keyboardType}
          autoComplete={props.autoComplete}
          accessibilityLabel={props.accessibilityLabel ?? props.label}
          testID={props.testID}
        />
      </View>
    </View>
  );
}

export function PrimaryButton(props: {
  label: string;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
  testID?: string;
}) {
  const inactive = props.disabled === true || props.busy === true;
  return (
    <PressableFeedback
      onPress={inactive ? undefined : props.onPress}
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: inactive, busy: props.busy === true }}
      style={[styles.primaryAction, inactive ? styles.primaryActionDisabled : null]}
      testID={props.testID}
    >
      {props.busy === true ? (
        <ActivityIndicator color={colors.text.inverse} />
      ) : (
        <Text style={styles.primaryActionLabel}>{props.label}</Text>
      )}
    </PressableFeedback>
  );
}

export function FormError(props: { message: string | null }) {
  if (props.message === null) return null;
  return (
    <Text accessibilityRole="alert" style={styles.error} testID="form-error">
      {props.message}
    </Text>
  );
}

const styles = StyleSheet.create({
  fieldGroup: { gap: spacing.xs },
  fieldLabel: {
    ...typography.caption,
    color: colors.text.secondary,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 52,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.search,
    backgroundColor: colors.background.elevated,
    borderWidth: 1,
    borderColor: colors.border.default,
  },
  input: {
    flex: 1,
    ...typography.searchInput,
    color: colors.text.primary,
    paddingVertical: 0,
  },
  primaryAction: {
    minHeight: 52,
    borderRadius: radii.search,
    backgroundColor: colors.brand.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryActionDisabled: { opacity: 0.5 },
  primaryActionLabel: {
    ...typography.chip,
    fontFamily: fontFamily.bold,
    color: colors.text.inverse,
  },
  error: {
    ...typography.caption,
    color: colors.status.error,
  },
});
