# EcoCollect: Create pickup request flow, communication contracts (Oct 28)

Conventions
- All REST traffic goes through the gateway at `/api/*`. Bodies are JSON.
- All timestamps are ISO 8601 in UTC with a `Z` suffix (e.g. `2026-10-28T16:15:00Z`), stored as `timestamptz` in Postgres. The frontend converts to Calgary time only for display.
- Exception: pickup windows are a Calgary calendar date plus a start hour (`{ "date": "2026-10-30", "startHour": 14 }` = 14:00–15:00 Calgary time), with no time zone, because they describe a local hour, not an instant. `startHour` is an integer 0–23.
- Roles live in Firebase custom claims: `{ roles: ["resident"] | ["volunteer"] | ["resident","volunteer"] }`.
- No street address ever appears in events, SSE messages, push payloads, or volunteer listings.
- Each service writes only its own tables. `profiles` is seeded and read-only for Oct 28.
- One Postgres instance with a schema per service: `pickup` (profiles, categories, requests, windows, status changes, outbox) and `notification` (notifications, processed events, push subscriptions). Each service connects with its own DB user that is granted access only to its own schema, so neither can read the other's tables. `profiles` is seeded and read-only for Oct 28.
- Caddy is the gateway and the only publicly exposed service. It serves the Next.js frontend and `/api/*` on one origin. A dedicated auth service is the only backend component that talks to Firebase.

## 1. Setup (manual, one time)

| # | From → To | Mechanism | Input | Output | Notes |
|---|---|---|---|---|---|
| 1.1 | Admin script → Firebase Auth | Admin SDK `setCustomUserClaims(uid, claims)` | `uid`, `{ roles: [...] }` | Claims stored on user | New claims reach the frontend on the next token refresh (automatic within ~1 h). To apply immediately, call `currentUser.getIdToken(true)`, then `POST /api/session` again so the session cookie carries the new claims too |
| 1.2 | Seed script → Postgres | SQL, run as an admin user | Creates both schemas and the two service users with their grants; seeds profiles (address, postal code, volunteer preferred postal codes) and item categories with standard weight into the `pickup` schema | Seeded rows | Replaces registration for Oct 28 |
| 1.3 | Setup → Notification service config | Env vars | VAPID key pair (generated once with the web-push library) | Ready to send push | VAPID keys identify our server to browser push services. Private key stays in the notification service env; public key goes to the frontend as `NEXT_PUBLIC_VAPID_KEY` for `pushManager.subscribe()` |

## 2. Frontend ↔ Firebase Auth (client SDK)

| # | Call | Input | Output | Notes |
|---|---|---|---|---|
| 2.1 | `signInWithEmailAndPassword` | email, password | Firebase user | Login screen |
| 2.2 | `getIdTokenResult()` | – | ID token + `claims.roles` | Decide which role(s) to offer after login |
| 2.3 | `getIdToken()` | – | ID token (JWT, ~1 h) | Called before each API request; SDK auto-refreshes |
| 2.4 | `signOut` | – | – | First call `DELETE /api/push/subscriptions` (needs the ID token) and `DELETE /api/session`, then `signOut` |

## 3. Frontend → Gateway (public API)

