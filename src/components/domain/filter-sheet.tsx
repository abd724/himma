import { Chip } from '@/components/ui/chip';
import { PressableFeedback } from '@/components/ui/pressable-feedback';
import { activityTypes, areas, categories } from '@/data/mock/catalogue';
import type { FilterSelection, PriceBand, ProgramFormatFilter } from '@/services/contracts/filters';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { colors, fontFamily, radii, shadows, spacing, typography } from '@/theme';
import type { CategoryId, SkillLevel } from '@/types/domain';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface Props {
  visible: boolean;
  filters: FilterSelection;
  resultCount: number;
  onChange: (filters: FilterSelection) => void;
  onClearAll: () => void;
  onClose: () => void;
  /**
   * Called by the primary "Show N results" action instead of onClose when a
   * surface applies to a new destination (Discover → Results handoff).
   * Backdrop tap and Android back always call onClose (cancel).
   */
  onApply?: () => void;
}

const formatOptions: { id: ProgramFormatFilter; label: string }[] = [
  { id: 'dropIn', label: 'Drop-in' },
  { id: 'monthly', label: 'Monthly' },
  { id: 'term', label: 'Term' },
  { id: 'package', label: 'Package' },
  { id: 'camp', label: 'Camp' },
];

const priceBands: { id: PriceBand; label: string }[] = [
  { id: 'under-100', label: 'Under AED 100' },
  { id: '100-500', label: 'AED 100–500' },
  { id: 'over-500', label: 'Over AED 500' },
];

const ageBands: { label: string; spokenLabel: string; min: number; max: number | null }[] = [
  { label: '3–5', spokenLabel: 'Ages 3 to 5', min: 3, max: 5 },
  { label: '6–9', spokenLabel: 'Ages 6 to 9', min: 6, max: 9 },
  { label: '10–13', spokenLabel: 'Ages 10 to 13', min: 10, max: 13 },
  { label: '14–17', spokenLabel: 'Ages 14 to 17', min: 14, max: 17 },
];

const skillOptions: Exclude<SkillLevel, 'all-levels'>[] = ['beginner', 'intermediate', 'advanced'];

/**
 * HMS-003 — the complete filter sheet (docs/14 §4). Hand-built modal sheet:
 * backdrop tap and Android back dismiss; safe-area padded; internally
 * scrollable; Dynamic-Type tolerant. Swipe-down dismissal is deferred
 * (docs/17 §10). Conditional rows appear only when meaningful — no disabled
 * control lists.
 */
