import { supplierSchema } from '@serveos/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Button, Card, Checkbox, DataTable, EmptyState, Field, Input, Modal, Textarea, useToast, type Column } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { ActiveBadge, Loadable, Toolbar, TwoLine } from '../../catalogue/common';
import { payloadResolver, validatePayload } from '../../catalogue/forms';
import { useSuppliers } from '../queries';
import type { Supplier } from '../types';

type SupplierForm = Pick<Supplier, 'name' | 'contactName' | 'phone' | 'email' | 'gstin' | 'address' | 'isActive'>;

const toPayload = (values: SupplierForm) => ({ ...values, email: values.email.trim() });

function SupplierDialog({ supplier, onClose }: { supplier: Supplier | null; onClose: () => void }) {
  const notify = useToast();
  const queryClient = useQueryClient();
  const form = useForm<SupplierForm>({
    resolver: payloadResolver(supplierSchema, toPayload),
    defaultValues: supplier
      ? { name: supplier.name, contactName: supplier.contactName, phone: supplier.phone, email: supplier.email, gstin: supplier.gstin, address: supplier.address, isActive: supplier.isActive }
      : { name: '', contactName: '', phone: '', email: '', gstin: '', address: '', isActive: true },
  });
  const { errors } = form.formState;
  const save = useMutation({
    mutationFn: (body: unknown) => (supplier ? api<Supplier>(`/suppliers/${supplier.id}`, { method: 'PATCH', body }) : api<Supplier>('/suppliers', { method: 'POST', body })),
    onSuccess: (saved) => {
      for (const key of ['suppliers', 'ingredients', 'purchase-orders']) void queryClient.invalidateQueries({ queryKey: [key] });
      notify(`Supplier ${saved.name} saved`);
      onClose();
    },
    onError: (err) => notify(errorMessage(err), 'bad'),
  });
  const submit = form.handleSubmit((values) => {
    const result = validatePayload(supplierSchema, toPayload, values);
    if (result.ok) save.mutate(result.data);
  });

  return (
    <Modal open onClose={onClose} title={supplier ? `Edit ${supplier.name}` : 'New supplier'}>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <Field label="Supplier name" error={errors.name?.message}>
          {(p) => <Input {...p} autoComplete="off" autoFocus {...form.register('name')} />}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Contact person" error={errors.contactName?.message}>
            {(p) => <Input {...p} autoComplete="off" {...form.register('contactName')} />}
          </Field>
          <Field label="Phone" error={errors.phone?.message}>
            {(p) => <Input {...p} type="tel" autoComplete="off" {...form.register('phone')} />}
          </Field>
          <Field label="Email" error={errors.email?.message}>
            {(p) => <Input {...p} type="email" autoComplete="off" {...form.register('email')} />}
          </Field>
          <Field label="GSTIN" error={errors.gstin?.message}>
            {(p) => <Input {...p} autoComplete="off" className="uppercase" {...form.register('gstin')} />}
          </Field>
        </div>
        <Field label="Address" error={errors.address?.message}>
          {(p) => <Textarea {...p} rows={2} {...form.register('address')} />}
        </Field>
        <Checkbox label="Active (can be chosen on new purchase orders)" {...form.register('isActive')} />
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={save.isPending}>
            {supplier ? 'Save supplier' : 'Create supplier'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function SuppliersTab() {
  const { can } = useAuth();
  const canManage = can('purchasing.manage');
  const suppliers = useSuppliers();
  const [editing, setEditing] = useState<Supplier | 'new' | null>(null);

  const columns: Array<Column<Supplier>> = [
    { key: 'name', header: 'Supplier', cell: (s) => <TwoLine primary={s.name} secondary={s.gstin ? `GSTIN ${s.gstin}` : undefined} /> },
    { key: 'contact', header: 'Contact', cell: (s) => (s.contactName || s.phone || s.email ? <TwoLine primary={<span className="font-normal">{s.contactName || s.phone || s.email}</span>} secondary={[s.contactName ? s.phone : '', s.contactName || s.phone ? s.email : ''].filter(Boolean).join(' · ') || undefined} /> : <span className="text-ink-faint">—</span>) },
    { key: 'address', header: 'Address', cell: (s) => (s.address ? <span className="text-ink-soft">{s.address}</span> : <span className="text-ink-faint">—</span>), className: 'min-w-40' },
    { key: 'status', header: 'Status', cell: (s) => <ActiveBadge active={s.isActive} /> },
  ];

  return (
    <Card>
      {canManage ? (
        <Toolbar className="justify-end">
          <Button variant="primary" onClick={() => setEditing('new')}>
            <Plus className="h-4 w-4" aria-hidden />
            New supplier
          </Button>
        </Toolbar>
      ) : null}
      <Loadable query={suppliers}>
        {(data) => (
          <DataTable
            columns={columns}
            rows={data}
            rowKey={(s) => s.id}
            onRowClick={canManage ? setEditing : undefined}
            empty={<EmptyState title="No suppliers yet" description="Add the vendors you buy ingredients from, then raise purchase orders to them." action={canManage ? <Button variant="primary" onClick={() => setEditing('new')}>New supplier</Button> : undefined} />}
          />
        )}
      </Loadable>
      {editing && canManage ? <SupplierDialog supplier={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
    </Card>
  );
}
