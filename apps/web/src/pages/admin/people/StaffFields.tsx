import { inviteStaffSchema } from '@serveos/shared';
import { useQuery } from '@tanstack/react-query';
import type { FieldErrors, UseFormReturn } from 'react-hook-form';
import type { z } from 'zod';
import { Checkbox, Field, Input, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { Role, StaffMember } from './types';

const needsOutlet = { message: 'Choose at least one outlet, or give access to all outlets', path: ['outletIds'] };

/** Invitation form: the API contract plus "must be able to work somewhere". */
export const inviteFormSchema = inviteStaffSchema.refine((v) => v.allOutlets || v.outletIds.length > 0, needsOutlet);
/** Edit form: the same fields without the email address, which cannot be changed. */
export const staffProfileSchema = inviteStaffSchema.omit({ email: true });

export type InviteInput = z.input<typeof inviteFormSchema>;
export type InviteOutput = z.output<typeof inviteFormSchema>;
export type ProfileInput = z.input<typeof staffProfileSchema>;
export type ProfileOutput = z.output<typeof staffProfileSchema>;

export const useStaff = () => useQuery({ queryKey: ['staff', 'list'], queryFn: () => api<StaffMember[]>('/staff') });
export const useRoles = () => useQuery({ queryKey: ['staff', 'roles'], queryFn: () => api<Role[]>('/roles'), staleTime: 300_000 });

/** Roles this user may hand out: only those ranked strictly below their own. */
export function useAssignableRoles(): { roles: Role[]; loading: boolean; error: unknown } {
  const { me } = useAuth();
  const query = useRoles();
  const rank = me?.user.role.rank ?? 0;
  return { roles: (query.data ?? []).filter((r) => r.rank < rank), loading: query.isLoading, error: query.error };
}

/**
 * Name, contact, role and outlets: the fields shared by the invite and edit forms.
 * Both form types include these fields, so the form is passed in with the edit shape.
 */
export function StaffFields({ form, roles, rolesLoading, currentRole }: { form: UseFormReturn<ProfileInput, unknown, ProfileOutput>; roles: Role[]; rolesLoading: boolean; /** Shown when the person's present role is not one this user can assign. */ currentRole?: { id: string; name: string } }) {
  const { me } = useAuth();
  const errors: FieldErrors<ProfileInput> = form.formState.errors;
  const allOutlets = form.watch('allOutlets') ?? false;
  const outletIds = form.watch('outletIds') ?? [];
  const toggle = (id: string, checked: boolean) => form.setValue('outletIds', checked ? [...new Set([...outletIds, id])] : outletIds.filter((x) => x !== id), { shouldDirty: true, shouldValidate: form.formState.isSubmitted });
  const roleOptions = currentRole && !roles.some((r) => r.id === currentRole.id) ? [{ id: currentRole.id, name: `${currentRole.name} (current)` }, ...roles] : roles;

  return (
    <>
      <Field label="Full name" error={errors.name ? 'Enter their name (up to 120 characters)' : undefined}>
        {(p) => <Input {...p} autoComplete="off" {...form.register('name')} />}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Job title" error={errors.jobTitle?.message} hint="Optional.">
          {(p) => <Input {...p} autoComplete="off" {...form.register('jobTitle')} />}
        </Field>
        <Field label="Employee code" error={errors.employeeCode?.message} hint="Optional.">
          {(p) => <Input {...p} autoComplete="off" {...form.register('employeeCode')} />}
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Phone" error={errors.phone?.message} hint="Optional.">
          {(p) => <Input {...p} type="tel" autoComplete="off" {...form.register('phone')} />}
        </Field>
        <Field label="Role" error={errors.roleId ? 'Choose a role' : undefined} hint="You can assign roles below your own.">
          {(p) => (
            // Re-mounting when the options arrive lets the form put the saved role back into the fresh list.
            <Select key={roleOptions.map((r) => r.id).join()} {...p} {...form.register('roleId')}>
              <option value="">{rolesLoading ? 'Loading roles…' : 'Choose a role'}</option>
              {roleOptions.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <fieldset aria-describedby={errors.outletIds ? 'staff-outlets-error' : undefined}>
        <legend className="text-sm font-medium text-ink">Outlets</legend>
        <p className="text-sm text-ink-faint">Where this person can sign in and work. You can assign outlets you have access to.</p>
        <Checkbox label="All outlets, including ones opened later" {...form.register('allOutlets')} />
        <div className="flex flex-wrap gap-x-6">
          {(me?.outlets ?? []).map((o) => (
            <Checkbox key={o.id} label={o.name} checked={allOutlets || outletIds.includes(o.id)} disabled={allOutlets} onChange={(e) => toggle(o.id, e.target.checked)} />
          ))}
        </div>
        {errors.outletIds ? (
          <p id="staff-outlets-error" role="alert" className="text-sm text-bad">
            {errors.outletIds.message}
          </p>
        ) : null}
      </fieldset>
    </>
  );
}
