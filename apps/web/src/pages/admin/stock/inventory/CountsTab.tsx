import { stockCountSchema } from '@serveos/shared';
import { useMutation } from '@tanstack/react-query';
import { ClipboardCheck, Plus } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Badge, Button, Card, ConfirmDialog, DataTable, EmptyState, ErrorState, Field, Input, Modal, Notice, Select, SkeletonRows, StatusBadge, useToast, type Column } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth, useOutlet } from '@/lib/auth';
import { dateTime } from '@/lib/format';
import { InlineError, Loadable, Toolbar } from '../../catalogue/common';
import { errorAt, payloadResolver, validatePayload, type Report } from '../../catalogue/forms';
import { useInvalidateStock, useStockCount, useStockCounts, useStockLookups, type StockLookups } from '../queries';
import { isNegative, isQty, isZero, qty, signedQty } from '../quantity';
import type { Ingredient, StockCount, StockCountLine } from '../types';

interface CountForm {
  note: string;
  lines: Array<{ ingredientId: string; countedQty: string; unitId: string }>;
}

/** Lines left empty were not counted and are left out; their stock is not touched. */
function toPayload(values: CountForm, report: Report) {
  values.lines.forEach((line, i) => {
    if (line.countedQty.trim() && !isQty(line.countedQty)) report(`lines.${i}.countedQty`, 'Enter a quantity with up to 4 decimals');
  });
  const counted = values.lines.filter((l) => l.countedQty.trim() && isQty(l.countedQty));
  if (counted.length === 0) report('lines.root', 'Enter the counted quantity for at least one ingredient');
  return { note: values.note, lines: counted.map((l) => ({ ...l, countedQty: l.countedQty.trim() })) };
}

function NewCountForm({ ingredients, lookups, onClose }: { ingredients: Ingredient[]; lookups: StockLookups; onClose: () => void }) {
  const notify = useToast();
  const invalidate = useInvalidateStock();
  const form = useForm<CountForm>({
    resolver: payloadResolver(stockCountSchema, toPayload),
    defaultValues: { note: '', lines: ingredients.map((i) => ({ ingredientId: i.id, countedQty: '', unitId: i.baseUnitId })) },
  });
  const { errors } = form.formState;
  const save = useMutation({
    mutationFn: (body: unknown) => api<StockCount>('/inventory/counts', { method: 'POST', body }),
    onSuccess: (saved) => {
      invalidate();
      notify(`Draft count saved with ${saved.lines?.length ?? 0} line${saved.lines?.length === 1 ? '' : 's'}. Review and post it to correct stock.`);
      onClose();
    },
    onError: (err) => notify(errorMessage(err), 'bad'),
  });
  const submit = form.handleSubmit((values) => {
    const result = validatePayload(stockCountSchema, toPayload, values);
    if (result.ok) save.mutate(result.data);
  });

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <Notice tone="info">Count what is physically there and type it in. Leave an ingredient empty if you did not count it. Saving creates a draft; stock changes only when the count is posted.</Notice>
      <Field label="Note" error={errors.note?.message} hint="Optional, for example “month-end count”.">
        {(p) => <Input {...p} autoComplete="off" {...form.register('note')} />}
      </Field>
      <InlineError message={errorAt(errors, 'lines', 'root')} />
      <ul className="flex flex-col divide-y divide-line rounded-control border border-line">
        {ingredients.map((ingredient, i) => {
          const error = errors.lines?.[i]?.countedQty?.message;
          return (
            <li key={ingredient.id} className="grid grid-cols-[minmax(0,1fr)_6.5rem_5rem] items-center gap-2 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-ink">{ingredient.name}</p>
                <p className="truncate text-xs text-ink-faint">{ingredient.sku}</p>
                {error ? (
                  <p role="alert" className="text-xs text-bad">
                    {error}
                  </p>
                ) : null}
              </div>
              <Input aria-label={`Counted quantity of ${ingredient.name}`} aria-invalid={error ? true : undefined} inputMode="decimal" autoComplete="off" placeholder="Counted" className="tabular text-right" {...form.register(`lines.${i}.countedQty`)} />
              <Select aria-label={`Unit for ${ingredient.name}`} className="px-2" {...form.register(`lines.${i}.unitId`)}>
                {lookups.unitsFor(ingredient.id).map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.code}
                  </option>
                ))}
              </Select>
            </li>
          );
        })}
      </ul>
      <div className="sticky -bottom-4 -mx-5 -mb-4 rounded-b-card flex flex-wrap justify-end gap-2 border-t border-line bg-surface px-5 py-3">
        <Button onClick={onClose} disabled={save.isPending}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={save.isPending}>
          Save draft count
        </Button>
      </div>
    </form>
  );
}

