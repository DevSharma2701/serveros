# ServeOS Manager (mobile)

Owner / manager app for ServeOS: operational visibility and day-to-day management on a phone.
It is **not** a cashier POS: billing and order taking stay on the web POS.

Expo SDK 57 · React Native 0.86 · React 19.2 · Expo Router · TypeScript · TanStack Query ·
React Hook Form + Zod · socket.io-client.

## Run it

From the repository root (the API must be running, `pnpm dev:api`):

```sh
pnpm dev:mobile            # = pnpm --filter @serveos/mobile start  (expo start)
```

Then open it in Expo Go (scan the QR code), or press `a` / `i` for an Android emulator / iOS simulator.

### Pointing the app at the API

The API address comes from `EXPO_PUBLIC_API_URL` (default `http://localhost:4000`).
Copy `.env.example` to `.env.local` and set it:

| Where the app runs            | Value                                                        |
| ----------------------------- | ------------------------------------------------------------ |
| iOS simulator                 | `http://localhost:4000`                                      |
| Android emulator              | `http://10.0.2.2:4000`                                       |
| **Physical phone**            | `http://<your computer's LAN IP>:4000` (same Wi-Fi network)  |

`localhost` on a phone is the phone itself, so a physical device **must** use the computer's LAN IP
(`ipconfig` on Windows, `ipconfig getifaddr en0` on macOS) and the firewall must allow port 4000.
Restart `expo start` after changing the variable. Release builds should use an `https://` URL:
Android and iOS block plain HTTP outside development.

`EXPO_PUBLIC_*` values are compiled into the app. Never put secrets in them.

## What is in the app

| Screen | Route | Data | Permission |
| --- | --- | --- | --- |
| Login | `/login` | `POST /auth/login` (`client: 'mobile'`) | – |
| Restaurant & outlet selector | `/select-outlet`, `/outlets` | `GET /auth/me` | – |
| Dashboard | `/` | `GET /reports/dashboard` | `report.view` |
| Live orders | `/orders` | `GET /orders?status=CONFIRMED,PREPARING,READY` + realtime | `order.view` |
| Order details | `/orders/[id]` | `GET /orders/:id` | `order.view` |
| Sales reports | `/reports` | `GET /reports/dashboard` | `report.view` |
| Product availability | `/availability` | `GET /menu/catalog`, `PUT /menu/products/:id/availability` | `menu.view` to see, `menu.availability` to change |
| Low-stock alerts | `/low-stock` | `GET /inventory/stock` (`isLow`) | `inventory.view` |
| Inventory overview | `/inventory` | `GET /inventory/stock` | `inventory.view` |
| Staff activity | `/staff` | `GET /audit-events`, `GET /attendance` | `audit.view` for the audit log |
| Shift summaries | `/shifts`, `/shifts/[id]` | `GET /shifts`, `GET /shifts/:id` | `shift.operate` (`shift.view_all` to see everyone's) |
| Notifications | `/notifications` | derived on the device, see below | `report.view` and/or `order.view` |
| Profile & settings | `/profile` | `GET/DELETE /auth/sessions`, `POST /auth/password/change`, `POST /auth/logout` | – |

Every list has pull-to-refresh and explicit loading, empty and error states. Errors show the
API's own message (and its correlation id) with a retry; a 403 becomes a "no access" state.
Features the signed-in role lacks are disabled or replaced by a "no access" notice, and the
request is not sent. The server still enforces every permission.

### Sign-in and tokens

- The **refresh token is stored only in Expo SecureStore** (Keychain / Keystore). The access token
  lives in memory and is never written to disk.
- On a 401 the client refreshes once (concurrent requests share that one refresh), saves the
  **rotated** refresh token, then retries. If the refresh token is rejected the user is returned to
  the login screen. If the server is merely unreachable the session is kept.
- Outlet-scoped requests send `X-Outlet-Id`; reports send `outletIds` in the query instead.
- "Today" and date ranges are calendar days in the selected outlet's time zone, not the phone's.

### Notifications are an in-app feed

The Notifications screen is computed on the phone each time it is opened or refreshed, from data
the API returns: low-stock ingredients, cash variance on shifts closed today, today's orders that were
cancelled after reaching the kitchen, and orders open longer than 30 minutes. Nothing is stored and nothing arrives while the
app is closed.

### Push notifications: scaffold only, not working

`src/lib/push.ts` exports `registerForPushNotifications()`. It returns `{ status: 'disabled' }`
and does nothing (no native module loaded, no permission prompt, no network call) unless **both**
`EXPO_PUBLIC_PUSH_ENABLED=true` and an EAS project id (`expo.extra.eas.projectId` in `app.json`)
are present. Nothing in the app calls it yet. To make push real you still need:

1. an EAS project with FCM / APNs credentials and a development or production build
   (remote push does not work in Expo Go),
2. the `expo-notifications` config plugin in `app.json`,
3. an API endpoint to store device push tokens and a server-side sender. Neither exists in the
   ServeOS API today.

### Deep links

Scheme `serveos://`. Routes map one-to-one, for example:

```sh
npx uri-scheme open "serveos://orders/<order-id>" --android
npx uri-scheme open "serveos://low-stock" --ios
```

The custom scheme needs a development build; in Expo Go use the `exp://<host>:8081/--/orders/<id>`
form. A link opened while signed out lands on the login screen, then on the dashboard. Orders are
outlet-scoped: a link to an order of another outlet shows "not found" with a hint to switch outlet.

### Realtime

`src/lib/realtime.tsx` connects socket.io to the API, subscribes to the selected outlet and treats
`order.changed`, `kitchen.ticket.changed`, `floor.changed` and `menu.changed` as hints: the affected
queries are refetched, and everything live is refetched after each reconnect. While the socket is
down the Live orders list polls every 30 seconds and says so.

## Scripts

```sh
pnpm --filter @serveos/mobile typecheck      # tsc --noEmit
pnpm --filter @serveos/mobile test           # jest-expo + @testing-library/react-native
pnpm --filter @serveos/mobile doctor         # npx expo-doctor
pnpm --filter @serveos/mobile bundle:check   # Metro bundle for Android into .bundle-check/ (delete afterwards)
```

Add Expo-managed packages with `npx expo install <name>` from `apps/mobile` so versions match the SDK.

## Monorepo notes

- pnpm's default isolated `node_modules` is used as is; SDK 57 configures Metro for monorepos
  automatically, so there is no `metro.config.js`.
- `@serveos/shared` (`workspace:*`) is consumed from its built `dist/`; run `pnpm build:shared`
  after changing it.
- The mobile app pins React 19.2.3 (what React Native 0.86 expects) while the web apps use a newer
  19.x. They are separate installs; do not hoist or align them by hand.

## Tests

`src/__tests__` renders the real route tree with `expo-router/testing-library`, with `fetch`,
SecureStore and socket.io replaced by fakes (`test/`). Covered: sign-in (token storage, server
error message, form validation), session resume, refresh + retry on an expired access token,
single-flight refresh, outlet selection, dashboard rendering and filters, network / 403 / 500
states, permission-gated availability toggle, an order deep link, date maths in the outlet time
zone and the notification feed.

## Not yet done

- App icon and splash image are still the Expo template placeholders.
- No ESLint configuration (`npx expo lint` would add one).
- Has not been run on a device or emulator from this repository's CI or setup machine.