export function FilterSheet({ visible, filters, resultCount, onChange, onClearAll, onClose, onApply }: Props) {
  const reducedMotion = useReducedMotion();
  const insets = useSafeAreaInsets();

  const patch = (partial: Partial<FilterSelection>) => onChange({ ...filters, ...partial });
  const single = <T,>(current: T | undefined, next: T): T | undefined =>
    current === next ? undefined : next;

  const conditionalActivityTypes =
    filters.categoryId === undefined
      ? []
      : activityTypes.filter((activity) => activity.categoryId === filters.categoryId);
  const showSkill = filters.categoryId !== undefined || filters.activityTypeId !== undefined;
  const hasActiveFilters =
    JSON.stringify(filters) !== JSON.stringify({ ...filters, ...clearedShape(filters) });

  return (
    <Modal
      visible={visible}
      transparent
      animationType={reducedMotion ? 'none' : 'slide'}
      onRequestClose={onClose}
    >
      <View style={styles.root}>
        <Pressable
          style={styles.backdrop}
          onPress={onClose}
          accessibilityLabel="Close filters"
          accessibilityRole="button"
        />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + spacing.lg }]}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <Text style={styles.title} accessibilityRole="header">
              Filters
            </Text>
            {hasActiveFilters ? (
              <PressableFeedback
                onPress={onClearAll}
                accessibilityLabel="Clear all filters"
                style={styles.clearAll}
                hitSlop={8}
              >
                <Text style={styles.clearAllLabel}>Clear all</Text>
              </PressableFeedback>
            ) : null}
          </View>

          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
          >
            <Group title="Who">
              <Row>
                <Chip
                  label="Ladies only"
                  icon="woman-outline"
                  selected={filters.ladiesOnly}
                  accessibilityRole="checkbox"
                  onPress={() => patch({ ladiesOnly: !filters.ladiesOnly })}
                  accessibilityHint="Shows only ladies-only classes"
                />
                <Chip
                  label="Adults"
                  selected={filters.audience === 'adults'}
                  accessibilityRole="radio"
                  onPress={() => patch({ audience: single(filters.audience, 'adults') })}
                />
                <Chip
                  label="Children"
                  selected={filters.audience === 'children'}
                  accessibilityRole="radio"
                  onPress={() => patch({ audience: single(filters.audience, 'children') })}
                />
              </Row>
              <Caption>Age</Caption>
              <Row>
                {ageBands.map((band) => (
                  <Chip
                    key={band.label}
                    label={band.label}
                    accessibilityLabel={band.spokenLabel}
                    selected={filters.ageBand?.min === band.min}
                    accessibilityRole="radio"
                    onPress={() =>
                      patch({
                        ageBand:
                          filters.ageBand?.min === band.min
                            ? undefined
                            : { min: band.min, max: band.max },
                      })
                    }
                  />
                ))}
              </Row>
            </Group>

            <Group title="When">
              <Row>
                <Chip
                  label="Today"
                  selected={filters.when === 'today'}
                  accessibilityRole="radio"
                  onPress={() => patch({ when: single(filters.when, 'today') })}
                />
                <Chip
                  label="This weekend"
                  selected={filters.when === 'weekend'}
                  accessibilityRole="radio"
                  onPress={() => patch({ when: single(filters.when, 'weekend') })}
                />
                <Chip
                  label="After school"
                  selected={filters.afterSchool}
                  accessibilityRole="checkbox"
                  onPress={() => patch({ afterSchool: !filters.afterSchool })}
                />
              </Row>
            </Group>

            <Group title="Where">
              <Row>
                <Chip
                  label="Near me"
                  icon="navigate-outline"
                  selected={filters.nearMe}
                  accessibilityRole="checkbox"
                  onPress={() => patch({ nearMe: !filters.nearMe })}
                  accessibilityHint="Shows the closest activities first"
                />
                {areas.map((area) => (
                  <Chip
                    key={area.id}
                    label={area.label}
                    selected={filters.areaId === area.id}
                    accessibilityRole="radio"
                    onPress={() => patch({ areaId: single(filters.areaId, area.id) })}
                  />
                ))}
              </Row>
            </Group>

            <Group title="What">
              <Row>
                {categories.map((category) => (
                  <Chip
                    key={category.id}
                    label={category.label}
                    selected={filters.categoryId === category.id}
                    accessibilityRole="radio"
                    onPress={() =>
                      patch({
                        categoryId: single(filters.categoryId, category.id as CategoryId),
                        activityTypeId: undefined,
                        skillLevel:
                          filters.categoryId === category.id ? undefined : filters.skillLevel,
                      })
                    }
                  />
                ))}
              </Row>
              {conditionalActivityTypes.length > 0 ? (
                <>
                  <Caption>Activity</Caption>
                  <Row>
                    {conditionalActivityTypes.map((activity) => (
                      <Chip
                        key={activity.id}
                        label={activity.label}
                        selected={filters.activityTypeId === activity.id}
                        accessibilityRole="radio"
                        onPress={() =>
                          patch({ activityTypeId: single(filters.activityTypeId, activity.id) })
                        }
                      />
                    ))}
                  </Row>
                </>
              ) : null}
              <Caption>Format</Caption>
              <Row>
                {formatOptions.map((format) => (
                  <Chip
                    key={format.id}
                    label={format.label}
                    selected={filters.formats.includes(format.id)}
                    accessibilityRole="checkbox"
                    onPress={() =>
                      patch({
                        formats: filters.formats.includes(format.id)
                          ? filters.formats.filter((id) => id !== format.id)
                          : [...filters.formats, format.id],
                      })
                    }
                  />
                ))}
              </Row>
              <Caption>Setting</Caption>
              <Row>
                <Chip
                  label="Indoor"
                  selected={filters.setting === 'indoor'}
                  accessibilityRole="radio"
                  onPress={() => patch({ setting: single(filters.setting, 'indoor') })}
                />
                <Chip
                  label="Outdoor"
                  selected={filters.setting === 'outdoor'}
                  accessibilityRole="radio"
                  onPress={() => patch({ setting: single(filters.setting, 'outdoor') })}
                />
              </Row>
            </Group>

            <Group title="Price & offers">
              <Row>
                {priceBands.map((band) => (
                  <Chip
                    key={band.id}
                    label={band.label}
                    selected={filters.priceBand === band.id}
                    accessibilityRole="radio"
                    onPress={() => patch({ priceBand: single(filters.priceBand, band.id) })}
                  />
                ))}
                <Chip
                  label="Free"
                  selected={filters.free}
                  accessibilityRole="checkbox"
                  onPress={() => patch({ free: !filters.free })}
                />
                <Chip
                  label="Offers"
                  icon="pricetag-outline"
                  selected={filters.offers}
                  accessibilityRole="checkbox"
                  onPress={() => patch({ offers: !filters.offers })}
                />
                <Chip
                  label="Free trial"
                  selected={filters.trial}
                  accessibilityRole="checkbox"
                  onPress={() => patch({ trial: !filters.trial })}
                />
              </Row>
            </Group>

            <Group title="More">
              <Row>
                {showSkill
                  ? skillOptions.map((skill) => (
                      <Chip
                        key={skill}
                        label={skill[0].toUpperCase() + skill.slice(1)}
                        selected={filters.skillLevel === skill}
                        accessibilityRole="radio"
                        onPress={() => patch({ skillLevel: single(filters.skillLevel, skill) })}
                      />
                    ))
                  : null}
                <Chip
                  label="Top rated 4.8+"
                  icon="star-outline"
                  selected={filters.topRated}
                  accessibilityRole="checkbox"
                  onPress={() => patch({ topRated: !filters.topRated })}
                />
              </Row>
            </Group>
          </ScrollView>

          <PressableFeedback
            onPress={onApply ?? onClose}
            accessibilityLabel={`Show ${resultCount} ${resultCount === 1 ? 'activity' : 'activities'}`}
            style={styles.apply}
          >
            <Text style={styles.applyLabel}>
              Show {resultCount} {resultCount === 1 ? 'activity' : 'activities'}
            </Text>
          </PressableFeedback>
        </View>
      </View>
    </Modal>
  );
}

