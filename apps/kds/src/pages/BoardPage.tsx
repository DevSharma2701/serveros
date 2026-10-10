import { AlertTriangle, ChefHat, LoaderCircle, WifiOff, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { SettingsPanel } from '../components/SettingsPanel';
import { TicketCard } from '../components/TicketCard';
import { Toolbar } from '../components/Toolbar';
import { useBoard } from '../lib/board';
import { formatAge, formatClock, ORDER_TYPE_LABEL } from '../lib/format';
import { useRealtime } from '../lib/realtime';
import { useSettings, type Settings } from '../lib/settings';
import { beep, disableSound, enableSound, soundSupported, useSoundRunning } from '../lib/sound';
import type { BoardView, ConnectionStatus, OutletRef, Ticket } from '../lib/types';

/** Safety net under the socket: slow while it is healthy, fast while it is down. */
export const POLL_LIVE_MS = 20_000;
export const POLL_DEGRADED_MS = 5_000;
const NEW_TICKET_HIGHLIGHT_MS = 20_000;

interface Props {
  outlet: OutletRef;
  userName: string;
  /** Holds kitchen.update. Without it the board is read-only. */
  canUpdate: boolean;
  onSignOut(): void;
  onChangeOutlet?: () => void;
}

const matches = (t: Ticket, f: Pick<Settings, 'stationId' | 'orderType'>): boolean =>
  (f.stationId === 'ALL' || t.stationId === f.stationId) && (f.orderType === 'ALL' || t.orderType === f.orderType);

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function useFullscreen(): [boolean, () => void] {
  const [on, setOn] = useState(() => !!document.fullscreenElement);
  useEffect(() => {
    const sync = () => setOn(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);
  const toggle = useCallback(() => {
    // Both calls can be refused (iframe policy, no gesture); the button then simply stays as it was.
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void document.documentElement.requestFullscreen?.().catch(() => undefined);
  }, []);
  return [on, toggle];
}

export function BoardPage({ outlet, userName, canUpdate, onSignOut, onChangeOutlet }: Props) {
  const [settings, updateSettings] = useSettings();
  const [view, setView] = useState<BoardView>('active');
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** Ticket id -> time until which it is highlighted as new. */
  const [highlight, setHighlight] = useState<Record<string, number>>({});
  const [announcement, setAnnouncement] = useState('');
  const now = useNow();
  const soundRunning = useSoundRunning();
  const [fullscreen, toggleFullscreen] = useFullscreen();

  // Only alert for tickets this screen is showing: the grill screen stays quiet for desserts.
  const filters = useRef(settings);
  filters.current = settings;
  const onNewTickets = useCallback((fresh: Ticket[]) => {
    const mine = fresh.filter((t) => matches(t, filters.current));
    if (mine.length === 0) return;
    const until = Date.now() + NEW_TICKET_HIGHLIGHT_MS;
    setHighlight((current) => ({ ...current, ...Object.fromEntries(mine.map((t) => [t.id, until])) }));
    const describe = (t: Ticket) => `${t.ticketNumber}, ${ORDER_TYPE_LABEL[t.orderType]}${t.tableLabel ? `, table ${t.tableLabel}` : ''}`;
    setAnnouncement(mine.length === 1 ? `New ticket ${describe(mine[0]!)}` : `${mine.length} new tickets: ${mine.map(describe).join('; ')}`);
    beep();
  }, []);

  const board = useBoard(outlet.id, view, onNewTickets);
  const connected = useRealtime(outlet.id, board.refresh);
  const status: ConnectionStatus = !board.reachable ? 'offline' : connected ? 'live' : 'reconnecting';

  const { refresh } = board;
  useEffect(() => {
    const timer = setInterval(() => void refresh(), status === 'live' ? POLL_LIVE_MS : POLL_DEGRADED_MS);
    return () => clearInterval(timer);
  }, [refresh, status]);

  // Station chips come from the API; if that list could not be read, use the stations on the tickets.
  const stations = board.stations.length ? board.stations : [...new Map((board.active ?? []).map((t) => [t.station.id, t.station])).values()];
  // A stored filter for a station that no longer exists (or another outlet's) must not hide everything.
  const stationId = board.stations.length && !board.stations.some((s) => s.id === settings.stationId) ? 'ALL' : settings.stationId;
  const filter = { stationId, orderType: settings.orderType };

  const all = view === 'active' ? board.active : board.recent;
  const visible = all?.filter((t) => matches(t, filter)) ?? null;
  const hidden = all && visible ? all.length - visible.length : 0;
  const offline = status === 'offline';

  const sound = !soundSupported() ? 'unsupported' : !settings.soundWanted ? 'off' : soundRunning ? 'on' : 'blocked';
  const toggleSound = async () => {
    if (sound === 'on') {
      updateSettings({ soundWanted: false });
      await disableSound();
    } else if (await enableSound()) {
      updateSettings({ soundWanted: true });
      beep(1); // audible confirmation that it really works
    }
  };

  return (
    <div className="flex min-h-dvh flex-col">
      <Toolbar
        outletName={outlet.name}
        userName={canUpdate ? userName : `${userName} · view only`}
        view={view}
        activeCount={board.active ? board.active.filter((t) => matches(t, filter)).length : null}
        onView={setView}
        stations={stations}
        stationId={stationId}
        orderType={settings.orderType}
        onFilter={updateSettings}
        status={status}
        sound={sound}
        onToggleSound={() => void toggleSound()}
        fullscreen={fullscreen}
        onToggleFullscreen={toggleFullscreen}
        settingsOpen={settingsOpen}
        onToggleSettings={() => setSettingsOpen((open) => !open)}
        onSignOut={onSignOut}
        onChangeOutlet={onChangeOutlet}
      />
      {settingsOpen && <SettingsPanel settings={settings} onChange={updateSettings} onTestSound={sound === 'on' ? () => beep(1) : null} onClose={() => setSettingsOpen(false)} />}

      {/* Screen readers hear new tickets; sighted users get the flash and the NEW badge. */}
      <p aria-live="assertive" aria-atomic="true" data-testid="announcer" className="sr-only">
        {announcement}
      </p>

      {offline && (
        <div role="alert" className="flex items-center gap-4 bg-kds-bad px-4 py-4 text-kds-bg">
          <WifiOff aria-hidden className="size-10 shrink-0" />
          <div>
            <p className="text-2xl font-extrabold">OFFLINE - this board may be out of date</p>
            <p className="text-lg font-semibold">
              {board.lastUpdated
                ? `Last updated ${formatClock(board.lastUpdated)} (${formatAge(now - board.lastUpdated)} ago). `
                : 'Tickets have not been loaded yet. '}
              New orders will NOT appear until the connection returns. Buttons are disabled. Retrying automatically.
            </p>
          </div>
        </div>
      )}
      {!offline && board.loadError && all && (
        <div role="alert" className="flex items-center gap-3 bg-kds-warn px-4 py-3 text-lg font-bold text-kds-bg">
          <AlertTriangle aria-hidden className="size-7 shrink-0" />
          Could not refresh tickets: {board.loadError}
          {board.lastUpdated && ` Showing the board as of ${formatClock(board.lastUpdated)}.`}
        </div>
      )}
      {board.actionError && (
        <div role="alert" className="flex items-center gap-3 border-b-2 border-kds-bad bg-kds-bad/25 px-4 py-3 text-lg font-bold">
          <AlertTriangle aria-hidden className="size-7 shrink-0 text-kds-bad" />
          <span className="flex-1">{board.actionError}</span>
          <button type="button" onClick={board.dismissActionError} className="flex min-h-14 items-center gap-2 rounded-control border-2 border-kds-line bg-kds-card px-4">
            <X aria-hidden className="size-6" /> Dismiss
          </button>
        </div>
      )}

      <main className="flex-1 p-4" aria-busy={visible === null}>
        {visible === null ? (
          board.loadError ? (
            <div className="mx-auto mt-16 flex max-w-xl flex-col items-center gap-4 text-center">
              <AlertTriangle aria-hidden className="size-16 text-kds-bad" />
              <p className="text-3xl font-extrabold">Could not load tickets</p>
              <p className="text-xl text-kds-soft">{board.loadError}</p>
              <button type="button" onClick={() => void board.refresh()} className="min-h-16 rounded-control bg-brand px-8 text-2xl font-extrabold text-white hover:bg-brand-strong">
                Try again
              </button>
            </div>
          ) : (
            <p className="mt-16 flex items-center justify-center gap-3 text-2xl text-kds-soft">
              <LoaderCircle aria-hidden className="size-8 animate-spin" /> Loading tickets…
            </p>
          )
        ) : visible.length === 0 ? (
          <div className="mx-auto mt-16 flex max-w-xl flex-col items-center gap-3 text-center">
            <ChefHat aria-hidden className="size-20 text-kds-faint" />
            <p className="text-3xl font-extrabold">{view === 'active' ? 'No tickets - all caught up' : 'Nothing marked ready in the last 2 hours'}</p>
            {hidden > 0 && (
              <p className="text-xl text-kds-warn">
                {hidden} {hidden === 1 ? 'ticket is' : 'tickets are'} hidden by the current filters.
              </p>
            )}
          </div>
        ) : (
          // Oldest first (the API order): the ticket that has waited longest is top-left.
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(20rem,1fr))] items-start gap-4" aria-label={view === 'active' ? 'Active tickets' : 'Recently ready tickets'}>
            {visible.map((ticket) => (
              <li key={ticket.id}>
                <TicketCard
                  ticket={ticket}
                  now={now}
                  warnMinutes={settings.warnMinutes}
                  overdueMinutes={settings.overdueMinutes}
                  canUpdate={canUpdate}
                  busy={board.busy.has(ticket.id)}
                  disabled={offline || board.busy.has(ticket.id)}
                  disabledReason={offline ? 'Offline: changes cannot be saved right now' : 'Saving…'}
                  isNew={(highlight[ticket.id] ?? 0) > now}
                  onStatus={(next) => void board.setStatus(ticket, next)}
                  onItem={(item) => void board.setItemPrepared(ticket, item, !item.isPrepared)}
                />
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
