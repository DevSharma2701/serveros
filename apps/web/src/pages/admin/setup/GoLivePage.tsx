import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, CircleDashed } from 'lucide-react';
import { Card, cn, ErrorState, Notice, PageHeader, SkeletonRows } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';

interface StatusItem {
  key: string;
  area: 'Server' | 'Restaurant';
  label: string;
  state: 'ready' | 'attention' | 'not_set';
  detail: string;
}
interface SystemStatus {
  items: StatusItem[];
  ready: number;
  total: number;
}

const LOOK = {
  ready: { icon: CheckCircle2, colour: 'text-ok', word: 'Ready' },
  attention: { icon: AlertTriangle, colour: 'text-warn', word: 'Needs attention' },
  not_set: { icon: CircleDashed, colour: 'text-ink-faint', word: 'Not set up' },
} as const;

/** What still stands between this installation and real customers, as the server itself sees it. */
export function GoLivePage() {
  const status = useQuery({ queryKey: ['system-status'], queryFn: () => api<SystemStatus>('/system/status') });
  return (
    <>
      <PageHeader title="Go-live checklist" description="What is ready for real customers and what is still on a placeholder. Server settings are changed in the server's environment (see docs/credentials.md), not on this page." />
      {status.isPending ? (
        <Card>
          <SkeletonRows />
        </Card>
      ) : status.isError ? (
        <Card>
          <ErrorState message={errorMessage(status.error)} onRetry={() => void status.refetch()} />
        </Card>
      ) : (
        <div className="flex flex-col gap-6">
          <Notice tone={status.data.ready === status.data.total ? 'ok' : 'info'} title={`${status.data.ready} of ${status.data.total} ready`}>
            This list covers what the software can check for itself. It cannot check your tax treatment, your backups or your privacy notice: see docs/deployment.md.
          </Notice>
          {(['Server', 'Restaurant'] as const).map((area) => (
            <section key={area}>
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-faint">{area === 'Server' ? 'Server settings' : 'Your restaurant'}</h2>
              <Card>
                <ul className="divide-y divide-line">
                  {status.data.items.filter((i) => i.area === area).map((item) => {
                    const look = LOOK[item.state];
                    return (
                      <li key={item.key} className="flex items-start gap-3 px-4 py-3">
                        <look.icon className={cn('mt-0.5 h-5 w-5 shrink-0', look.colour)} aria-hidden />
                        <div className="min-w-0 flex-1">
                          <p className="font-medium text-ink">{item.label}</p>
                          <p className="text-sm text-ink-soft">{item.detail}</p>
                        </div>
                        <span className={cn('shrink-0 text-sm font-semibold', look.colour)}>{look.word}</span>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
