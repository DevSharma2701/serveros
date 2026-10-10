import { zodResolver } from '@hookform/resolvers/zod';
import { changePasswordSchema } from '@serveos/shared';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { z } from 'zod';
import { TextField } from '../components/form';
import { Badge, Button, Card, ErrorState, KeyValue, Loading, Notice, ScreenScroll, SectionTitle } from '../components/ui';
import { errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { API_URL } from '../lib/config';
import { dateTime } from '../lib/format';
import { pushDisabledReason } from '../lib/push';
import { useChangePassword, useRevokeSession, useSessions } from '../lib/queries';
import { colors, space } from '../theme';

// Same rules as the API (shared schema), plus a confirmation typed on the phone.
const passwordForm = z
  .object({
    currentPassword: changePasswordSchema.shape.currentPassword,
    newPassword: changePasswordSchema.shape.newPassword,
    confirm: z.string(),
  })
  .refine((v) => v.newPassword === v.confirm, { path: ['confirm'], message: 'The passwords do not match' });
type PasswordForm = z.infer<typeof passwordForm>;

/** A friendlier name for a session's user agent string. */
function deviceName(userAgent: string): string {
  if (!userAgent) return 'Unknown device';
  if (/okhttp|Expo|Android/i.test(userAgent) && !/Chrome/i.test(userAgent)) return 'Android app';
  if (/CFNetwork|Darwin/i.test(userAgent)) return 'iPhone or iPad app';
  if (/Edg\//.test(userAgent)) return 'Edge browser';
  if (/Chrome\//.test(userAgent)) return 'Chrome browser';
  if (/Firefox\//.test(userAgent)) return 'Firefox browser';
  if (/Safari\//.test(userAgent)) return 'Safari browser';
  return userAgent.slice(0, 40);
}

export default function ProfileScreen() {
  const router = useRouter();
  const { me, outlet, logout, reloadProfile } = useAuth();
  const sessions = useSessions();
  const revoke = useRevokeSession();
  const changePassword = useChangePassword();
  const [showPassword, setShowPassword] = useState(false);
  const [passwordSaved, setPasswordSaved] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const { control, handleSubmit, reset } = useForm<PasswordForm>({ resolver: zodResolver(passwordForm), defaultValues: { currentPassword: '', newPassword: '', confirm: '' } });

  const refresh = () => {
    void sessions.refetch();
    void reloadProfile().catch(() => undefined);
  };

  const confirmSignOut = () =>
    Alert.alert('Sign out?', 'You will need your email and password to sign in again.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign out',
        style: 'destructive',
        onPress: () => {
          setSigningOut(true);
          void logout();
        },
      },
    ]);

  const confirmRevoke = (id: string, name: string) =>
    Alert.alert('Sign out that device?', `${name} will be signed out within a few minutes.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out device', style: 'destructive', onPress: () => revoke.mutate(id) },
    ]);

  const submitPassword = handleSubmit((values) => {
    setPasswordSaved(false);
    changePassword.mutate(
      { currentPassword: values.currentPassword, newPassword: values.newPassword },
      {
        onSuccess: () => {
          reset();
          setPasswordSaved(true);
          setShowPassword(false);
        },
      },
    );
  });

  return (
    <ScreenScroll testID="profile" refreshing={sessions.isRefetching} onRefresh={refresh}>
      <Card>
        <Text style={styles.name} accessibilityRole="header">
          {me?.user.name}
        </Text>
        <KeyValue label="Email" value={me?.user.email ?? ''} />
        <KeyValue label="Role" value={me?.user.role.name ?? ''} />
        <KeyValue label="Restaurant" value={me?.restaurant?.name ?? 'None'} />
      </Card>

      <Card>
        <SectionTitle>Outlet</SectionTitle>
        <KeyValue label="Selected outlet" value={outlet ? `${outlet.name} (${outlet.code})` : 'None'} />
        <KeyValue label="Time zone" value={outlet?.timezone ?? ''} />
        {(me?.outlets.length ?? 0) > 1 ? (
          <Button label="Switch outlet" variant="secondary" icon="swap-horizontal" onPress={() => router.push('/outlets')} />
        ) : (
          <Text style={styles.hint}>You are assigned to one outlet.</Text>
        )}
      </Card>

      <Card>
        <SectionTitle hint="Devices signed in to your account">Active sessions</SectionTitle>
        {revoke.isError ? <Notice text={`Could not sign out the device: ${errorMessage(revoke.error)}`} /> : null}
        {sessions.isPending ? (
          <Loading label="Loading sessions" />
        ) : sessions.isError ? (
          <ErrorState error={sessions.error} onRetry={() => void sessions.refetch()} />
        ) : (
          sessions.data.map((s) => {
            const name = deviceName(s.userAgent);
            return (
              <View key={s.id} style={styles.session}>
                <View style={styles.sessionText}>
                  <Text style={styles.sessionTitle}>{name}</Text>
                  <Text style={styles.hint}>
                    Last used {dateTime(s.lastUsedAt, outlet?.timezone)}
                    {s.ip ? ` · ${s.ip}` : ''}
                  </Text>
                </View>
                {s.current ? (
                  <Badge label="This device" tone="ok" />
                ) : (
                  <Button label="Sign out" variant="danger" accessibilityHint={`Signs out ${name}`} disabled={revoke.isPending} onPress={() => confirmRevoke(s.id, name)} />
                )}
              </View>
            );
          })
        )}
      </Card>

      <Card>
        <SectionTitle hint="Changing it signs out your other devices">Password</SectionTitle>
        {passwordSaved ? <Notice tone="ok" text="Password changed. Your other devices have been signed out." /> : null}
        {showPassword ? (
          <>
            {changePassword.isError ? <Notice text={errorMessage(changePassword.error)} /> : null}
            <TextField control={control} name="currentPassword" label="Current password" secureTextEntry autoCapitalize="none" autoComplete="current-password" />
            <TextField control={control} name="newPassword" label="New password" secureTextEntry autoCapitalize="none" autoComplete="new-password" />
            <TextField control={control} name="confirm" label="Repeat new password" secureTextEntry autoCapitalize="none" autoComplete="new-password" />
            <Button label="Change password" onPress={() => void submitPassword()} loading={changePassword.isPending} />
            <Button
              label="Cancel"
              variant="secondary"
              onPress={() => {
                reset();
                changePassword.reset();
                setShowPassword(false);
              }}
            />
          </>
        ) : (
          <Button label="Change password" variant="secondary" icon="key-outline" onPress={() => setShowPassword(true)} />
        )}
      </Card>

      <Card>
        <SectionTitle>App</SectionTitle>
        <KeyValue label="Server" value={API_URL} />
        <KeyValue label="Push notifications" value="Off" />
        <Text style={styles.hint}>{pushDisabledReason() ?? 'Push is configured in this build, but the server cannot send pushes yet.'} Alerts appear in the in-app Notifications list.</Text>
      </Card>

      <Button label="Sign out" variant="danger" icon="log-out-outline" onPress={confirmSignOut} loading={signingOut} testID="sign-out" />
    </ScreenScroll>
  );
}

const styles = StyleSheet.create({
  name: { fontSize: 20, fontWeight: '700', color: colors.ink },
  hint: { fontSize: 13, color: colors.inkSoft },
  session: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.xs },
  sessionText: { flex: 1, gap: 2 },
  sessionTitle: { fontSize: 15, fontWeight: '600', color: colors.ink },
});
