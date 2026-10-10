import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LogIn, LogOut } from 'lucide-react';
import { Badge, Button, Card, DataTable, EmptyState, ErrorState, SkeletonRows, useToast, type Column } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth, useOutlet } from '@/lib/auth';
import { dateTime } from '@/lib/format';
import { duration } from './time';
import type { AttendanceRow } from './types';

/** Clock in/out for the signed-in person, and the attendance record of the current outlet. */
export function AttendanceTab() {
  const { me } = useAuth();
  const outlet = useOutlet();
  const notify = useToast();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['staff', 'attendance', outlet.id], queryFn: () => api<AttendanceRow[]>('/attendance') });
  const mine = query.data?.find((a) => a.userId === me?.user.id && a.clockOutAt === null);

  const clock = useMutation({
    mutationFn: (direction: 'in' | 'out') => api<AttendanceRow>(`/attendance/clock-${direction}`, { method: 'POST' }),
    onSuccess: (_row, direction) => {
      void queryClient.invalidateQueries({ queryKey: ['staff', 'attendance'] });
      notify(direction === 'in' ? `You are clocked in at ${outlet.name}` : 'You are clocked out');
    },
    // A refusal here is usually "already clocked in" at another outlet: show the server's words.
    onError: (err) => notify(errorMessage(err), 'bad'),
  });

  const columns: Array<Column<AttendanceRow>> = [
    { key: 'who', header: 'Staff member', cell: (a) => <span className="font-medium">{a.user.name}</span> },
    { key: 'in', header: 'Clocked in', cell: (a) => <span className="whitespace-nowrap">{dateTime(a.clockInAt, outlet.timezone)}</span> },
    { key: 'out', header: 'Clocked out', cell: (a) => (a.clockOutAt ? <span className="whitespace-nowrap">{dateTime(a.clockOutAt, outlet.timezone)}</span> : <Badge tone="ok">On the clock</Badge>) },
    { key: 'length', header: 'Time worked', align: 'right', cell: (a) => (a.clockOutAt ? duration(a.clockInAt, a.clockOutAt) : '') },
  ];

  return (
    <div className="flex flex-col gap-3">
      <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <p className="font-semibold text-ink">{mine ? 'You are clocked in' : 'You are not clocked in here'}</p>
          <p className="text-sm text-ink-soft">{mine ? `Since ${dateTime(mine.clockInAt, outlet.timezone)} at ${outlet.name}.` : `Clock in when you start work at ${outlet.name}.`}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" disabled={Boolean(mine) || !query.data} loading={clock.isPending && clock.variables === 'in'} onClick={() => clock.mutate('in')}>
            <LogIn className="h-4 w-4" aria-hidden /> Clock in
          </Button>
          <Button disabled={!query.data} loading={clock.isPending && clock.variables === 'out'} onClick={() => clock.mutate('out')}>
            <LogOut className="h-4 w-4" aria-hidden /> Clock out
          </Button>
        </div>
      </Card>
      <Card className="overflow-hidden">
        {query.isError && !query.data ? (
          <ErrorState message={errorMessage(query.error)} onRetry={() => void query.refetch()} />
        ) : !query.data ? (
          <SkeletonRows />
        ) : (
          <DataTable columns={columns} rows={query.data} rowKey={(a) => a.id} empty={<EmptyState title="No attendance recorded" description="Clock-ins at this outlet will be listed here, newest first." />} />
        )}
      </Card>
      <p className="text-sm text-ink-faint">Showing the most recent 200 entries for {outlet.name}.</p>
    </div>
  );
}
