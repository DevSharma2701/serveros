import { UserPlus } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Card, DataTable, EmptyState, ErrorState, PageHeader, Segmented, SkeletonRows, StatusBadge, type Column } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { AttendanceTab } from './AttendanceTab';
import { DevInviteNote, InviteStaffForm } from './InviteStaffForm';
import { SchedulesTab } from './SchedulesTab';
import { StaffDrawer } from './StaffDrawer';
import { useStaff } from './StaffFields';
import type { StaffMember } from './types';

type Tab = 'team' | 'schedules' | 'attendance';

function Team({ onInvite }: { onInvite: () => void }) {
  const { me, can } = useAuth();
  const staff = useStaff();
  const [openId, setOpenId] = useState<string | null>(null);
  const manage = can('staff.manage');
  const outletName = (id: string) => me?.outlets.find((o) => o.id === id)?.name;
  // Read the open person from the live list so the drawer reflects every save.
  const open = staff.data?.find((m) => m.id === openId) ?? null;

  const outletsOf = (m: StaffMember) => {
    if (m.allOutlets) return 'All outlets';
    const names = m.assignments.map((a) => outletName(a.outletId)).filter((n): n is string => Boolean(n));
    const hidden = m.assignments.length - names.length;
    if (m.assignments.length === 0) return 'None assigned';
    return [...names, ...(hidden > 0 ? [`${hidden} other`] : [])].join(', ');
  };

  const columns: Array<Column<StaffMember>> = [
    {
      key: 'name',
      header: 'Name',
      cell: (m) => (
        <div className="min-w-0">
          <p className="font-medium">
            {m.name} {m.id === me?.user.id ? <Badge>You</Badge> : null}
          </p>
          <p className="break-all text-xs text-ink-soft">{m.email}</p>
        </div>
      ),
    },
    {
      key: 'role',
      header: 'Role',
      cell: (m) => (
        <div>
          <p>{m.role.name}</p>
          {m.jobTitle ? <p className="text-xs text-ink-soft">{m.jobTitle}</p> : null}
        </div>
      ),
    },
    { key: 'outlets', header: 'Outlets', cell: (m) => outletsOf(m), className: 'hidden sm:table-cell' },
    { key: 'grants', header: 'Extra permissions', align: 'right', cell: (m) => (m.grants.length ? m.grants.length : ''), className: 'hidden lg:table-cell' },
    { key: 'status', header: 'Status', cell: (m) => <StatusBadge status={m.status} /> },
  ];

  return (
    <>
      <Card className="overflow-hidden">
        {staff.isError && !staff.data ? (
          <ErrorState message={errorMessage(staff.error)} onRetry={() => void staff.refetch()} />
        ) : !staff.data ? (
          <SkeletonRows rows={6} />
        ) : (
          <DataTable
            columns={columns}
            rows={staff.data}
            rowKey={(m) => m.id}
            onRowClick={manage ? (m) => setOpenId(m.id) : undefined}
            empty={
              <EmptyState
                title="No staff yet"
                description="Invite the people who will use ServeOS."
                action={
                  manage ? (
                    <Button variant="primary" onClick={onInvite}>
                      Invite staff
                    </Button>
                  ) : undefined
                }
              />
            }
          />
        )}
      </Card>
      {manage ? <p className="mt-2 text-sm text-ink-faint">Select a person to change their role, outlets, permissions or account.</p> : null}
      <StaffDrawer member={open} onClose={() => setOpenId(null)} />
    </>
  );
}

export function StaffPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState<Tab>('team');
  const [inviting, setInviting] = useState(false);
  const manage = can('staff.manage');
  return (
    <div>
      <PageHeader
        title="Staff"
        description="Who can use ServeOS, what they may do, and when they work."
        actions={
          manage && tab === 'team' ? (
            <Button variant="primary" onClick={() => setInviting(true)}>
              <UserPlus className="h-4 w-4" aria-hidden /> Invite staff
            </Button>
          ) : undefined
        }
      />
      <div className="mb-4 max-w-full overflow-x-auto">
        <Segmented
          label="Staff section"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'team', label: 'Team' },
            { value: 'schedules', label: 'Schedules' },
            { value: 'attendance', label: 'Attendance' },
          ]}
        />
      </div>
      {tab === 'team' ? (
        <div className="flex flex-col gap-4">
          {manage ? <DevInviteNote /> : null}
          <div>
            <Team onInvite={() => setInviting(true)} />
          </div>
        </div>
      ) : tab === 'schedules' ? (
        <SchedulesTab />
      ) : (
        <AttendanceTab />
      )}
      <InviteStaffForm open={inviting} onClose={() => setInviting(false)} />
    </div>
  );
}
