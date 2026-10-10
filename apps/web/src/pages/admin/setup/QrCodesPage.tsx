import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Printer, RefreshCw } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { Badge, Button, Card, Checkbox, ConfirmDialog, EmptyState, ErrorState, Field, Input, Notice, PageHeader, SkeletonRows, useToast } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth, useOutlet } from '@/lib/auth';

interface QrTable {
  id: string;
  name: string;
  area: string;
  qrToken: string;
}
interface QrCodes {
  enabled: boolean;
  outlet: string;
  onlinePayment: string | null;
  webUrl: string;
  tables: QrTable[];
}

const BASE_KEY = 'serveos.qrBaseUrl';
const linkFor = (base: string, token: string) => `${base.replace(/\/+$/, '')}/t/${token}`;

/** One printable card: the QR image is drawn in the browser; the secret link never leaves this page. */
function QrCard({ table, base, outlet, canManage, onRegenerate }: { table: QrTable; base: string; outlet: string; canManage: boolean; onRegenerate: () => void }) {
  const [svg, setSvg] = useState('');
  const link = linkFor(base, table.qrToken);
  useEffect(() => {
    let cancelled = false;
    QRCode.toString(link, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }).then((markup) => !cancelled && setSvg(`data:image/svg+xml;utf8,${encodeURIComponent(markup)}`));
    return () => {
      cancelled = true;
    };
  }, [link]);
  return (
    <li className="qr-card flex flex-col items-center gap-2 rounded-card border border-line bg-surface p-4 text-center">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">{outlet} · {table.area}</p>
      <p className="text-2xl font-bold text-ink">Table {table.name}</p>
      {svg ? <img src={svg} alt={`QR code for table ${table.name}`} className="h-44 w-44" /> : <div className="h-44 w-44 animate-pulse rounded bg-sunken" />}
      <p className="text-sm font-medium text-ink">Scan to order and pay</p>
      <div className="flex gap-2 print:hidden">
        <Button asChild size="sm" variant="ghost">
          <a href={link} target="_blank" rel="noreferrer">
            Open
          </a>
        </Button>
        {canManage ? (
          <Button size="sm" variant="ghost" onClick={onRegenerate}>
            <RefreshCw className="h-4 w-4" aria-hidden /> Replace
          </Button>
        ) : null}
      </div>
    </li>
  );
}

export function QrCodesPage() {
  const outlet = useOutlet();
  const { can } = useAuth();
  const notify = useToast();
  const queryClient = useQueryClient();
  const [replacing, setReplacing] = useState<QrTable | null>(null);
  const [base, setBase] = useState(() => localStorage.getItem(BASE_KEY) ?? window.location.origin);

  const codes = useQuery({ queryKey: ['qr-codes', outlet.id], queryFn: () => api<QrCodes>('/qr-codes') });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['qr-codes'] });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api(`/outlets/${outlet.id}`, { method: 'PATCH', body: { qrOrderingEnabled: enabled } }),
    onSuccess: (_, enabled) => {
      notify(enabled ? 'Guests can now order from the table QR codes' : 'QR ordering switched off. Existing codes show "not active".');
      refresh();
    },
    onError: (err) => notify(errorMessage(err), 'bad'),
  });
  const regenerate = useMutation({
    mutationFn: (tableId: string) => api(`/qr-codes/${tableId}/regenerate`, { method: 'POST' }),
    onSuccess: () => {
      notify('New code created. Print it and remove the old one from the table.');
      setReplacing(null);
      refresh();
    },
    onError: (err) => notify(errorMessage(err), 'bad'),
  });

  const localOnly = /localhost|127\.0\.0\.1/.test(base);

  return (
    <>
      <style>{`@media print { body * { visibility: hidden; } .qr-sheet, .qr-sheet * { visibility: visible; } .qr-sheet { position: absolute; inset: 0 auto auto 0; width: 100%; } .qr-card { break-inside: avoid; border: 1px solid #999; } }`}</style>
      <PageHeader
        title="Table QR codes"
        description="Guests scan the code on their table, order from their phone and pay online. A paid order goes straight to the kitchen; unpaid orders never reach it and expire after 15 minutes."
        actions={
          <Button variant="primary" disabled={!codes.data?.tables.length} onClick={() => window.print()}>
            <Printer className="h-4 w-4" aria-hidden /> Print all
          </Button>
        }
      />
      {codes.isPending ? (
        <Card>
          <SkeletonRows />
        </Card>
      ) : codes.isError ? (
        <Card>
          <ErrorState message={errorMessage(codes.error)} onRetry={() => void codes.refetch()} />
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          <Card className="flex flex-col gap-4 p-4 print:hidden">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <Badge tone={codes.data.enabled ? 'ok' : 'neutral'}>{codes.data.enabled ? 'Guest ordering is ON' : 'Guest ordering is OFF'}</Badge>
                <span className="text-sm text-ink-soft">for {codes.data.outlet}</span>
              </div>
              {can('outlet.manage') ? (
                <Checkbox label="Let guests order from QR codes at this outlet" checked={codes.data.enabled} disabled={toggle.isPending} onChange={(e) => toggle.mutate(e.target.checked)} />
              ) : (
                <span className="text-sm text-ink-faint">Only someone who manages outlets can switch this.</span>
              )}
            </div>
            {codes.data.onlinePayment === 'dev' ? (
              <Notice tone="warn" title="Online payment is running on the development simulator">
                No real payment provider is connected, so guests see a "payment succeeds / fails" simulator and no money moves. Do not use this with real customers until a payment gateway has been added.
              </Notice>
            ) : codes.data.onlinePayment === 'razorpay' ? (
              <Notice tone="ok" title="Online payment: Razorpay">
                Guests pay in Razorpay's checkout. Check in your Razorpay dashboard whether you are using test keys or live keys before real customers scan these codes.
              </Notice>
            ) : codes.data.onlinePayment === null ? (
              <Notice tone="warn" title="No online payment is configured">
                Guests can place an order, but it only goes to the kitchen after staff record the payment at the counter.
              </Notice>
            ) : null}
            <Field label="Address guests' phones will open" hint="The web address of this app as phones can reach it. It is encoded into every QR code.">
              {(p) => (
                <Input
                  {...p}
                  type="url"
                  value={base}
                  onChange={(e) => {
                    setBase(e.target.value);
                    localStorage.setItem(BASE_KEY, e.target.value);
                  }}
                />
              )}
            </Field>
            {localOnly ? (
              <Notice tone="info" title="“localhost” only works on this computer">
                A phone cannot open a localhost address. For a test on your Wi-Fi, use this computer's network address (for example http://192.168.1.20:5173); see docs/qr-ordering.md for the three settings to change.
              </Notice>
            ) : null}
          </Card>
          {codes.data.tables.length === 0 ? (
            <Card>
              <EmptyState title="No tables yet" description="Add tables in Outlet set-up first." />
            </Card>
          ) : (
            <ul className="qr-sheet grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
              {codes.data.tables.map((t) => (
                <QrCard key={t.id} table={t} base={base} outlet={codes.data.outlet} canManage={can('table.manage')} onRegenerate={() => setReplacing(t)} />
              ))}
            </ul>
          )}
        </div>
      )}
      <ConfirmDialog
        open={!!replacing}
        onClose={() => setReplacing(null)}
        title={`Replace the code for table ${replacing?.name ?? ''}?`}
        description="The printed code on that table stops working immediately. Use this if a code was copied or misused."
        confirmLabel="Replace code"
        danger
        pending={regenerate.isPending}
        onConfirm={() => replacing && regenerate.mutate(replacing.id)}
      />
    </>
  );
}
