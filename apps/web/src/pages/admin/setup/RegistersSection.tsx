import { zodResolver } from '@hookform/resolvers/zod';
import { registerSchema } from '@serveos/shared';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import { Badge, Button, Checkbox, DataTable, EmptyState, ErrorState, Field, Input, SkeletonRows, type Column } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth, useOutlet } from '@/lib/auth';
import { dateTime } from '@/lib/format';
import { ActiveBadge, FormModal, SetupSection, useSave } from './components/SetupSection';
import type { CashRegister } from './types';

type RegisterInput = z.input<typeof registerSchema>;
type RegisterOutput = z.output<typeof registerSchema>;

function RegisterModal({ open, onClose, register }: { open: boolean; onClose: () => void; register: CashRegister | null }) {
  const form = useForm<RegisterInput, unknown, RegisterOutput>({ resolver: zodResolver(registerSchema), defaultValues: { name: '', isActive: true } });
  const { errors } = form.formState;
  const { reset } = form;
  useEffect(() => {
    if (open) reset({ name: register?.name ?? '', isActive: register?.isActive ?? true });
  }, [open, register, reset]);
  const save = useSave((body: RegisterOutput) => (register ? api<CashRegister>(`/registers/${register.id}`, { method: 'PATCH', body }) : api<CashRegister>('/registers', { method: 'POST', body })), {
    invalidate: ['registers', 'shift'],
    success: (saved) => `${saved.name} ${register ? 'updated' : 'added'}`,
    onDone: onClose,
  });
  return (
    <FormModal open={open} onClose={onClose} title={register ? `Edit ${register.name}` : 'Add a cash register'} submitLabel={register ? 'Save changes' : 'Add register'} pending={save.isPending} error={save.error} onSubmit={form.handleSubmit((v) => save.mutate(v))}>
      <Field label="Register name" error={errors.name ? 'Enter a name (up to 120 characters)' : undefined} hint="For example Counter 1, Bar till.">
        {(p) => <Input {...p} autoFocus {...form.register('name')} />}
      </Field>
      {register ? (
        <div>
          <Checkbox label="Register is in use" {...form.register('isActive')} />
          <p className="pl-8 text-sm text-ink-faint">A register with an open shift cannot be taken out of use until the shift is closed.</p>
        </div>
      ) : null}
    </FormModal>
  );
}

/** The tills of this outlet. A cash shift is opened on one register at a time. */
export function RegistersSection() {
  const { can } = useAuth();
  const outlet = useOutlet();
  const manage = can('shift.manage');
  const [form, setForm] = useState<{ register: CashRegister | null } | null>(null);
  const query = useQuery({ queryKey: ['registers', outlet.id], queryFn: () => api<CashRegister[]>('/registers') });

  const columns: Array<Column<CashRegister>> = [
    { key: 'name', header: 'Register', cell: (r) => <span className="font-medium">{r.name}</span> },
    {
      key: 'shift',
      header: 'Shift',
      cell: (r) => {
        const open = r.shifts[0];
        return open ? (
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone="ok">Open</Badge>
            <span className="text-sm text-ink-soft">
              {open.openedByName}, since {dateTime(open.openedAt, outlet.timezone)}
            </span>
          </span>
        ) : (
          <span className="text-ink-soft">No open shift</span>
        );
      },
    },
    { key: 'status', header: 'Status', cell: (r) => <ActiveBadge active={r.isActive} /> },
  ];

  return (
    <SetupSection
      title="Cash registers"
      description="Each register has its own cash drawer and its own shifts."
      readOnly={!manage}
      action={
        manage ? (
          <Button onClick={() => setForm({ register: null })}>
            <Plus className="h-4 w-4" aria-hidden /> Add register
          </Button>
        ) : undefined
      }
    >
      {query.isError && !query.data ? (
        <ErrorState message={errorMessage(query.error)} onRetry={() => void query.refetch()} />
      ) : !query.data ? (
        <SkeletonRows rows={2} />
      ) : (
        <DataTable columns={columns} rows={query.data} rowKey={(r) => r.id} onRowClick={manage ? (register) => setForm({ register }) : undefined} empty={<EmptyState title="No cash registers" description="Add a register so cashiers can open a shift." />} />
      )}
      <RegisterModal open={form !== null} onClose={() => setForm(null)} register={form?.register ?? null} />
    </SetupSection>
  );
}