| # | Method + path | Auth | Request | Success response | Errors | Routed to | Notes |
|---|---|---|---|---|---|---|---|
| 3.1 | `POST /api/session` | Bearer ID token | `{ idToken }` | `204`, `Set-Cookie: session=…; HttpOnly; Secure; SameSite=Lax` | 401 | Auth service | Exists only for SSE: `EventSource` can't send an `Authorization` header, but browsers send cookies automatically. The auth service swaps the ID token for a Firebase session cookie (HttpOnly, so JavaScript can't read it; lasts days). Call once right after login. Caddy routes this without `forward_auth`, since there is no session yet |
| 3.2 | `DELETE /api/session` | Cookie | – | `204`, cookie cleared | – | Auth service | Call on logout. No `forward_auth` |
| 3.3 | `GET /api/categories` | Bearer | – | `200 [{ categoryId, name, standardWeightKg }]` | 401 | Pickup | Populates the create form; estimated weight = quantity × standardWeightKg (computed by backend) |
| 3.4 | `POST /api/requests` | Bearer, role resident | `{ items: [{ categoryId, quantity, description? }], windows: [{ date, startHour }], notes?, safetyAcknowledged: true }` | `201 { requests: [{ requestId, categoryId, quantity, estimatedWeightKg, status: "Open", createdAt, expiresAt }] }` | 400 validation, 401, 403 role | Pickup | One request created per item category, all in one transaction. Pickup address comes from the seeded profile, not the body. `windows`: 1–3 entries, distinct dates, each a one-hour slot (`startHour` 0–23, Calgary time) starting in the future and before `expiresAt`. Photos skipped for Oct 28 |
| 3.5 | `GET /api/requests?view=mine&status=` | Bearer, role resident | `view=mine` (required), `status` (optional) | `200 [{ requestId, category, quantity, estimatedWeightKg, status, createdAt, expiresAt }]` newest first | 400, 401, 403 | Pickup | Single endpoint with two views. `view=mine` returns only the caller's own requests |
| 3.6 | `GET /api/requests?view=available&postalCodes=` | Bearer, role volunteer | `view=available` (required), `postalCodes` (optional, comma-separated full 6-char codes, e.g. `T2P1J9,T3A0B1`, max 10) | `200 [{ requestId, category, quantity, estimatedWeightKg, postalCode, windows, expiresAt }]` | 400 invalid or too many codes, 401, 403 | Pickup | Never includes the street address. With `postalCodes`, returns available requests matching any of them; without it, returns all available requests. Codes are normalized (uppercase, spaces removed) before matching. `status` is rejected with this view |
| 3.7 | `GET /api/events` | Session cookie (`EventSource` with `withCredentials: true`) | – | `200 text/event-stream` (see section 8) | 401 | Notification | Long-lived stream; opened once after login and kept open. Auth is checked once, by `forward_auth`, when the connection opens |
| 3.8 | `GET /api/notifications` | Bearer | – | `200 [{ notificationId, type, requestId, title, body, createdAt }]` newest first | 401 | Notification | Loads notifications missed while offline. No read/unread for Oct 28 |
| 3.9 | `POST /api/push/subscriptions` | Bearer | `{ endpoint, keys: { p256dh, auth } }` | `201` | 400, 401 | Notification | Registers this device for push. `pushManager.subscribe()` returns a unique endpoint URL plus encryption keys for this browser; the backend stores them to know where to send push later |
| 3.10 | `DELETE /api/push/subscriptions` | Bearer | `{ endpoint }` | `204` | 401 | Notification | Unregisters this device on logout, so the next person using this browser doesn't receive your notifications |
| 3.11 | `GET /api/profile` | Bearer | – | `200 { uid, publicName, roles, address: { street, city, postalCode }, preferredPostalCodes: [...] }` | 401, 404 no profile | Pickup | Returns only the caller's own profile, so including their address is fine. `preferredPostalCodes` is empty for non-volunteers. The volunteer page uses it to build the default `postalCodes` filter for 3.6. Read-only for Oct 28 (profile editing comes later) |

## 4. Auth service ↔ Firebase Auth (Admin SDK, server side)

| # | Call | When | Input | Output | Notes |
|---|---|---|---|---|---|
| 4.1 | `verifyIdToken(token, true)` | `/verify` request carrying a bearer token | ID token | `{ uid, roles }` or failure → 401 | Signature check with cached Google public keys, plus a network call to Firebase that rejects disabled users and tokens revoked via `revokeRefreshTokens(uid)`. Claim changes alone don't revoke tokens |
| 4.2 | `createSessionCookie` | `POST /api/session` | ID token, expiry (e.g. 5 days) | Session cookie value | Requires a recent sign-in |
| 4.3 | `verifySessionCookie(cookie, true)` | `/verify` request carrying the session cookie (only `GET /api/events`) | Cookie value | `{ uid, roles }` or 401 | Same revocation check as 4.1 |

## 5. Caddy gateway rules and `forward_auth`

