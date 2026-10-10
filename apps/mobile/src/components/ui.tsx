/** Small shared UI kit: one visual language for every screen. */
import Ionicons from '@expo/vector-icons/Ionicons';
import type { ComponentProps, ReactNode } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { ApiError, errorMessage } from '../lib/api';
import { colors, radius, space, toneColors, TOUCH, type Tone } from '../theme';

export type IconName = ComponentProps<typeof Ionicons>['name'];

// ── Layout ──
export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function SectionTitle({ children, hint }: { children: string; hint?: string }) {
  return (
    <View style={styles.sectionTitle}>
      <Text accessibilityRole="header" style={styles.sectionTitleText}>
        {children}
      </Text>
      {hint ? <Text style={styles.sectionHint}>{hint}</Text> : null}
    </View>
  );
}

/** A refresh control in the brand colour; every list and scroll view in the app uses it. */
export function refresher(refreshing: boolean, onRefresh: () => void) {
  return <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.brand} colors={[colors.brand]} />;
}

/** Scrollable page body with pull-to-refresh. */
export function ScreenScroll({ children, refreshing, onRefresh, testID }: { children: ReactNode; refreshing: boolean; onRefresh: () => void; testID?: string }) {
  return (
    <ScrollView testID={testID} style={styles.screen} contentContainerStyle={styles.screenContent} refreshControl={refresher(refreshing, onRefresh)} keyboardShouldPersistTaps="handled">
      {children}
    </ScrollView>
  );
}

// ── Controls ──
interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  loading?: boolean;
  icon?: IconName;
  accessibilityHint?: string;
  testID?: string;
}

export function Button({ label, onPress, variant = 'primary', disabled, loading, icon, accessibilityHint, testID }: ButtonProps) {
  const inactive = disabled || loading;
  const fg = variant === 'primary' ? '#ffffff' : variant === 'danger' ? colors.bad : colors.ink;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!inactive, busy: !!loading }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [styles.button, variant === 'primary' ? styles.buttonPrimary : styles.buttonSecondary, variant === 'danger' && styles.buttonDanger, pressed && styles.pressed, inactive && styles.disabled]}>
      {loading ? <ActivityIndicator color={fg} /> : icon ? <Ionicons name={icon} size={18} color={fg} /> : null}
      <Text style={[styles.buttonText, { color: fg }]}>{label}</Text>
    </Pressable>
  );
}

export function Chip({ label, selected, onPress, accessibilityLabel }: { label: string; selected: boolean; onPress: () => void; accessibilityLabel?: string }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ selected }}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [styles.chip, selected && styles.chipSelected, pressed && styles.pressed]}>
      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{label}</Text>
    </Pressable>
  );
}

export function ChipRow({ children }: { children: ReactNode }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
      {children}
    </ScrollView>
  );
}

export function Badge({ label, tone = 'neutral' }: { label: string; tone?: Tone }) {
  const c = toneColors[tone];
  return (
    <View style={[styles.badge, { backgroundColor: c.bg }]}>
      <Text style={[styles.badgeText, { color: c.fg }]}>{label}</Text>
    </View>
  );
}

// ── Data display ──
export function StatTile({ label, value, tone, hint, testID }: { label: string; value: string; tone?: Tone; hint?: string; testID?: string }) {
  return (
    <View style={styles.stat} accessible accessibilityLabel={`${label}: ${value}${hint ? `. ${hint}` : ''}`} testID={testID}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, tone && { color: toneColors[tone].fg }]} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      {hint ? <Text style={styles.statHint}>{hint}</Text> : null}
    </View>
  );
}

export function StatGrid({ children }: { children: ReactNode }) {
  return <View style={styles.statGrid}>{children}</View>;
}

/** A labelled horizontal bar: the app's only "chart". Width is value / max, taken from API data. */
export function BarRow({ label, value, fraction, sublabel, tone = 'brand' }: { label: string; value: string; fraction: number; sublabel?: string; tone?: Tone }) {
  const pct = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  return (
    <View style={styles.barRow} accessible accessibilityLabel={`${label}: ${value}${sublabel ? `, ${sublabel}` : ''}`}>
      <View style={styles.barHead}>
        <Text style={styles.barLabel} numberOfLines={1}>
          {label}
        </Text>
        <Text style={styles.barValue}>{value}</Text>
      </View>
      <View style={styles.barTrack}>
        <View style={[styles.barFill, { width: `${pct * 100}%`, backgroundColor: tone === 'brand' ? colors.brand : toneColors[tone].fg }]} />
      </View>
      {sublabel ? <Text style={styles.barSub}>{sublabel}</Text> : null}
    </View>
  );
}

