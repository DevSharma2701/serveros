import { ORDER_TYPES } from '@serveos/shared';
import clsx from 'clsx';
import { LogOut, Maximize, Minimize, RefreshCw, Settings as SettingsIcon, Store, Volume2, VolumeX, Wifi, WifiOff } from 'lucide-react';
import type { ReactNode } from 'react';
import { ORDER_TYPE_LABEL } from '../lib/format';
import type { Settings } from '../lib/settings';
import type { BoardView, ConnectionStatus, Station } from '../lib/types';

const CONTROL = 'flex min-h-14 items-center justify-center gap-2 rounded-control border-2 px-4 text-lg font-bold';
const IDLE = 'border-kds-line bg-kds-card text-kds-soft hover:bg-kds-raised';
const SELECTED = 'border-kds-ink bg-kds-ink text-kds-bg';

function Chip({ selected, onClick, children }: { selected: boolean; onClick(): void; children: ReactNode }) {
  return (
    <button type="button" aria-pressed={selected} onClick={onClick} className={clsx(CONTROL, selected ? SELECTED : IDLE)}>
      {children}
    </button>
  );
}

const CONNECTION = {
  live: { label: 'Live', detail: 'Orders arrive instantly', Icon: Wifi, tone: 'border-kds-ok text-kds-ok' },
  reconnecting: { label: 'Reconnecting', detail: 'Live link lost, checking every 5 s', Icon: RefreshCw, tone: 'border-kds-warn text-kds-warn' },
  offline: { label: 'Offline', detail: 'Server unreachable', Icon: WifiOff, tone: 'border-kds-bad bg-kds-bad text-kds-bg' },
} as const;

export function ConnectionPill({ status }: { status: ConnectionStatus }) {
  const { label, detail, Icon, tone } = CONNECTION[status];
  return (
    <div role="status" aria-label={`Connection: ${label}. ${detail}`} title={detail} className={clsx(CONTROL, tone)}>
      <Icon aria-hidden className={clsx('size-6', status === 'reconnecting' && 'animate-spin')} />
      {label}
    </div>
  );
}

interface Props {
  outletName: string;
  userName: string;
  view: BoardView;
  activeCount: number | null;
  onView(view: BoardView): void;
  stations: Station[];
  stationId: string;
  orderType: Settings['orderType'];
  onFilter(patch: Partial<Pick<Settings, 'stationId' | 'orderType'>>): void;
  status: ConnectionStatus;
  sound: 'on' | 'off' | 'blocked' | 'unsupported';
  onToggleSound(): void;
  fullscreen: boolean;
  onToggleFullscreen(): void;
  settingsOpen: boolean;
  onToggleSettings(): void;
  onSignOut(): void;
  onChangeOutlet?: () => void;
}

const SOUND = {
  on: { label: 'Sound on', Icon: Volume2, tone: 'border-kds-ok text-kds-ok', title: 'New-order sound is playing. Tap to mute.' },
  off: { label: 'Sound off', Icon: VolumeX, tone: IDLE, title: 'Tap to play a sound when a new order arrives.' },
  blocked: { label: 'Sound blocked: tap to enable', Icon: VolumeX, tone: 'border-kds-warn text-kds-warn', title: 'The browser needs a tap before it will play sound.' },
  unsupported: { label: 'Sound unavailable', Icon: VolumeX, tone: IDLE, title: 'This browser cannot play the alert sound.' },
} as const;

export function Toolbar(p: Props) {
  const sound = SOUND[p.sound];
  return (
    <header className="flex flex-col gap-3 border-b-2 border-kds-line bg-kds-card px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="mr-auto min-w-0">
          <h1 className="truncate text-2xl font-extrabold">Kitchen · {p.outletName}</h1>
          <p className="truncate text-base text-kds-faint">{p.userName}</p>
        </div>
        <ConnectionPill status={p.status} />
        <button type="button" aria-pressed={p.sound === 'on'} disabled={p.sound === 'unsupported'} title={sound.title} onClick={p.onToggleSound} className={clsx(CONTROL, sound.tone)}>
          <sound.Icon aria-hidden className="size-6" />
          {sound.label}
        </button>
        <button type="button" aria-pressed={p.fullscreen} onClick={p.onToggleFullscreen} className={clsx(CONTROL, IDLE)}>
          {p.fullscreen ? <Minimize aria-hidden className="size-6" /> : <Maximize aria-hidden className="size-6" />}
          {p.fullscreen ? 'Exit full screen' : 'Full screen'}
        </button>
        <button type="button" aria-expanded={p.settingsOpen} aria-controls="kds-settings" onClick={p.onToggleSettings} className={clsx(CONTROL, p.settingsOpen ? SELECTED : IDLE)}>
          <SettingsIcon aria-hidden className="size-6" />
          Settings
        </button>
        {p.onChangeOutlet && (
          <button type="button" onClick={p.onChangeOutlet} className={clsx(CONTROL, IDLE)}>
            <Store aria-hidden className="size-6" />
            Outlet
          </button>
        )}
        <button type="button" onClick={p.onSignOut} className={clsx(CONTROL, IDLE)}>
          <LogOut aria-hidden className="size-6" />
          Sign out
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div role="group" aria-label="View" className="flex gap-2">
          <Chip selected={p.view === 'active'} onClick={() => p.onView('active')}>
            Active{p.activeCount !== null && ` (${p.activeCount})`}
          </Chip>
          <Chip selected={p.view === 'recent'} onClick={() => p.onView('recent')}>
            Recently ready
          </Chip>
        </div>
        <div role="group" aria-label="Filter by station" className="flex flex-wrap gap-2">
          <Chip selected={p.stationId === 'ALL'} onClick={() => p.onFilter({ stationId: 'ALL' })}>
            All stations
          </Chip>
          {p.stations.map((s) => (
            <Chip key={s.id} selected={p.stationId === s.id} onClick={() => p.onFilter({ stationId: s.id })}>
              {s.name}
            </Chip>
          ))}
        </div>
        <div role="group" aria-label="Filter by order type" className="flex flex-wrap gap-2">
          <Chip selected={p.orderType === 'ALL'} onClick={() => p.onFilter({ orderType: 'ALL' })}>
            All types
          </Chip>
          {ORDER_TYPES.map((type) => (
            <Chip key={type} selected={p.orderType === type} onClick={() => p.onFilter({ orderType: type })}>
              {ORDER_TYPE_LABEL[type]}
            </Chip>
          ))}
        </div>
      </div>
    </header>
  );
}