function NewCountDialog({ onClose }: { onClose: () => void }) {
  const outlet = useOutlet();
  const lookups = useStockLookups();
  const failed = [lookups.ingredients, lookups.units].find((q) => q.isError);
  const active = (lookups.ingredients.data ?? []).filter((i) => i.isActive);
  return (
    <Modal open onClose={onClose} title="New stock count" description={`Physical count at ${outlet.name}`} size="lg">
      {failed ? (
        <ErrorState message={errorMessage(failed.error)} onRetry={() => (void lookups.ingredients.refetch(), void lookups.units.refetch())} />
      ) : lookups.ingredients.isPending || lookups.units.isPending ? (
        <SkeletonRows rows={6} />
      ) : active.length === 0 ? (
        <EmptyState title="No ingredients to count" description="Add ingredients on the Ingredients tab first." />
      ) : (
        <NewCountForm ingredients={active} lookups={lookups} onClose={onClose} />
      )}
    </Modal>
  );
}

function VarianceCell({ line, unit }: { line: StockCountLine; unit: string }) {
  if (line.varianceQty == null) return <span className="text-ink-faint">—</span>;
  if (isZero(line.varianceQty)) return <Badge tone="ok">Matches</Badge>;
  const short = isNegative(line.varianceQty);
  return (
    <span className={`whitespace-nowrap font-semibold ${short ? 'text-bad' : 'text-warn'}`}>
      {signedQty(line.varianceQty)} {unit} <span className="font-normal">({short ? 'short' : 'over'})</span>
    </span>
  );
}