export function KeyValue({ label, value, strong, tone }: { label: string; value: string; strong?: boolean; tone?: Tone }) {
  const valueStyle: StyleProp<TextStyle> = [styles.kvValue, strong && styles.kvStrong, tone && { color: toneColors[tone].fg }];
  return (
    <View style={styles.kv} accessible accessibilityLabel={`${label}: ${value}`}>
      <Text style={[styles.kvLabel, strong && styles.kvStrong]}>{label}</Text>
      <Text style={valueStyle}>{value}</Text>
    </View>
  );
}

interface ListRowProps {
  title: string;
  subtitle?: string;
  right?: ReactNode;
  icon?: IconName;
  onPress?: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
}

export function ListRow({ title, subtitle, right, icon, onPress, disabled, accessibilityLabel, accessibilityHint, testID }: ListRowProps) {
  const body = (
    <>
      {icon ? <Ionicons name={icon} size={22} color={disabled ? colors.inkFaint : colors.brand} style={styles.rowIcon} /> : null}
      <View style={styles.rowText}>
        <Text style={[styles.rowTitle, disabled && { color: colors.inkFaint }]}>{title}</Text>
        {subtitle ? <Text style={styles.rowSubtitle}>{subtitle}</Text> : null}
      </View>
      {right}
      {onPress && !disabled ? <Ionicons name="chevron-forward" size={18} color={colors.inkFaint} /> : null}
    </>
  );
  if (!onPress) {
    return (
      <View style={styles.row} testID={testID}>
        {body}
      </View>
    );
  }
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? (subtitle ? `${title}, ${subtitle}` : title)}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
      {body}
    </Pressable>
  );
}

// ── States ──
export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <View style={styles.state} accessible accessibilityRole="progressbar" accessibilityLabel={label}>
      <ActivityIndicator size="large" color={colors.brand} />
      <Text style={styles.stateBody}>{label}…</Text>
    </View>
  );
}

export function Empty({ title, body, icon = 'file-tray-outline' }: { title: string; body?: string; icon?: IconName }) {
  return (
    <View style={styles.state}>
      <Ionicons name={icon} size={36} color={colors.inkFaint} />
      <Text style={styles.stateTitle}>{title}</Text>
      {body ? <Text style={styles.stateBody}>{body}</Text> : null}
    </View>
  );
}

/** Shown instead of a feature the signed-in user's role does not include. */
export function NoAccess({ feature, body }: { feature: string; body?: string }) {
  return (
    <View style={styles.state} testID="no-access">
      <Ionicons name="lock-closed-outline" size={36} color={colors.inkFaint} />
      <Text style={styles.stateTitle}>No access to {feature}</Text>
      <Text style={styles.stateBody}>{body ?? 'Your role does not include this. Ask an owner or manager if you need it.'}</Text>
    </View>
  );
}

/** Shows the API's own error message with a retry. A 403 gets the "no access" treatment. */
export function ErrorState({ error, onRetry, feature }: { error: unknown; onRetry?: () => void; feature?: string }) {
  const forbidden = error instanceof ApiError && error.status === 403;
  const network = error instanceof ApiError && error.isNetwork;
  const reference = error instanceof ApiError && !forbidden ? error.correlationId : undefined;
  return (
    <View style={styles.state} testID="error-state" accessibilityRole="alert">
      <Ionicons name={forbidden ? 'lock-closed-outline' : network ? 'cloud-offline-outline' : 'alert-circle-outline'} size={36} color={forbidden ? colors.inkFaint : colors.bad} />
      <Text style={styles.stateTitle}>{forbidden ? `No access${feature ? ` to ${feature}` : ''}` : network ? 'No connection' : 'Something went wrong'}</Text>
      <Text style={styles.stateBody}>{errorMessage(error)}</Text>
      {reference ? <Text style={styles.stateRef}>Reference: {reference}</Text> : null}
      {onRetry && !forbidden ? <Button label="Try again" variant="secondary" icon="refresh" onPress={onRetry} /> : null}
    </View>
  );
}

