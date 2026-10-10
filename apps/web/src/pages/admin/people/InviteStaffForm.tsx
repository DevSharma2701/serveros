import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId } from 'react';
import { useForm, type UseFormReturn } from 'react-hook-form';
import { Button, Field, Input, Modal, Notice, useToast } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useOutlet } from '@/lib/auth';
import { StaffFields, inviteFormSchema, useAssignableRoles, type InviteInput, type InviteOutput, type ProfileInput, type ProfileOutput } from './StaffFields';
import type { StaffMember } from './types';

/** In development no email leaves the machine; say where the invitation link can be found. */
export function DevInviteNote() {
  if (!import.meta.env.DEV) return null;
  return (
    <Notice tone="info" title="Development: invitations are not emailed">
      The invitation link is kept in the API&apos;s development outbox. Open <code className="rounded bg-surface px-1 font-mono text-xs">GET /api/v1/dev/outbox</code> on the API to copy it.
    </Notice>
  );
}

export function InviteStaffForm({ open, onClose }: { open: boolean; onClose: () => void }) {
  const outlet = useOutlet();
  const notify = useToast();
  const queryClient = useQueryClient();
  const formId = useId();
  const { roles, loading, error: rolesError } = useAssignableRoles();
  const form = useForm<InviteInput, unknown, InviteOutput>({
    resolver: zodResolver(inviteFormSchema),
    defaultValues: { name: '', email: '', phone: '', employeeCode: '', jobTitle: '', roleId: '', allOutlets: false, outletIds: [outlet.id] },
  });
  const { reset } = form;
  useEffect(() => {
    if (open) reset();
  }, [open, reset]);

  const invite = useMutation({
    mutationFn: (body: InviteOutput) => api<StaffMember>('/staff', { method: 'POST', body }),
    onSuccess: (member) => {
      void queryClient.invalidateQueries({ queryKey: ['staff'] });
      notify(`Invitation sent to ${member.email}`);
      onClose();
    },
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Invite a staff member"
      description="They get a link to choose a password. The link is valid for a limited time."
      footer={
        <>
          <Button onClick={onClose} disabled={invite.isPending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant="primary" loading={invite.isPending}>
            Send invitation
          </Button>
        </>
      }
    >
      <form id={formId} noValidate className="flex flex-col gap-4" onSubmit={form.handleSubmit((values) => invite.mutate(values))}>
        <Field label="Work email" error={form.formState.errors.email ? 'Enter a valid email address' : undefined}>
          {(p) => <Input {...p} type="email" autoComplete="off" autoFocus {...form.register('email')} />}
        </Field>
        {/* The invite form has every field of the profile form plus email, so the shared fields can drive it. */}
        <StaffFields form={form as unknown as UseFormReturn<ProfileInput, unknown, ProfileOutput>} roles={roles} rolesLoading={loading} />
        {rolesError ? <Notice tone="bad">Could not load roles: {errorMessage(rolesError)}</Notice> : null}
        {/* Refusals from the server (a role or outlet you may not assign, an email already in use) are shown as written. */}
        {invite.isError ? <Notice tone="bad" title="The invitation was not sent">{errorMessage(invite.error)}</Notice> : null}
        <DevInviteNote />
      </form>
    </Modal>
  );
}
