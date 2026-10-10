import { Controller, type Control, type FieldPath, type FieldValues } from 'react-hook-form';
import { StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';
import { colors, radius, space, TOUCH } from '../theme';

interface FieldProps<T extends FieldValues> extends Omit<TextInputProps, 'value' | 'onChangeText' | 'onBlur'> {
  control: Control<T>;
  name: FieldPath<T>;
  label: string;
}

/** A labelled text input bound to React Hook Form, with the validation message underneath. */
export function TextField<T extends FieldValues>({ control, name, label, ...input }: FieldProps<T>) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <View style={styles.field}>
          <Text style={styles.label}>{label}</Text>
          <TextInput
            {...input}
            accessibilityLabel={label}
            value={typeof field.value === 'string' ? field.value : ''}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            placeholderTextColor={colors.inkFaint}
            style={[styles.input, fieldState.error && styles.inputError]}
          />
          {fieldState.error?.message ? (
            <Text style={styles.error} accessibilityRole="alert">
              {fieldState.error.message}
            </Text>
          ) : null}
        </View>
      )}
    />
  );
}

const styles = StyleSheet.create({
  field: { gap: space.xs },
  label: { fontSize: 14, fontWeight: '600', color: colors.inkSoft },
  input: { minHeight: TOUCH + 4, borderWidth: 1, borderColor: colors.lineStrong, borderRadius: radius.control, paddingHorizontal: space.md, fontSize: 16, color: colors.ink, backgroundColor: colors.surface },
  inputError: { borderColor: colors.bad },
  error: { fontSize: 13, color: colors.bad },
});