/** Inline banner for a failed action or a failed background refresh while older data stays visible. */
export function Notice({ text, tone = 'bad' }: { text: string; tone?: Tone }) {
  const c = toneColors[tone];
  return (
    <View style={[styles.notice, { backgroundColor: c.bg }]} accessibilityRole="alert">
      <Text style={[styles.noticeText, { color: c.fg }]}>{text}</Text>
    </View>
  );
}

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.canvas },
  screenContent: { padding: space.lg, gap: space.lg, paddingBottom: space.xxl },
  card: { backgroundColor: colors.surface, borderRadius: radius.card, borderWidth: 1, borderColor: colors.line, padding: space.lg, gap: space.md },
  sectionTitle: { gap: 2 },
  sectionTitleText: { fontSize: 16, fontWeight: '700', color: colors.ink },
  sectionHint: { fontSize: 12, color: colors.inkFaint },

  button: { minHeight: TOUCH + 4, borderRadius: radius.control, paddingHorizontal: space.lg, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm },
  buttonPrimary: { backgroundColor: colors.brand },
  buttonSecondary: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.lineStrong },
  buttonDanger: { borderColor: colors.bad },
  buttonText: { fontSize: 16, fontWeight: '600' },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.5 },

  chipRow: { gap: space.sm, paddingVertical: 2 },
  chip: { minHeight: TOUCH, paddingHorizontal: space.lg, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.surface, justifyContent: 'center' },
  chipSelected: { backgroundColor: colors.chrome, borderColor: colors.chrome },
  chipText: { fontSize: 14, color: colors.ink, fontWeight: '500' },
  chipTextSelected: { color: '#ffffff' },

  badge: { paddingHorizontal: space.sm, paddingVertical: 3, borderRadius: radius.pill, alignSelf: 'flex-start' },
  badgeText: { fontSize: 12, fontWeight: '700' },

  statGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md },
  stat: { flexGrow: 1, flexBasis: '46%', backgroundColor: colors.surface, borderRadius: radius.card, borderWidth: 1, borderColor: colors.line, padding: space.md, gap: 2 },
  statLabel: { fontSize: 12, color: colors.inkSoft, fontWeight: '600' },
  statValue: { fontSize: 22, fontWeight: '700', color: colors.ink, fontVariant: ['tabular-nums'] },
  statHint: { fontSize: 11, color: colors.inkFaint },

  barRow: { gap: 4 },
  barHead: { flexDirection: 'row', justifyContent: 'space-between', gap: space.sm },
  barLabel: { flex: 1, fontSize: 14, color: colors.ink },
  barValue: { fontSize: 14, fontWeight: '600', color: colors.ink, fontVariant: ['tabular-nums'] },
  barTrack: { height: 8, borderRadius: 4, backgroundColor: colors.sunken, overflow: 'hidden' },
  barFill: { height: 8, borderRadius: 4 },
  barSub: { fontSize: 12, color: colors.inkFaint },

  kv: { flexDirection: 'row', justifyContent: 'space-between', gap: space.md, paddingVertical: 2 },
  kvLabel: { fontSize: 14, color: colors.inkSoft, flexShrink: 1 },
  kvValue: { fontSize: 14, color: colors.ink, fontVariant: ['tabular-nums'], textAlign: 'right', flexShrink: 1 },
  kvStrong: { fontWeight: '700', color: colors.ink, fontSize: 16 },

  row: { minHeight: TOUCH + 12, flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.sm, paddingHorizontal: space.lg, backgroundColor: colors.surface, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  rowIcon: { width: 24 },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { fontSize: 16, color: colors.ink, fontWeight: '500' },
  rowSubtitle: { fontSize: 13, color: colors.inkSoft },

  state: { alignItems: 'center', justifyContent: 'center', gap: space.md, padding: space.xl, paddingVertical: space.xxl },
  stateTitle: { fontSize: 17, fontWeight: '700', color: colors.ink, textAlign: 'center' },
  stateBody: { fontSize: 14, color: colors.inkSoft, textAlign: 'center' },
  stateRef: { fontSize: 11, color: colors.inkFaint, textAlign: 'center' },

  notice: { borderRadius: radius.control, padding: space.md },
  noticeText: { fontSize: 14, fontWeight: '500' },
});
