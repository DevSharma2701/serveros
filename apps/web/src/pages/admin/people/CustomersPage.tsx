import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge, Button, Card, DataTable, EmptyState, ErrorState, PageHeader, Pagination, SearchInput, SkeletonRows, cn, type Column } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { Paged } from '@/lib/types';
import { CustomerDrawer } from './CustomerDrawer';
import { CustomerForm } from './CustomerForm';
import type { CustomerRow } from './types';

const PAGE_SIZE = 25;

export function CustomersPage() {
  const { can } = useAuth();
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);
  const [form, setForm] = useState<{ customer: CustomerRow | null } | null>(null);

  // Wait for a pause in typing before asking the server.
  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const query = useQuery({
    queryKey: ['customers', 'list', q, page],
    queryFn: () => api<Paged<CustomerRow>>('/customers', { query: { q, page, pageSize: PAGE_SIZE } }),
    placeholderData: keepPreviousData,
  });

  const columns: Array<Column<CustomerRow>> = [
    { key: 'name', header: 'Name', cell: (c) => <span className="font-medium">{c.name}</span> },
    { key: 'phone', header: 'Phone', cell: (c) => <span className="tabular whitespace-nowrap">{c.phone ?? ''}</span> },
    { key: 'email', header: 'Email', cell: (c) => c.email, className: 'hidden md:table-cell' },
    {
      key: 'consent',
      header: 'Marketing consent',
      className: 'hidden lg:table-cell',
      cell: (c) => {
        const channels = [c.marketingSms && 'SMS', c.marketingEmail && 'Email', c.marketingWhatsapp && 'WhatsApp'].filter((v): v is string => Boolean(v));
        return channels.length ? (
          <span className="flex flex-wrap gap-1">
            {channels.map((ch) => (
              <Badge key={ch} tone="ok">
                {ch}
              </Badge>
            ))}
          </span>
        ) : (
          <span className="text-ink-faint">None</span>
        );
      },
    },
    { key: 'points', header: 'Points', align: 'right', cell: (c) => c.loyaltyPoints.toLocaleString('en-IN') },
  ];

  return (
    <div>
      <PageHeader
        title="Customers"
        description="Search customers, see their order history and manage loyalty points."
        actions={
          can('customer.manage') ? (
            <Button variant="primary" onClick={() => setForm({ customer: null })}>
              <Plus className="h-4 w-4" aria-hidden /> Add customer
            </Button>
          ) : undefined
        }
      />
      <Card className="overflow-hidden">
        <div className="border-b border-line p-3">
          <SearchInput aria-label="Search customers by name or phone" placeholder="Search by name, or at least 4 digits of the phone" value={search} onChange={(e) => setSearch(e.target.value)} onClear={() => setSearch('')} className="max-w-md" />
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
              rowKey={(c) => c.id}
              onRowClick={(c) => setOpenId(c.id)}
              empty={
                q ? (
                  <EmptyState title="No customers match" description={`Nothing found for "${q}". Phone search needs at least 4 digits.`} />
                ) : (
                  <EmptyState
                    title="No customers yet"
                    description="Customers added here or at the till appear in this list."
                    action={
                      can('customer.manage') ? (
                        <Button variant="primary" onClick={() => setForm({ customer: null })}>
                          Add customer
                        </Button>
                      ) : undefined
                    }
                  />
                )
              }
            />
            <Pagination page={query.data.page} pageSize={query.data.pageSize} total={query.data.total} onPage={setPage} />
          </div>
        )}
      </Card>

      <CustomerDrawer customerId={openId} onClose={() => setOpenId(null)} onEdit={(customer) => setForm({ customer })} />
      <CustomerForm open={form !== null} onClose={() => setForm(null)} customer={form?.customer ?? null} />
    </div>
  );
}
