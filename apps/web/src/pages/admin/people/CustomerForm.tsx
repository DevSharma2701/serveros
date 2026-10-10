import { zodResolver } from '@hookform/resolvers/zod';
import { customerSchema } from '@serveos/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import { Button, Checkbox, Field, Input, Modal, Notice, Textarea, useToast } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { CustomerRow } from './types';

type FormInput = z.input<typeof customerSchema>;
type FormOutput = z.output<typeof customerSchema>;

const CONTACT_FIELDS = ['phone', 'email', 'gstin'] as const;

function defaults(customer: CustomerRow | null, canContact: boolean): FormInput {
  // Without the contact permission the API sends masked values; they must never be sent back as if typed.
  const contact = customer && canContact;
  return {
    name: customer?.name ?? '',
    phone: contact ? (customer.phone ?? '') : '',
    email: contact ? customer.email : '',
    gstin: contact ? customer.gstin : '',
    stateCode: customer?.stateCode ?? '',
    notes: customer?.notes ?? '',
    marketingSms: customer?.marketingSms ?? false,
    marketingEmail: customer?.marketingEmail ?? false,
    marketingWhatsapp: customer?.marketingWhatsapp ?? false,
  };
}

/** Create a customer, or edit one. Editing sends only the fields that were changed. */
export function CustomerForm({ open, onClose, customer }: { open: boolean; onClose: () => void; customer: CustomerRow | null }) {
  const { can } = useAuth();
  const notify = useToast();
  const queryClient = useQueryClient();
  const formId = useId();
  const editing = customer !== null;
  const canContact = can('customer.view_contact');
  const canNotes = can('customer.notes');
  // New customers can always be given contact details; existing ones only by people allowed to see them.
  const showContact = !editing || canContact;

  const form = useForm<FormInput, unknown, FormOutput>({ resolver: zodResolver(customerSchema), defaultValues: defaults(customer, canContact) });
  const { errors, dirtyFields } = form.formState;
  const { reset } = form;
  useEffect(() => {
    if (open) reset(defaults(customer, canContact));
  }, [open, customer, canContact, reset]);

  const save = useMutation({
    mutationFn: (body: Partial<FormOutput>) => (customer ? api<CustomerRow>(`/customers/${customer.id}`, { method: 'PATCH', body }) : api<CustomerRow>('/customers', { method: 'POST', body })),
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
      notify(editing ? `${saved.name} updated` : `${saved.name} added`);
      onClose();
    },
  });

  const submit = form.handleSubmit((values) => {
    const body: Partial<FormOutput> = {};
    const assign = <K extends keyof FormOutput>(key: K) => {
      body[key] = values[key];
    };
    for (const key of Object.keys(values) as Array<keyof FormOutput>) {
      if (key === 'notes' && !canNotes) continue;
      if (!showContact && (CONTACT_FIELDS as readonly string[]).includes(key)) continue;
      if (editing && !dirtyFields[key]) continue;
      assign(key);
    }
    if (editing && Object.keys(body).length === 0) return onClose();
    save.mutate(body);
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? 'Edit customer' : 'Add customer'}
      footer={
        <>
          <Button onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant="primary" loading={save.isPending}>
            {editing ? 'Save changes' : 'Add customer'}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate className="flex flex-col gap-4">
        <Field label="Name" error={errors.name ? 'Enter a name (up to 120 characters)' : undefined}>
          {(p) => <Input {...p} autoComplete="off" autoFocus {...form.register('name')} />}
        </Field>
        {showContact ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Phone" error={errors.phone?.message} hint="7 to 15 digits. Optional.">
                {(p) => <Input {...p} type="tel" inputMode="tel" autoComplete="off" {...form.register('phone')} />}
              </Field>
              <Field label="Email" error={errors.email ? 'Enter a valid email address, or leave it empty' : undefined} hint="Optional.">
                {(p) => <Input {...p} type="email" autoComplete="off" {...form.register('email')} />}
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="GSTIN" error={errors.gstin?.message} hint="For business customers who need a tax invoice.">
                {(p) => <Input {...p} autoComplete="off" {...form.register('gstin')} />}
              </Field>
              <Field label="State code" error={errors.stateCode?.message} hint="GST state code, e.g. 29.">
                {(p) => <Input {...p} autoComplete="off" maxLength={4} {...form.register('stateCode')} />}
              </Field>
            </div>
          </>
        ) : (
          <Notice tone="info">Phone, email and GSTIN are hidden for your role, so they cannot be changed here.</Notice>
        )}
        {canNotes ? (
          <Field label="Notes" error={errors.notes?.message} hint="Allergies, preferences. Visible only to roles allowed to read notes.">
            {(p) => <Textarea {...p} maxLength={1000} {...form.register('notes')} />}
          </Field>
        ) : null}
        <fieldset>
          <legend className="text-sm font-medium text-ink">Marketing consent</legend>
          <p className="text-sm text-ink-faint">Tick only the channels this customer has agreed to. Changes are recorded in the audit log.</p>
          <div className="mt-1 flex flex-wrap gap-x-6">
            <Checkbox label="SMS" {...form.register('marketingSms')} />
            <Checkbox label="Email" {...form.register('marketingEmail')} />
            <Checkbox label="WhatsApp" {...form.register('marketingWhatsapp')} />
          </div>
        </fieldset>
        {save.isError ? <Notice tone="bad">{errorMessage(save.error)}</Notice> : null}
      </form>
    </Modal>
  );
}
