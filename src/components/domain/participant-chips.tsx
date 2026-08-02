import { Chip } from '@/components/ui/chip';
import { colors, pagePadding, spacing, typography } from '@/theme';
import type { Participant, ParticipantId } from '@/types/domain';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

interface Props {
  participants: Participant[];
  selectedId: ParticipantId;
  onSelect: (id: ParticipantId) => void;
}

/** Lightweight browsing context — not a profile switch (docs/02 §7). */
export function ParticipantChips({ participants, selectedId, onSelect }: Props) {
  return (
    <View style={styles.wrap}>
      <Text style={styles.caption}>Browsing for</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
        {participants.map((participant) => (
          <Chip
            key={participant.id}
            label={participant.label}
            icon={participant.kind === 'everyone' ? 'people-outline' : undefined}
            selected={participant.id === selectedId}
            onPress={() => onSelect(participant.id)}
            accessibilityHint={`Shows activities for ${participant.label}`}
          />
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: spacing.sm,
  },
  caption: {
    ...typography.caption,
    color: colors.text.secondary,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    paddingHorizontal: pagePadding,
  },
  row: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: pagePadding,
  },
});
