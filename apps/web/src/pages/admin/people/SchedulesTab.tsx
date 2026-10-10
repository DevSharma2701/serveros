import { scheduleSchema } from '@serveos/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { Button, Card, ConfirmDialog, DataTable, EmptyState, ErrorState, Field, Input, Modal, Notice, Select, SkeletonRows, useToast, type Column } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth, useOutlet } from '@/lib/auth';
import { dateTime } from '@/lib/format';
import { useStaff } from './StaffFields';
import { duration, zonedToIso } from './time';
import type { Schedule } from './types';

type Errors = Partial<Record<'userId' | 'startsAt' | 'endsAt' | 'note', string>>;

function AddShift({ open, onClose }: { open: boolean; onClose: () => void }) {
  const outlet = useOutlet();
  const notify = useToast();
  const queryClient = useQueryClient();
  const formId = useId();
  const staff = useStaff();
  const [values, setValues] = useState({ userId: '', startsAt: '', endsAt: '', note: '' });
  const [errors, setErrors] = useState<Errors>({});
  useEffect(() => {
    if (open) {
      setValues({ userId: '', startsAt: '', endsAt: '', note: '' });
      setErrors({});
    }
  }, [open]);
  const set = (key: keyof typeof values) => (e: { target: { value: string } }) => setValues((v) => ({ ...v, [key]: e.target.value }));

  // Only people who can work in this outlet can be scheduled here.
  const eligible = (staff.data ?? []).filter((m) => m.status !== 'DISABLED' && (m.allOutlets || m.assignments.some((a) => a.outletId === outlet.id)));

  const create = useMutation({
    mutationFn: (body: { userId: string; startsAt: string; endsAt: string; note: string }) => api<Schedule>('/schedules', { method: 'POST', body }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['staff', 'schedules'] });
      notify('Shift added to the schedule');
      onClose();
    },
  });

  const submit = () => {
    const next: Errors = {};
    const startsAt = zonedToIso(values.startsAt, outlet.timezone);
    const endsAt = zonedToIso(values.endsAt, outlet.timezone);
    if (!values.userId) next.userId = 'Choose who is working';
    if (!startsAt) next.startsAt = 'Enter when the shift starts';
    if (!endsAt) next.endsAt = 'Enter when the shift ends';
    else if (startsAt && endsAt <= startsAt) next.endsAt = 'The shift must end after it starts';
    const parsed = scheduleSchema.safeParse({ userId: values.userId, startsAt, endsAt, note: values.note });
    if (!parsed.success && Object.keys(next).length === 0) {
      for (const issue of parsed.error.issues) next[issue.path[0] as keyof Errors] ??= issue.message;
    }
    setErrors(next);
    if (parsed.success && Object.keys(next).length === 0) create.mutate(parsed.data);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add a scheduled shift"
      description={`For ${outlet.name}. Times are in ${outlet.timezone} time.`}
      footer={
        <>
          <Button onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant="primary" loading={create.isPending}>
            Add shift
          </Button>
        </>
      }
    >
      <form
        id={formId}
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="Staff member" error={errors.userId ?? (staff.isError ? `Could not load staff: ${errorMessage(staff.error)}` : undefined)}>
          {(p) => (
            <Select {...p} value={values.userId} onChange={set('userId')} disabled={staff.isLoading}>
              <option value="">{staff.isLoading ? 'Loading staff…' : 'Choose a person'}</option>
              {eligible.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.role.name})
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Starts" error={errors.startsAt}>
            {(p) => <Input {...p} type="datetime-local" value={values.startsAt} onChange={set('startsAt')} />}
          </Field>
          <Field label="Ends" error={errors.endsAt}>
            {(p) => <Input {...p} type="datetime-local" value={values.endsAt} min={values.startsAt || undefined} onChange={set('endsAt')} />}
          </Field>
        </div>
        <Field label="Note" error={errors.note} hint="Optional, e.g. the section they cover.">
          {(p) => <Input {...p} maxLength={200} value={values.note} onChange={set('note')} />}
        </Field>
        {create.isError ? <Notice tone="bad">{errorMessage(create.error)}</Notice> : null}
      </form>
    </Modal>
  );
}

/** Planned shifts for the current outlet (from yesterday onwards, as the API returns them). */
export function SchedulesTab() {
  const { can } = useAuth();
  const outlet = useOutlet();
  const notify = useToast();
  const queryClient = useQueryClient();
  const manage = can('staff.manage');
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Schedule | null>(null);
  const query = useQuery({ queryKey: ['staff', 'schedules', outlet.id], queryFn: () => api<Schedule[]>('/schedules') });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/schedules/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['staff', 'schedules'] });
      notify('Shift removed from the schedule');
      setRemoving(null);
    },
  });

  const columns: Array<Column<Schedule>> = [
    { key: 'who', header: 'Staff member', cell: (s) => <span className="font-medium">{s.user.name}</span> },
    { key: 'start', header: 'Starts', cell: (s) => <span className="whitespace-nowrap">{dateTime(s.startsAt, outlet.timezone)}</span> },
    { key: 'end', header: 'Ends', cell: (s) => <span className="whitespace-nowrap">{dateTime(s.endsAt, outlet.timezone)}</span> },
    { key: 'length', header: 'Length', cell: (s) => <span className="whitespace-nowrap">{duration(s.startsAt, s.endsAt)}</span>, className: 'hidden sm:table-cell' },
    { key: 'note', header: 'Note', cell: (s) => s.note, className: 'hidden md:table-cell' },
    ...(manage
      ? [
          {
            key: 'actions',
            header: <span className="sr-only">Actions</span>,
            align: 'right' as const,
            cell: (s: Schedule) => (
              <Button size="sm" variant="ghost" aria-label={`Remove ${s.user.name}'s shift on ${dateTime(s.startsAt, outlet.timezone)}`} onClick={() => setRemoving(s)}>
                <Trash2 className="h-4 w-4" aria-hidden />
              </Button>
            ),
          },
        ]
      : []),
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-soft">
          Upcoming shifts at {outlet.name}, in {outlet.timezone} time.
        </p>
        {manage ? (
          <Button onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" aria-hidden /> Add shift
          </Button>
        ) : null}
      </div>
      <Card className="overflow-hidden">
        {query.isError && !query.data ? (
          <ErrorState message={errorMessage(query.error)} onRetry={() => void query.refetch()} />
        ) : !query.data ? (
          <SkeletonRows />
        ) : (
          <DataTable columns={columns} rows={query.data} rowKey={(s) => s.id} empty={<EmptyState title="Nothing scheduled" description="Shifts planned for this outlet will be listed here." />} />
        )}
      </Card>
      <AddShift open={adding} onClose={() => setAdding(false)} />
      <ConfirmDialog
        open={removing !== null}
        onClose={() => {
          setRemoving(null);
          remove.reset();
        }}
        danger
        title="Remove this shift?"
        description={removing ? `${removing.user.name}, ${dateTime(removing.startsAt, outlet.timezone)} to ${dateTime(removing.endsAt, outlet.timezone)}.` : undefined}
        confirmLabel="Remove shift"
        pending={remove.isPending}
        error={remove.isError ? errorMessage(remove.error) : null}
        onConfirm={() => removing && remove.mutate(removing.id)}
      />
    </div>
  );
}