/** Shape with every clearable field reset — used to detect active filters. */
function clearedShape(filters: FilterSelection): Partial<FilterSelection> {
  return {
    ladiesOnly: false,
    audience: undefined,
    ageBand: undefined,
    when: undefined,
    afterSchool: false,
    areaId: undefined,
    nearMe: false,
    categoryId: undefined,
    activityTypeId: undefined,
    formats: filters.formats.length === 0 ? filters.formats : [],
    setting: undefined,
    priceBand: undefined,
    free: false,
    offers: false,
    trial: false,
    skillLevel: undefined,
    topRated: false,
  };
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.group}>
      <Text style={styles.groupTitle} accessibilityRole="header">
        {title}
      </Text>
      {children}
    </View>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <View style={styles.row}>{children}</View>;
}

function Caption({ children }: { children: string }) {
  return <Text style={styles.caption}>{children}</Text>;
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.overlay.backdrop,
  },
  sheet: {
    maxHeight: '88%',
    backgroundColor: colors.background.elevated,
    borderTopLeftRadius: radii.sheet,
    borderTopRightRadius: radii.sheet,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.md,
    ...shadows.sheet,
  },
  handle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border.default,
    marginBottom: spacing.md,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  title: {
    ...typography.sectionTitle,
    color: colors.text.primary,
  },
  clearAll: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing.xs,
  },
  clearAllLabel: {
    ...typography.chip,
    color: colors.brand.primary,
  },
  scroll: { flexGrow: 0 },
  scrollContent: {
    gap: spacing.xl,
    paddingBottom: spacing.lg,
  },
  group: { gap: spacing.sm },
  groupTitle: {
    ...typography.caption,
    color: colors.text.secondary,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  caption: {
    ...typography.caption,
    color: colors.text.secondary,
    marginTop: spacing.xs,
  },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  apply: {
    minHeight: 52,
    borderRadius: radii.button,
    backgroundColor: colors.brand.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.sm,
  },
  applyLabel: {
    ...typography.chip,
    fontFamily: fontFamily.bold,
    color: colors.text.inverse,
  },
});
