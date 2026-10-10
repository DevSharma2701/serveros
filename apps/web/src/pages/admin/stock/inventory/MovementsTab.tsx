import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Card, DataTable, EmptyState, Pagination, Select, type Column, type Tone } from '@/components/ui';
import { api } from '@/lib/api';
import { useOutlet } from '@/lib/auth';
import { dateTime, titleCase } from '@/lib/format';
import type { Paged } from '@/lib/types';
import { Loadable, Toolbar } from '../../catalogue/common';
import { useStockLookups } from '../queries';
import { isNegative, qty, signedQty } from '../quantity';
import { MOVEMENT_TYPES, type Movement, type MovementType } from '../types';

const PAGE_SIZE = 50;
const TYPE_TONE: Record<MovementType, Tone> = { RECEIPT: 'ok', SALE: 'neutral', SALE_REVERSAL: 'info', WASTAGE: 'bad', ADJUSTMENT: 'warn', TRANSFER_OUT: 'info', TRANSFER_IN: 'info', COUNT_CORRECTION: 'warn' };
const REF_LABEL: Record<string, string> = { ORDER_ITEM: 'Order line', GRN: 'Goods receipt', TRANSFER: 'Transfer', COUNT: 'Stock count', MANUAL: 'Manual entry' };

export function MovementsTab() {
  const outlet = useOutlet();
  const lookups = useStockLookups();
  const [ingredientId, setIngredientId] = useState('');
  const [type, setType] = useState('');
  const [page, setPage] = useState(1);
  const filters = { ingredientId: ingredientId || undefined, type: type || undefined, page, pageSize: PAGE_SIZE };
  const movements = useQuery({
    queryKey: ['stock', 'movements', outlet.id, filters],
    queryFn: () => api<Paged<Movement>>('/inventory/movements', { query: filters }),
    placeholderData: (previous) => previous,
  });

  const columns: Array<Column<Movement>> = [
    { key: 'when', header: 'When', cell: (m) => <span className="whitespace-nowrap text-ink-soft">{dateTime(m.createdAt, outlet.timezone)}</span> },
    { key: 'ingredient', header: 'Ingredient', cell: (m) => <span className="font-medium">{m.ingredientName}</span> },
    { key: 'type', header: 'Type', cell: (m) => <Badge tone={TYPE_TONE[m.type] ?? 'neutral'}>{titleCase(m.type)}</Badge> },
    {
      key: 'delta',
      header: 'Change',
      align: 'right',
      cell: (m) => (
        <span className={isNegative(m.quantityDelta) ? 'text-bad' : 'text-ok'}>
          {signedQty(m.quantityDelta)} <span className="text-ink-faint">{lookups.baseUnitCode(m.ingredientId)}</span>
        </span>
      ),
    },
    { key: 'balance', header: 'Balance after', align: 'right', cell: (m) => <>{qty(m.balanceAfter)} <span className="text-ink-faint">{lookups.baseUnitCode(m.ingredientId)}</span></> },
    { key: 'reason', header: 'Reason', cell: (m) => (m.reason ? <span className="text-ink-soft">{m.reason}</span> : <span className="text-ink-faint">—</span>), className: 'min-w-40' },
    {
      key: 'ref',
      header: 'Reference',
      cell: (m) => (
        <span className="whitespace-nowrap text-ink-soft" title={m.refId}>
          {REF_LABEL[m.refType] ?? titleCase(m.refType || 'none')}
          {m.refId ? <span className="tabular text-ink-faint"> #{m.refId.slice(-6)}</span> : null}
        </span>
      ),
    },
  ];

  return (
    <Card>
      <Toolbar>
        <Select aria-label="Ingredient" className="w-auto min-w-44 flex-1 basis-44 sm:flex-none" value={ingredientId} onChange={(e) => (setIngredientId(e.target.value), setPage(1))}>
          <option value="">All ingredients</option>
          {(lookups.ingredients.data ?? []).map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </Select>
        <Select aria-label="Movement type" className="w-auto min-w-40 flex-1 basis-40 sm:flex-none" value={type} onChange={(e) => (setType(e.target.value), setPage(1))}>
          <option value="">All types</option>
          {MOVEMENT_TYPES.map((t) => (
            <option key={t} value={t}>
              {titleCase(t)}
            </option>
          ))}
        </Select>
      </Toolbar>
      <Loadable query={movements} rows={10}>
        {(data) => (
          <>
            <DataTable
              columns={columns}
              rows={data.items}
              rowKey={(m) => m.id}
              empty={<EmptyState title="No stock movements" description={ingredientId || type ? 'Nothing matches these filters.' : 'Receipts, sales, wastage, adjustments, transfers and count corrections will be listed here.'} />}
            />
            <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
          </>
        )}
      </Loadable>
    </Card>
  );
}