| # | Item | Rule |
|---|---|---|
| 5.1 | Strip client headers | Delete any incoming `X-User-Id`, `X-User-Roles`, `X-Request-Id` before anything else |
| 5.2 | `forward_auth` request | For every `/api/*` route except `/api/session`, Caddy sends `GET /verify` to the auth service with the original `Authorization` and `Cookie` headers (no body). The original request waits |
| 5.3 | `forward_auth` reply | Auth service checks the bearer token (4.1) if present, otherwise the session cookie (4.3). `200` + response headers `X-User-Id`, `X-User-Roles` → Caddy copies them onto the original request (`copy_headers`). Any other status (e.g. `401`) is returned to the browser as-is and the request goes no further |
| 5.4 | Added by Caddy | `X-Request-Id` from Caddy's generated request ID, for tracing in logs |
| 5.5 | Routing | `/api/session` → Auth service (no `forward_auth`) · `/api/categories`, `/api/requests`, `/api/profile` → Pickup · `/api/events`, `/api/notifications`, `/api/push/*` → Notification · everything else → Next.js frontend |
| 5.6 | SSE route (`/api/events`) | The request goes through `forward_auth` and is proxied as usual. On the way back, Caddy streams `text/event-stream` responses immediately; keep `/api/events` out of any `encode` (compression) rule. The ~25 s heartbeat keeps the connection active |
| 5.7 | HTTPS | Caddy provisions certificates automatically (a local certificate for `localhost` in development), which the `Secure` session cookie needs |
| 5.8 | Trust | Only Caddy is exposed publicly. Auth, pickup and notification services are reachable only on the internal network, and the services trust `X-User-*` without re-verifying |

## 6. Pickup service ↔ Postgres

| # | Operation | Input | Output | Notes |
|---|---|---|---|---|
| 6.1 | Read profile and categories | `uid`, `categoryId`s | Pickup address, postal code, standard weights | Read-only on `profiles` |
| 6.2 | Match volunteers | Request postal code, resident `uid` | `matchedVolunteerUids` | Volunteers whose saved postal codes include the request's postal code, excluding the resident. Snapshot at creation time; preference changes later don't affect existing requests |
| 6.3 | Create transaction | One `pickup_request` per category, its `pickup_window`s, one `status_change` (Open), one `outbox` row per request | Committed rows | All or nothing |
| 6.4 | Read requests | Filters from 3.5 / 3.6 | Rows | Available = status Open AND `expiresAt` > now AND at least one window whose start (`date` + `startHour`, converted from Calgary time) is in the future |
| 6.5 | Outbox publisher poll | `SELECT … WHERE published_at IS NULL … FOR UPDATE SKIP LOCKED` | Pending events | Loop inside the pickup service process |
| 6.6 | Outbox mark sent | `event_id` | `published_at = now()` | Only after RabbitMQ confirms |

About `expiresAt`: set to `createdAt + 30 days`. It only applies while a request is Open; Assigned, Collected, Delivered and Cancelled requests never expire. There is no expiry job for Oct 28; the field is stored now to keep the intent clear, and the "available" read already respects it.

## 7. Pickup service (outbox publisher) → RabbitMQ → Notification service

| # | Item | Value | Notes |
|---|---|---|---|
| 7.1 | Exchange | `ecocollect.events`, type `topic`, durable | Durable = the exchange definition survives a RabbitMQ restart |
| 7.2 | Routing key | `request.created` | |
| 7.3 | Queue | `notification.request-events`, durable, bound with `request.*` | Durable queue survives a restart |
| 7.4 | Message properties | `messageId = eventId`, `contentType = application/json`, persistent | Persistent = message written to disk. A durable queue holding non-persistent messages comes back empty after a restart, so both are needed |
| 7.5 | Publisher side | Publisher confirms on | Outbox row marked sent only after confirm |
| 7.6 | Consumer side | Manual ack after DB work commits | Unacked messages are redelivered |
| 7.7 | Granularity | One event per created request | A 3-category submission produces 3 events |

`RequestCreated` payload (v1):

```json
{
  "eventId": "6f1c…-uuid",
  "type": "RequestCreated",
  "version": 1,
  "occurredAt": "2026-10-28T16:15:00Z",
  "data": {
    "requestId": "r_123",
    "residentUid": "firebaseUid_abc",
    "categoryId": "laptops",
    "categoryName": "Computers/Laptops",
    "quantity": 2,
    "estimatedWeightKg": 5.0,
    "postalCode": "T2P1J9",
    "windows": [{ "date": "2026-10-30", "startHour": 14 }],
    "expiresAt": "2026-11-27T16:15:00Z",
    "matchedVolunteerUids": ["firebaseUid_v1", "firebaseUid_v2"]
  }
}
```

## 8. Notification service internals and outputs

