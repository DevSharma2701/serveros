/**
 * Date-range and outlet filters shared by the Dashboard and Sales reports tabs, so a range
 * picked on one is still selected on the other.
 */
import { zodResolver } from '@hookform/resolvers/zod';
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../lib/auth';
import { customRangeSchema, presetRange, PRESETS, type CustomRangeInput, type DateRange, type RangePreset } from '../lib/dates';
import { shortDay } from '../lib/format';
import { colors, space } from '../theme';
import { TextField } from './form';
import { Button, Card, Chip, ChipRow } from './ui';

/** 'all' = every outlet the user is assigned to; otherwise one outlet id. */
type OutletChoice = 'all' | string;

interface ReportFilters {
  range: DateRange;
  setPreset(preset: Exclude<RangePreset, 'custom'>): void;
  setCustom(from: string, to: string): void;
  outletChoice: OutletChoice;
  setOutletChoice(choice: OutletChoice): void;
  /** Concrete outlet ids to send to the API. */
  outletIds: string[];
}

const FiltersContext = createContext<ReportFilters | null>(null);

export function ReportFiltersProvider({ children }: { children: ReactNode }) {
  const { me, outlet } = useAuth();
  const timeZone = outlet?.timezone;
  const [preset, setPresetState] = useState<RangePreset>('today');
  const [custom, setCustomState] = useState<{ from: string; to: string } | null>(null);
  // null = follow the outlet selected for the whole app.
  const [choice, setChoice] = useState<OutletChoice | null>(null);

  const value = useMemo<ReportFilters>(() => {
    const outlets = me?.outlets ?? [];
    const chosen: OutletChoice = choice !== null && (choice === 'all' || outlets.some((o) => o.id === choice)) ? choice : (outlet?.id ?? 'all');
    // Presets are resolved on every render so "Today" rolls over at midnight in the outlet's time zone.
    const range: DateRange = preset === 'custom' && custom ? { preset, ...custom } : presetRange(preset === 'custom' ? 'today' : preset, timeZone);
    return {
      range,
      setPreset: (p) => setPresetState(p),
      setCustom: (from, to) => {
        setCustomState({ from, to });
        setPresetState('custom');
      },
      outletChoice: chosen,
      setOutletChoice: setChoice,
      outletIds: chosen === 'all' ? outlets.map((o) => o.id) : [chosen],
    };
  }, [me, outlet, timeZone, preset, custom, choice]);

  return <FiltersContext.Provider value={value}>{children}</FiltersContext.Provider>;
}

export function useReportFilters(): ReportFilters {
  const ctx = useContext(FiltersContext);
  if (!ctx) throw new Error('useReportFilters must be used inside <ReportFiltersProvider>');
  return ctx;
}

export const rangeLabel = (range: DateRange): string => (range.from === range.to ? shortDay(range.from) : `${shortDay(range.from)} – ${shortDay(range.to)}`);

/** Preset chips plus a validated custom range (React Hook Form + Zod). */
export function DateRangeFilter() {
  const { range, setPreset, setCustom } = useReportFilters();
  const [open, setOpen] = useState(false);
  const { control, handleSubmit, reset } = useForm<CustomRangeInput>({
    resolver: zodResolver(customRangeSchema),
    defaultValues: { from: range.from, to: range.to },
  });

  return (
    <View style={styles.block}>
      <ChipRow>
        {PRESETS.map((p) => (
          <Chip
            key={p.key}
            label={p.label}
            accessibilityLabel={`Date range: ${p.label}`}
            selected={range.preset === p.key}
            onPress={() => {
              setOpen(false);
              setPreset(p.key);
            }}
          />
        ))}
        <Chip
          label="Custom"
          accessibilityLabel="Date range: custom"
          selected={range.preset === 'custom'}
          onPress={() => {
            reset({ from: range.from, to: range.to });
            setOpen((v) => !v);
          }}
        />
      </ChipRow>
      {open ? (
        <Card>
          <View style={styles.rangeRow}>
            <View style={styles.rangeField}>
              <TextField control={control} name="from" label="From" placeholder="YYYY-MM-DD" autoCapitalize="none" autoCorrect={false} keyboardType="numbers-and-punctuation" maxLength={10} />
            </View>
            <View style={styles.rangeField}>
              <TextField control={control} name="to" label="To" placeholder="YYYY-MM-DD" autoCapitalize="none" autoCorrect={false} keyboardType="numbers-and-punctuation" maxLength={10} />
            </View>
          </View>
          <Button
            label="Apply range"
            onPress={handleSubmit((v) => {
              setCustom(v.from, v.to);
              setOpen(false);
            })}
          />
        </Card>
      ) : null}
      <Text style={styles.caption} testID="range-label">
        Showing {rangeLabel(range)} · days in the outlet&apos;s time zone
      </Text>
    </View>
  );
}

/** Lets a multi-outlet user see one outlet or all of them together. Hidden for single-outlet users. */
export function OutletFilter() {
  const { me } = useAuth();
  const { outletChoice, setOutletChoice } = useReportFilters();
  const outlets = me?.outlets ?? [];
  if (outlets.length < 2) return null;
  return (
    <ChipRow>
      <Chip label="All outlets" accessibilityLabel="Outlet filter: all outlets" selected={outletChoice === 'all'} onPress={() => setOutletChoice('all')} />
      {outlets.map((o) => (
        <Chip key={o.id} label={o.name} accessibilityLabel={`Outlet filter: ${o.name}`} selected={outletChoice === o.id} onPress={() => setOutletChoice(o.id)} />
      ))}
    </ChipRow>
  );
}

const styles = StyleSheet.create({
  block: { gap: space.sm },
  rangeRow: { flexDirection: 'row', gap: space.md },
  rangeField: { flex: 1 },
  caption: { fontSize: 12, color: colors.inkFaint },
});
