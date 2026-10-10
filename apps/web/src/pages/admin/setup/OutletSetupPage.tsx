import { PageHeader } from '@/components/ui';
import { useAuth, useOutlet } from '@/lib/auth';
import { FloorSection } from './FloorSection';
import { RegistersSection } from './RegistersSection';
import { StationsSection } from './StationsSection';

/** Physical set-up of the outlet currently selected in the sidebar. */
export function OutletSetupPage() {
  const outlet = useOutlet();
  const { can } = useAuth();
  // The API lets a role read stations with kitchen.view and registers with shift.operate; without them the section is left out.
  const seesRegisters = can('shift.operate');
  return (
    <div>
      <PageHeader title="Outlet set-up" description={`Tables, kitchen stations and cash registers for ${outlet.name}. Switch outlet in the sidebar to set up another one.`} />
      <div className="flex flex-col gap-4">
        <FloorSection />
        {can('kitchen.view') ? <StationsSection /> : null}
        {seesRegisters ? <RegistersSection /> : null}
      </div>
    </div>
  );
}