| # | From → To | Mechanism | Input | Output | Notes |
|---|---|---|---|---|---|
| 8.1 | Consumer → Postgres | Insert into `processed_events` (event_id PK); skip if already present | `eventId` | Continue or skip | Makes redelivered events harmless |
| 8.2 | Consumer → Postgres | Insert notifications in the same transaction as 8.1 | One row for the resident (type `REQUEST_CREATED`, a confirmation) and one row per UID in `matchedVolunteerUids` (type `NEW_MATCHING_REQUEST`, an alert) | Notification rows | Recipients come straight from the event; no matching here. No matched volunteers → only the resident's row. Ack the message after commit |
| 8.3 | Consumer → Frontend (via SSE) | In-process handoff to the SSE hub, then SSE over the open `GET /api/events` connection | Saved notification rows | One `notification` message per row, written to every open connection of that recipient (covers multiple tabs). See SSE message below | The hub keeps a `userId → connections` list. Recipients with no open connection get nothing now and see the stored notification via `GET /api/notifications` later. Every ~25 s the server also sends a comment line (`: ping`), which `EventSource` ignores; it keeps proxies from closing the idle connection and lets the server spot dead connections (a failed write) and drop them |
| 8.4 | Consumer → Push sender → Browser push service | `web-push` `sendNotification(subscription, payload)` with VAPID keys | Stored subscriptions for each recipient | Delivered to device | Sent alongside SSE; the service worker decides whether to show it. `404`/`410` response → delete that subscription |

SSE message:

```
event: notification
id: n_789
data: {"notificationId":"n_789","type":"NEW_MATCHING_REQUEST","requestId":"r_123","title":"New pickup near you","body":"2 × Computers/Laptops in T2P1J9","createdAt":"2026-10-28T16:15:02Z"}
```

Push payload:

```json
{ "notificationId": "n_789", "title": "New pickup near you", "body": "2 × Computers/Laptops in T2P1J9", "url": "/volunteer/available", "tag": "r_123" }
```

## 9. Frontend internals reacting to messages

| # | Trigger | Action |
|---|---|---|
| 9.1 | Login succeeds | `POST /api/session`, open `EventSource('/api/events', { withCredentials: true })`, register service worker. Push is set up separately (see 9.8) |
| 9.2 | `POST /api/requests` succeeds | `invalidateQueries(["requests","mine"])` |
| 9.3 | SSE `notification` received | Always `invalidateQueries(["notifications"])`. Then by type: `NEW_MATCHING_REQUEST` → also `invalidateQueries(["requests","available"])`; `REQUEST_CREATED` → also `invalidateQueries(["requests","mine"])`. Invalidating refetches immediately if that data is on screen, otherwise on next use; the SSE message is only a signal, and fresh data always comes from the REST API |
| 9.4 | SSE drops | `EventSource` reconnects automatically; while disconnected, refetch `["notifications"]` every 30 s as a fallback |
| 9.5 | Service worker `push` event | If an EcoCollect tab is focused, skip; otherwise `showNotification(title, { body, tag, data: { url } })` |
| 9.6 | Service worker `notificationclick` | Focus or open `url` |
| 9.7 | Volunteer opens available requests | Load `GET /api/profile` (cached). If `preferredPostalCodes` is non-empty, call `GET /api/requests?view=available&postalCodes=<codes>`; otherwise call without `postalCodes` to show all. The volunteer can also clear the filter to see all |
| 9.8 | User clicks "Enable notifications" | Ask for notification permission, `pushManager.subscribe()` with `NEXT_PUBLIC_VAPID_KEY`, then `POST /api/push/subscriptions`. Must come from a click, or Chrome may block the prompt |

## 10. Deferred until after Oct 28

| Item | Plan |
|---|---|
| Mark as read | `PATCH /api/notifications/:id/read` plus an `isRead` field; notification service sends an SSE `notification-read` event to all of that user's connections so other tabs stay in sync |
| Request expiry | Scheduler marks Open requests Expired when `expiresAt` passes and publishes `RequestExpired` |
| Registration | Replaces manual custom claims and seeded profiles |
| Photos | Upload on request creation |
| Notification retention | Notifications are stored indefinitely for Oct 28. Later: scheduled cleanup of old notifications (e.g. read ones after 90 days) and old `processed_events` rows |