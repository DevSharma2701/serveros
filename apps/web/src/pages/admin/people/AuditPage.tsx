import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Card, DataTable, EmptyState, ErrorState, Field, Input, PageHeader, Pagination, Select, SkeletonRows, cn, type Column } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dateTime, money, percent, titleCase } from '@/lib/format';
import type { Paged } from '@/lib/types';
import type { AuditEvent } from './types';

const PAGE_SIZE = 50;

/** Action prefixes the API writes (the part before the dot), with a plain name for each. */
const AREAS: Array<{ prefix: string; label: string }> = [
  { prefix: 'order.', label: 'Orders' },
  { prefix: 'payment.', label: 'Payments and refunds' },
  { prefix: 'shift.', label: 'Cash shifts' },
  { prefix: 'staff.', label: 'Staff and permissions' },
  { prefix: 'auth.', label: 'Sign-in and passwords' },
  { prefix: 'customer.', label: 'Customers' },
  { prefix: 'loyalty.', label: 'Loyalty points' },
  { prefix: 'menu.', label: 'Menu' },
  { prefix: 'discount.', label: 'Discounts' },
  { prefix: 'tax.', label: 'Taxes' },
  { prefix: 'inventory.', label: 'Inventory' },
  { prefix: 'recipe.', label: 'Recipes' },
  { prefix: 'purchasing.', label: 'Purchasing' },
  { prefix: 'restaurant.', label: 'Restaurant settings' },
  { prefix: 'outlet.', label: 'Outlets' },
  { prefix: 'report.', label: 'Report exports' },
];

/** "order.void_item" -> "Order: void item". */
const actionLabel = (action: string): string => {
  const [area, ...rest] = action.split('.');
  return rest.length ? `${titleCase(area ?? '')}: ${rest.join(' ').replace(/_/g, ' ')}` : titleCase(action);
};

/** "expectedCashMinor" -> "Expected cash". */
const keyLabel = (key: string): string => {
  const words = key.replace(/(Minor|Bps)$/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

function valueText(key: string, value: unknown, currency: string): string {
  if (value === null || value === undefined || value === '') return 'none';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number') return key.endsWith('Minor') ? money(value, currency) : key.endsWith('Bps') ? percent(value) : value.toLocaleString('en-IN');
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((v) => valueText('', v, currency)).join(', ') || 'none';
  return Object.entries(value as Record<string, unknown>)
    .map(([k, v]) => `${keyLabel(k)}: ${valueText(k, v, currency)}`)
    .join('; ');
}

/** The event's metadata as a readable list instead of raw JSON. */
function Details({ metadata, currency }: { metadata: unknown; currency: string }) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return metadata ? <span>{valueText('', metadata, currency)}</span> : null;
  const entries = Object.entries(metadata as Record<string, unknown>);
  if (entries.length === 0) return null;
  return (
    <dl className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs">
      {entries.map(([key, value]) => (
        <div key={key} className="flex min-w-0 gap-1">
          <dt className="shrink-0 text-ink-faint">{keyLabel(key)}:</dt>
          <dd className="min-w-0 break-words text-ink">{valueText(key, value, currency)}</dd>
        </div>
      ))}
    </dl>
  );
}

export function AuditPage() {
  const { me } = useAuth();
  const currency = me?.restaurant?.currency ?? 'INR';
  const [action, setAction] = useState('');
  const [entityInput, setEntityInput] = useState('');
  const [entityType, setEntityType] = useState('');
  const [page, setPage] = useState(1);
  const outletName = (id: string | null) => (id ? (me?.outlets.find((o) => o.id === id)?.name ?? '') : '');

  useEffect(() => {
    const timer = setTimeout(() => {
      setEntityType(entityInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [entityInput]);

  const query = useQuery({
    queryKey: ['audit', action, entityType, page],
    queryFn: () => api<Paged<AuditEvent>>('/audit-events', { query: { page, pageSize: PAGE_SIZE, action, entityType } }),
    placeholderData: keepPreviousData,
  });

  const columns: Array<Column<AuditEvent>> = [
    { key: 'time', header: 'Time', cell: (e) => <span className="tabular whitespace-nowrap">{dateTime(e.createdAt)}</span> },
    {
      key: 'actor',
      header: 'Who',
      cell: (e) => (
        <div>
          <p>{e.actorName || 'System'}</p>
          {outletName(e.outletId) ? <p className="text-xs text-ink-soft">{outletName(e.outletId)}</p> : null}
        </div>
      ),
    },
    { key: 'action', header: 'Action', cell: (e) => <span className="font-medium">{actionLabel(e.action)}</span> },
    { key: 'entity', header: 'Record', cell: (e) => <span title={e.entityId}>{e.entityType.replace(/([a-z])([A-Z])/g, '$1 $2')}</span>, className: 'hidden sm:table-cell' },
    { key: 'details', header: 'Details', cell: (e) => <Details metadata={e.metadata} currency={currency} />, className: 'min-w-[14rem]' },
  ];

  return (
    <div>
      <PageHeader title="Audit log" description="A permanent record of sensitive actions: who did what, and when. Newest first." />
      <Card className="overflow-hidden">
        <div className="grid gap-3 border-b border-line p-3 sm:grid-cols-[16rem_16rem]">
          <Field label="Area">
            {(p) => (
              <Select
                {...p}
                value={action}
                onChange={(e) => {
                  setAction(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">All actions</option>
                {AREAS.map((a) => (
                  <option key={a.prefix} value={a.prefix}>
                    {a.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Record type" hint="Exact name, e.g. Order, User, CashShift.">
            {(p) => <Input {...p} value={entityInput} onChange={(e) => setEntityInput(e.target.value)} maxLength={60} autoComplete="off" />}
          </Field>
        </div>
        {query.isError && !query.data ? (
          <ErrorState message={errorMessage(query.error)} onRetry={() => void query.refetch()} />
        ) : !query.data ? (
          <SkeletonRows rows={8} />
        ) : (
          <div className={cn(query.isPlaceholderData && 'opacity-60')}>
            <DataTable
              columns={columns}
              rows={query.data.items}
              rowKey={(e) => e.id}
              empty={action || entityType ? <EmptyState title="No matching events" description="Nothing has been recorded for these filters." /> : <EmptyState title="Nothing recorded yet" description="Refunds, discounts, role changes and other sensitive actions will appear here." />}
            />
            <Pagination page={query.data.page} pageSize={query.data.pageSize} total={query.data.total} onPage={setPage} />
          </div>
        )}
      </Card>
    </div>
  );
}
