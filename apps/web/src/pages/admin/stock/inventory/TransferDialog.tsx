import { stockTransferSchema } from '@serveos/shared';
import { useMutation } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import { Button, Field, Input, Modal, Notice, Select, useToast } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth, useOutlet } from '@/lib/auth';
import { payloadResolver, validatePayload } from '../../catalogue/forms';
import { emptyLine, LinesEditor, type Line } from '../LinesEditor';
import { useInvalidateStock, useStockLookups } from '../queries';

interface TransferForm {
  toOutletId: string;
  note: string;
  lines: Line[];
}

const toPayload = (values: TransferForm) => values;

/** Moves stock from the selected outlet to another one. Stock that is not there cannot be sent. */
export function TransferDialog({ onClose }: { onClose: () => void }) {
  const notify = useToast();
  const outlet = useOutlet();
  const { me } = useAuth();
  const lookups = useStockLookups();
  const invalidate = useInvalidateStock();
  const targets = (me?.outlets ?? []).filter((o) => o.id !== outlet.id);
  const form = useForm<TransferForm>({ resolver: payloadResolver(stockTransferSchema, toPayload), defaultValues: { toOutletId: targets.length === 1 ? targets[0]!.id : '', note: '', lines: [emptyLine()] } });
  const { errors } = form.formState;
  const save = useMutation({
    mutationFn: (body: unknown) => api<{ transferId: string; toOutletId: string; lines: number }>('/inventory/transfers', { method: 'POST', body }),
    onSuccess: (result) => {
      invalidate();
      notify(`Transferred ${result.lines} ingredient${result.lines === 1 ? '' : 's'} to ${targets.find((o) => o.id === result.toOutletId)?.name ?? 'the other outlet'}`);
      onClose();
    },
    onError: (err) => notify(errorMessage(err), 'bad'),
  });
  const submit = form.handleSubmit((values) => {
    const result = validatePayload(stockTransferSchema, toPayload, values);
    if (result.ok) save.mutate(result.data);
  });

  return (
    <Modal open onClose={onClose} title="Transfer stock" description={`From ${outlet.name} to another outlet. Both outlets get a movement in their stock history.`} size="lg">
      {targets.length === 0 ? (
        <Notice tone="info">You only have access to one outlet, so there is nowhere to transfer to.</Notice>
      ) : (
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="To outlet" error={errors.toOutletId?.message}>
              {(p) => (
                <Select {...p} {...form.register('toOutletId')}>
                  <option value="">Choose an outlet</option>
                  {targets.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Note" error={errors.note?.message} hint="Optional.">
              {(p) => <Input {...p} autoComplete="off" {...form.register('note')} />}
            </Field>
          </div>
          <Controller control={form.control} name="lines" render={({ field }) => <LinesEditor value={field.value} onChange={field.onChange} errors={errors.lines} lookups={lookups} addLabel="Add ingredient" />} />
          <div className="flex flex-wrap justify-end gap-2">
            <Button onClick={onClose} disabled={save.isPending}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={save.isPending}>
              Transfer stock
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