function CountDialog({ countId, onClose }: { countId: string; onClose: () => void }) {
  const notify = useToast();
  const outlet = useOutlet();
  const { can } = useAuth();
  const lookups = useStockLookups();
  const invalidate = useInvalidateStock();
  const count = useStockCount(countId);
  const [confirming, setConfirming] = useState(false);
  const post = useMutation({
    mutationFn: () => api<StockCount>(`/inventory/counts/${countId}/post`, { method: 'POST' }),
    onSuccess: () => {
      invalidate();
      setConfirming(false);
      notify('Stock count posted. System stock now matches the counted figures.');
    },
  });
  const posted = count.data?.status === 'POSTED';
  const lines = [...(count.data?.lines ?? [])].sort((a, b) => lookups.ingredientName(a.ingredientId).localeCompare(lookups.ingredientName(b.ingredientId)));

  const columns: Array<Column<StockCountLine>> = [
    { key: 'ingredient', header: 'Ingredient', cell: (l) => <span className="font-medium">{lookups.ingredientName(l.ingredientId)}</span> },
    ...(posted ? [{ key: 'theoretical', header: 'Theoretical', align: 'right' as const, cell: (l: StockCountLine) => `${qty(l.theoreticalQty)} ${lookups.baseUnitCode(l.ingredientId)}` }] : []),
    { key: 'counted', header: 'Counted', align: 'right', cell: (l) => `${qty(l.countedQty)} ${lookups.baseUnitCode(l.ingredientId)}` },
    ...(posted ? [{ key: 'variance', header: 'Variance', align: 'right' as const, cell: (l: StockCountLine) => <VarianceCell line={l} unit={lookups.baseUnitCode(l.ingredientId)} /> }] : []),
  ];

  return (
    <Modal
      open
      onClose={onClose}
      title={posted ? 'Posted stock count' : 'Draft stock count'}
      description={count.data ? `Started ${dateTime(count.data.createdAt, outlet.timezone)}${count.data.postedAt ? ` · posted ${dateTime(count.data.postedAt, outlet.timezone)}` : ''}${count.data.note ? ` · ${count.data.note}` : ''}` : undefined}
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          {count.data?.status === 'DRAFT' && can('inventory.manage') ? (
            <Button variant="primary" onClick={() => (post.reset(), setConfirming(true))}>
              <ClipboardCheck className="h-4 w-4" aria-hidden />
              Post count
            </Button>
          ) : null}
        </>
      }
    >
      {count.isPending ? (
        <SkeletonRows rows={5} />
      ) : count.isError ? (
        <ErrorState message={errorMessage(count.error)} onRetry={() => void count.refetch()} />
      ) : (
        <div className="flex flex-col gap-3">
          {posted ? (
            <Notice tone="ok">Posted. Theoretical is what the system held at the moment of posting; variance is counted minus theoretical. Stock was corrected to the counted figure.</Notice>
          ) : (
            <Notice tone="info">Draft. Quantities are shown in each ingredient’s base unit. Nothing has changed in stock yet; the comparison with theoretical stock appears after posting.</Notice>
          )}
          <div className="rounded-control border border-line">
            <DataTable columns={columns} rows={lines} rowKey={(l) => l.id} />
          </div>
        </div>
      )}
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => post.mutate()}
        title="Post this stock count?"
        description={`Posting corrects system stock at ${outlet.name} to the counted figure for each of the ${lines.length} counted ingredient${lines.length === 1 ? '' : 's'}, and records the difference as a count correction. It cannot be undone.`}
        confirmLabel="Post and correct stock"
        pending={post.isPending}
        error={post.isError ? errorMessage(post.error) : null}
      />
    </Modal>
  );
}

export function CountsTab() {
  const outlet = useOutlet();
  const { can } = useAuth();
  const canManage = can('inventory.manage');
  const counts = useStockCounts();
  const [creating, setCreating] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);

  const columns: Array<Column<StockCount>> = [
    { key: 'created', header: 'Started', cell: (c) => <span className="whitespace-nowrap font-medium">{dateTime(c.createdAt, outlet.timezone)}</span> },
    { key: 'status', header: 'Status', cell: (c) => <StatusBadge status={c.status} /> },
    { key: 'lines', header: 'Ingredients counted', align: 'right', cell: (c) => c._count?.lines ?? c.lines?.length ?? 0 },
    { key: 'posted', header: 'Posted', cell: (c) => (c.postedAt ? <span className="whitespace-nowrap text-ink-soft">{dateTime(c.postedAt, outlet.timezone)}</span> : <span className="text-ink-faint">Not posted</span>) },
    { key: 'note', header: 'Note', cell: (c) => c.note || <span className="text-ink-faint">—</span> },
  ];

  return (
    <Card>
      {canManage ? (
        <Toolbar className="justify-end">
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" aria-hidden />
            New stock count
          </Button>
        </Toolbar>
      ) : null}
      <Loadable query={counts}>
        {(data) => (
          <DataTable
            columns={columns}
            rows={data}
            rowKey={(c) => c.id}
            onRowClick={(c) => setViewing(c.id)}
            empty={<EmptyState title="No stock counts yet" description="A stock count compares what is physically on the shelf with theoretical stock, and corrects the system to match." action={canManage ? <Button variant="primary" onClick={() => setCreating(true)}>New stock count</Button> : undefined} />}
          />
        )}
      </Loadable>
      {creating && canManage ? <NewCountDialog onClose={() => setCreating(false)} /> : null}
      {viewing ? <CountDialog countId={viewing} onClose={() => setViewing(null)} /> : null}
    </Card>
  );
}
