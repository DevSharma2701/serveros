import { PackagePlus } from 'lucide-react';
import { useState } from 'react';
import { Button, Card, DataTable, EmptyState, Modal, type Column } from '@/components/ui';
import { useAuth, useOutlet } from '@/lib/auth';
import { dateTime, money } from '@/lib/format';
import { Loadable, Toolbar, TwoLine } from '../../catalogue/common';
import { useGoodsReceipts, useStockLookups, useSuppliers } from '../queries';
import { lineValueMinor, qty } from '../quantity';
import type { GoodsReceipt } from '../types';
import { ReceiveGoodsDialog } from './ReceiveGoodsDialog';

type ReceiptLine = GoodsReceipt['items'][number];

const receiptValue = (grn: GoodsReceipt): number => grn.items.reduce((sum, item) => sum + lineValueMinor(item.quantity, item.unitCostMinor), 0);
const dateOnly = (iso: string | null): string => (iso ? new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(iso)) : '');

function ReceiptDialog({ grn, supplierName, onClose }: { grn: GoodsReceipt; supplierName: string; onClose: () => void }) {
  const outlet = useOutlet();
  const lookups = useStockLookups();
  const value = receiptValue(grn);
  const columns: Array<Column<ReceiptLine>> = [
    { key: 'ingredient', header: 'Ingredient', cell: (l) => <span className="font-medium">{lookups.ingredientName(l.ingredientId)}</span> },
    { key: 'qty', header: 'Received', align: 'right', cell: (l) => `${qty(l.quantity)} ${lookups.unitCode(l.unitId)}` },
    { key: 'base', header: 'Added to stock', align: 'right', cell: (l) => `${qty(l.baseQuantity)} ${lookups.baseUnitCode(l.ingredientId)}` },
    { key: 'cost', header: 'Unit cost', align: 'right', cell: (l) => money(l.unitCostMinor) },
    { key: 'value', header: 'Line value', align: 'right', cell: (l) => money(lineValueMinor(l.quantity, l.unitCostMinor)) },
  ];
  return (
    <Modal open onClose={onClose} title={grn.grnNumber} description={`Received ${dateTime(grn.receivedAt, outlet.timezone)} at ${outlet.name}`} size="lg" footer={<Button onClick={onClose}>Close</Button>}>
      <div className="flex flex-col gap-4">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-4">
          {[
            ['Purchase order', grn.purchaseOrder?.poNumber ?? 'None (direct receipt)'],
            ['Supplier', supplierName || 'Not recorded'],
            ['Supplier invoice', [grn.invoiceNumber, dateOnly(grn.invoiceDate)].filter(Boolean).join(' · ') || 'Not recorded'],
            ['Invoice total', grn.invoiceTotalMinor != null ? money(grn.invoiceTotalMinor) : 'Not recorded'],
          ].map(([label, text]) => (
            <div key={label}>
              <dt className="text-xs font-semibold uppercase tracking-wide text-ink-faint">{label}</dt>
              <dd className="mt-0.5 text-ink">{text}</dd>
            </div>
          ))}
        </dl>
        {grn.note ? <p className="text-sm text-ink-soft">Note: {grn.note}</p> : null}
        <div className="rounded-control border border-line">
          <DataTable columns={columns} rows={grn.items} rowKey={(l) => l.id} />
        </div>
        <p className="text-right text-sm text-ink-soft">
          Value of goods received <span className="tabular font-semibold text-ink">{money(value)}</span>
        </p>
      </div>
    </Modal>
  );
}

export function GoodsReceiptsTab() {
  const outlet = useOutlet();
  const { can } = useAuth();
  const canManage = can('purchasing.manage');
  const receipts = useGoodsReceipts();
  const suppliers = useSuppliers();
  const [viewing, setViewing] = useState<GoodsReceipt | null>(null);
  const [receiving, setReceiving] = useState(false);
  const supplierName = (id: string | null) => suppliers.data?.find((s) => s.id === id)?.name ?? '';

  const columns: Array<Column<GoodsReceipt>> = [
    { key: 'number', header: 'Receipt', cell: (g) => <TwoLine primary={<span className="tabular">{g.grnNumber}</span>} secondary={dateTime(g.receivedAt, outlet.timezone)} /> },
    { key: 'po', header: 'Purchase order', cell: (g) => (g.purchaseOrder ? <span className="tabular">{g.purchaseOrder.poNumber}</span> : <span className="text-ink-faint">Direct receipt</span>) },
    { key: 'supplier', header: 'Supplier', cell: (g) => supplierName(g.supplierId) || <span className="text-ink-faint">—</span> },
    { key: 'invoice', header: 'Supplier invoice', cell: (g) => (g.invoiceNumber ? <TwoLine primary={<span className="font-normal">{g.invoiceNumber}</span>} secondary={dateOnly(g.invoiceDate) || undefined} /> : <span className="text-ink-faint">—</span>) },
    { key: 'lines', header: 'Lines', align: 'right', cell: (g) => g.items.length },
    { key: 'value', header: 'Goods value', align: 'right', cell: (g) => money(receiptValue(g)) },
    { key: 'total', header: 'Invoice total', align: 'right', cell: (g) => (g.invoiceTotalMinor != null ? money(g.invoiceTotalMinor) : <span className="text-ink-faint">—</span>) },
  ];

  return (
    <Card>
      {canManage ? (
        <Toolbar className="justify-between">
          <p className="text-sm text-ink-soft">To receive against a purchase order, open the order on the Purchase orders tab.</p>
          <Button onClick={() => setReceiving(true)}>
            <PackagePlus className="h-4 w-4" aria-hidden />
            Receive without an order
          </Button>
        </Toolbar>
      ) : null}
      <Loadable query={receipts}>
        {(data) => (
          <DataTable
            columns={columns}
            rows={data}
            rowKey={(g) => g.id}
            onRowClick={setViewing}
            empty={<EmptyState title="No goods received yet" description="Each delivery recorded here adds to stock and updates the average cost of the ingredients." />}
          />
        )}
      </Loadable>
      {viewing ? <ReceiptDialog grn={viewing} supplierName={supplierName(viewing.supplierId)} onClose={() => setViewing(null)} /> : null}
      {receiving && canManage ? <ReceiveGoodsDialog po={null} onClose={() => setReceiving(false)} /> : null}
    </Card>
  );
}
