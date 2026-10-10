import { zodResolver } from '@hookform/resolvers/zod';
import { PERMISSIONS, type PermissionKey } from '@serveos/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Button, ConfirmDialog, Drawer, Field, Notice, Select, StatusBadge, useToast } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dateTime } from '@/lib/format';
import { DevInviteNote } from './InviteStaffForm';
import { StaffFields, staffProfileSchema, useAssignableRoles, useRoles, type ProfileInput, type ProfileOutput } from './StaffFields';
import type { Grant, StaffMember } from './types';

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

function useStaffMutation<TBody>(request: (body: TBody) => Promise<unknown>, success: string) {
  const notify = useToast();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['staff'] });
      notify(success);
    },
  });
}

/** Extra permissions on top of the person's role. Only rights the current user holds can be given. */
function Grants({ member }: { member: StaffMember }) {
  const { me, can } = useAuth();
  const roles = useRoles();
  const [permissionKey, setPermissionKey] = useState('');
  const [scope, setScope] = useState('');
  const fromRole = useMemo(() => new Set(roles.data?.find((r) => r.id === member.roleId)?.permissions.map((p) => p.permissionKey) ?? []), [roles.data, member.roleId]);
  const outletName = (id: string | null) => (id ? (me?.outlets.find((o) => o.id === id)?.name ?? 'Another outlet') : 'All outlets');

  const grantable = (Object.keys(PERMISSIONS) as PermissionKey[]).filter((key) => key !== 'platform.manage' && can(key) && !fromRole.has(key));
  const categories = [...new Set(grantable.map((key) => PERMISSIONS[key][0]))];

  const add = useStaffMutation((body: { permissionKey: string; outletId: string | null }) => api<Grant>(`/staff/${member.id}/grants`, { method: 'POST', body }), 'Permission granted');
  const remove = useStaffMutation((grantId: string) => api(`/staff/${member.id}/grants/${grantId}`, { method: 'DELETE' }), 'Permission removed');
  const failure = add.error ?? remove.error;

  return (
    <section aria-label="Extra permissions" className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-semibold text-ink">Extra permissions</h3>
        <p className="text-sm text-ink-soft">Rights given to this person on top of their role. You can only give permissions you hold yourself.</p>
      </div>
      {member.grants.length === 0 ? (
        <p className="rounded-control bg-sunken px-3 py-2 text-sm text-ink-soft">No extra permissions. This person has exactly what the {member.role.name} role allows.</p>
      ) : (
        <ul className="divide-y divide-line rounded-control border border-line">
          {member.grants.map((g) => (
            <li key={g.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0 text-sm">
                <p className="font-medium text-ink">{PERMISSIONS[g.permissionKey]?.[1] ?? g.permissionKey}</p>
                <p className="text-ink-soft">{outletName(g.outletId)}</p>
              </div>
              <Button size="sm" variant="ghost" aria-label={`Remove permission: ${PERMISSIONS[g.permissionKey]?.[1] ?? g.permissionKey}`} loading={remove.isPending && remove.variables === g.id} onClick={() => remove.mutate(g.id)}>
                <Trash2 className="h-4 w-4" aria-hidden /> Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="grid gap-3 sm:grid-cols-[1fr_10rem_auto] sm:items-end">
        <Field label="Permission to add">
          {(p) => (
            <Select {...p} value={permissionKey} onChange={(e) => setPermissionKey(e.target.value)}>
              <option value="">Choose a permission</option>
              {categories.map((category) => (
                <optgroup key={category} label={category}>
                  {grantable
                    .filter((key) => PERMISSIONS[key][0] === category)
                    .map((key) => (
                      <option key={key} value={key}>
                        {PERMISSIONS[key][1]}
                      </option>
                    ))}
                </optgroup>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Applies to">
          {(p) => (
            <Select {...p} value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="">All outlets</option>
              {(me?.outlets ?? []).map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Button disabled={!permissionKey} loading={add.isPending} onClick={() => add.mutate({ permissionKey, outletId: scope || null }, { onSuccess: () => setPermissionKey('') })}>
          Grant
        </Button>
      </div>
      {failure ? <Notice tone="bad">{errorMessage(failure)}</Notice> : null}
    </section>
  );
}

function ProfileForm({ member }: { member: StaffMember }) {
  const { me } = useAuth();
  const { roles, loading } = useAssignableRoles();
  const myOutletIds = useMemo(() => (me?.outlets ?? []).map((o) => o.id), [me]);
  const defaults = useMemo<ProfileInput>(
    () => ({ name: member.name, phone: member.phone, employeeCode: member.employeeCode, jobTitle: member.jobTitle, roleId: member.roleId, allOutlets: member.allOutlets, outletIds: member.assignments.map((a) => a.outletId).filter((id) => myOutletIds.includes(id)) }),
    [member, myOutletIds],
  );
  const hiddenOutlets = member.assignments.filter((a) => !myOutletIds.includes(a.outletId)).length;
  const form = useForm<ProfileInput, unknown, ProfileOutput>({ resolver: zodResolver(staffProfileSchema), defaultValues: defaults });
  const { reset } = form;
  useEffect(() => reset(defaults), [defaults, reset]);

  const save = useStaffMutation((body: Partial<ProfileOutput>) => api<StaffMember>(`/staff/${member.id}`, { method: 'PATCH', body }), `${member.name} updated`);

  const submit = form.handleSubmit((values) => {
    // PATCH is partial: send only what was changed.
    const body: Partial<ProfileOutput> = {};
    if (values.name !== member.name) body.name = values.name;
    if (values.phone !== member.phone) body.phone = values.phone;
    if (values.employeeCode !== member.employeeCode) body.employeeCode = values.employeeCode;
    if (values.jobTitle !== member.jobTitle) body.jobTitle = values.jobTitle;
    if (values.roleId !== member.roleId) body.roleId = values.roleId;
    if (values.allOutlets !== member.allOutlets || !sameSet(values.outletIds, defaults.outletIds ?? [])) {
      body.allOutlets = values.allOutlets;
      body.outletIds = values.outletIds;
    }
    if (Object.keys(body).length > 0) save.mutate(body);
  });

  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-4">
      <StaffFields form={form} roles={roles} rolesLoading={loading} currentRole={member.role} />
      {hiddenOutlets > 0 ? <p className="text-sm text-ink-soft">Also assigned to {hiddenOutlets} outlet{hiddenOutlets === 1 ? '' : 's'} you do not have access to. Those stay as they are.</p> : null}
      <p className="text-sm text-ink-faint">Changing the role signs this person out so the new access takes effect.</p>
      {save.isError ? <Notice tone="bad" title="The change was not saved">{errorMessage(save.error)}</Notice> : null}
      <Button type="submit" variant="primary" loading={save.isPending} disabled={!form.formState.isDirty} className="self-start">
        Save changes
      </Button>
    </form>
  );
}

function AccountActions({ member }: { member: StaffMember }) {
  const [confirm, setConfirm] = useState<'disable' | 'signout' | null>(null);
  const resend = useStaffMutation(() => api(`/staff/${member.id}/resend-invite`, { method: 'POST' }), `Invitation sent again to ${member.email}`);
  const signOut = useStaffMutation(() => api(`/staff/${member.id}/revoke-sessions`, { method: 'POST' }), `${member.name} was signed out everywhere`);
  const setStatus = useStaffMutation((status: 'ACTIVE' | 'DISABLED') => api(`/staff/${member.id}`, { method: 'PATCH', body: { status } }), `${member.name} updated`);
  const failure = resend.error ?? setStatus.error;
  const close = () => {
    setConfirm(null);
    signOut.reset();
    setStatus.reset();
  };

  return (
    <section aria-label="Account" className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold text-ink">Account</h3>
      <div className="flex flex-wrap gap-2">
        {member.status === 'INVITED' ? (
          <Button loading={resend.isPending} onClick={() => resend.mutate(undefined)}>
            Resend invitation
          </Button>
        ) : null}
        {member.status !== 'INVITED' ? <Button onClick={() => setConfirm('signout')}>Sign out everywhere</Button> : null}
        {member.status === 'DISABLED' ? (
          <Button loading={setStatus.isPending} onClick={() => setStatus.mutate('ACTIVE')}>
            Enable account
          </Button>
        ) : (
          <Button variant="danger" onClick={() => setConfirm('disable')}>
            Disable account
          </Button>
        )}
      </div>
      {member.status === 'INVITED' ? <DevInviteNote /> : null}
      {failure && confirm === null ? <Notice tone="bad">{errorMessage(failure)}</Notice> : null}
      <ConfirmDialog
        open={confirm === 'signout'}
        onClose={close}
        title={`Sign ${member.name} out everywhere?`}
        description="Every device they are signed in on will need the password again."
        confirmLabel="Sign out everywhere"
        pending={signOut.isPending}
        error={signOut.isError ? errorMessage(signOut.error) : null}
        onConfirm={() => signOut.mutate(undefined, { onSuccess: close })}
      />
      <ConfirmDialog
        open={confirm === 'disable'}
        onClose={close}
        danger
        title={`Disable ${member.name}'s account?`}
        description="They are signed out at once and cannot sign in until the account is enabled again. Their past orders and records are kept."
        confirmLabel="Disable account"
        pending={setStatus.isPending}
        error={setStatus.isError ? errorMessage(setStatus.error) : null}
        onConfirm={() => setStatus.mutate('DISABLED', { onSuccess: close })}
      />
    </section>
  );
}

/** Everything a manager can change about one staff member. */
export function StaffDrawer({ member, onClose }: { member: StaffMember | null; onClose: () => void }) {
  const { me } = useAuth();
  const isSelf = member?.id === me?.user.id;
  const outranks = member ? member.role.rank < (me?.user.role.rank ?? 0) : false;
  return (
    <Drawer open={member !== null} onClose={onClose} wide title={member?.name ?? 'Staff member'} description={member?.email}>
      {member ? (
        <div className="flex flex-col gap-6">
          <div className="flex flex-wrap items-center gap-2 text-sm text-ink-soft">
            <StatusBadge status={member.status} />
            <span>{member.role.name}</span>
            <span aria-hidden>·</span>
            <span>{member.lastLoginAt ? `Last signed in ${dateTime(member.lastLoginAt)}` : 'Has not signed in yet'}</span>
          </div>
          {isSelf ? (
            <Notice tone="info">This is your own account. Someone with a higher role has to change your access.</Notice>
          ) : !outranks ? (
            <Notice tone="info">You can only manage staff whose role is below your own ({me?.user.role.name}).</Notice>
          ) : (
            <>
              <ProfileForm member={member} />
              <hr className="border-line" />
              <Grants member={member} />
              <hr className="border-line" />
              <AccountActions member={member} />
            </>
          )}
        </div>
      ) : null}
    </Drawer>
  );
}
