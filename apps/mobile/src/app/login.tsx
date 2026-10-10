import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { z } from 'zod';
import { TextField } from '../components/form';
import { Button, Notice } from '../components/ui';
import { errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { API_URL } from '../lib/config';
import { colors, radius, space } from '../theme';

const loginForm = z.object({
  email: z.string().trim().min(1, 'Enter your email').pipe(z.email('Enter a valid email address')),
  password: z.string().min(1, 'Enter your password').max(128),
});
type LoginForm = z.infer<typeof loginForm>;

export default function LoginScreen() {
  const { login } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const { control, handleSubmit, formState } = useForm<LoginForm>({ resolver: zodResolver(loginForm), defaultValues: { email: '', password: '' } });

  const submit = handleSubmit(async (values) => {
    setError(null);
    try {
      await login(values.email.toLowerCase(), values.password);
    } catch (err) {
      setError(errorMessage(err));
    }
  });

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.brand}>
            <Text style={styles.logo} accessibilityRole="header">
              ServeOS
            </Text>
            <Text style={styles.tagline}>Owner &amp; manager app</Text>
          </View>
          <View style={styles.card}>
            <Text style={styles.title}>Sign in</Text>
            {error ? <Notice text={error} /> : null}
            <TextField control={control} name="email" label="Email" autoCapitalize="none" autoCorrect={false} keyboardType="email-address" autoComplete="email" textContentType="username" returnKeyType="next" testID="login-email" />
            <TextField control={control} name="password" label="Password" secureTextEntry autoCapitalize="none" autoComplete="current-password" textContentType="password" returnKeyType="go" onSubmitEditing={() => void submit()} testID="login-password" />
            <Button label="Sign in" onPress={() => void submit()} loading={formState.isSubmitting} testID="login-submit" />
          </View>
          <Text style={styles.server}>Server: {API_URL}</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.chrome },
  flex: { flex: 1 },
  content: { flexGrow: 1, justifyContent: 'center', padding: space.xl, gap: space.xl },
  brand: { alignItems: 'center', gap: space.xs },
  logo: { fontSize: 34, fontWeight: '800', color: colors.brandBright, letterSpacing: 0.5 },
  tagline: { fontSize: 15, color: colors.chromeFaint },
  card: { backgroundColor: colors.canvas, borderRadius: radius.card, padding: space.xl, gap: space.lg },
  title: { fontSize: 20, fontWeight: '700', color: colors.ink },
  server: { fontSize: 12, color: colors.chromeFaint, textAlign: 'center' },
});
