# E-waste Pickup: event flow proof of concept

A deliberately minimal codebase that validates the architecture in the
"E-waste event flow" diagram. Payloads are mocked; the point is that every hop
connects and data flows the way the diagram says.

> **Academic integrity:** this PoC was generated with Claude (Anthropic) to
> validate the architecture. Per the ENSF 607 policy, any of it that ends up in
> the project must be disclosed, reviewed, understood and adapted by the team.

## What maps to what

| Diagram box            | Code                          | Libraries                              |
|------------------------|-------------------------------|----------------------------------------|
| TanStack Query         | `web/components/Dashboard.js` | `@tanstack/react-query` (`useQuery`, `useMutation`) |
| EventSource            | `web/lib/useEventStream.js`   | none (browser built-in)                |
| Service worker         | `web/public/sw.js`, `web/lib/push.js` | none (Push API, built-in)      |
| Caddy (proxy + gateway)| `Caddyfile`                   | Caddy `forward_auth`                   |
| Auth service           | `services/auth`               | `express`, `pg`                        |
| Pickup service (producer) | `services/pickup`          | `express`, `pg`, `amqplib`             |
| RabbitMQ               | topic exchange `pickup.events`| `rabbitmq:4-management` image          |
| Notification service (consumer) | `services/notification` | `express`, `pg`, `amqplib`, `web-push` |
| Postgres               | `db/init.sql`                 | `postgres:16-alpine` image             |

## The two flows

**Create request (resident):** `useMutation` → `POST /api/pickups` → Caddy
checks the cookie with the auth service → pickup service inserts the row →
publishes `pickup.requested` → notification service consumes it → SSE to every
volunteer (+ the resident's own tabs) and Web Push to volunteers → each
browser's `EventSource` invalidates `['pickups']` → TanStack Query refetches.

**Accept request (volunteer):** `POST /api/pickups/:id/accept` → a single
conditional `UPDATE ... WHERE status = 'open'` (second volunteer gets **409**) →
publishes `pickup.accepted` → resident gets SSE + push; other volunteers get
SSE so the request disappears from their list.

Reads (`GET /api/pickups/mine|available|assigned`) are plain REST straight to
Postgres. Only events go through the broker. No service calls another service.

## Run it

Requires Docker with Compose.

```bash
cp .env.example .env
npx web-push generate-vapid-keys      # paste both keys into .env
docker compose up --build
```

Open **http://localhost:8080**. (Skipping the VAPID step still works, but the
keys change on every restart, which breaks existing push subscriptions.)

### Demo script

1. Browser A: log in as **Riya (resident)**. Browser B (a *different* browser,
   not just another tab): log in as **Vik (volunteer)**. Click **Enable push**
   in both.
2. A: **Create mock pickup request**. B's "available" list updates instantly,
   and the event shows in B's "Events received over SSE" box.
3. Minimise or close B's tab and create another request in A: B gets a system
   notification. Tapping it reopens the app.
4. B: **Accept**. A updates instantly and gets a push if backgrounded.
5. Watch the broker at **http://localhost:15672** (ewaste / ewaste): exchange
   `pickup.events`, queue `notification.pickup-events`.
6. `docker compose logs -f pickup notification` shows each publish/consume.

### Frontend dev mode (hot reload)

Run everything except `web` in Docker and Next.js on your machine; Caddy still
gives you one origin so cookies and SSE behave the same:

```bash
WEB_UPSTREAM=host.docker.internal:3000 docker compose up --build postgres rabbitmq auth pickup notification caddy
cd web && npm install && npm run dev
```

Still browse via **http://localhost:8080**, not :3000.

## What was verified

Run end to end (Postgres, RabbitMQ, Caddy and all services) before handoff:

- Unauthenticated API/SSE calls → 401; a forged `X-User-Id` header is ignored.
- Create → `pickup.requested` delivered over SSE to resident and volunteers.
- Two volunteers accepting at the same moment → one 200, one 409.
- Non-volunteer accepting → 403.
- `pickup.accepted` delivered over SSE to all three users.
- Web Push: an encrypted (`aes128gcm`), VAPID-signed message reached a push
  endpoint (a local stand-in for Google/Mozilla/Apple).
- `next build` succeeds; the manifest is served at `/manifest.webmanifest`.

Not verified here: a real browser receiving the notification (needs a real
browser and internet access to the push services). Try the demo script above.

## Deliberately mocked or simplified

- **Login:** pick a seeded user; the cookie holds the raw user id. Use signed
  sessions/JWTs and real passwords in the project.
- **Matching:** every volunteer gets every request. Real version: match on
  each volunteer's saved criteria.
- **Shared database:** all services use one Postgres. Fine for a course
  project; mention it as a known trade-off.
- **Dual write:** the pickup service writes to Postgres then publishes. A crash
  in between loses the event. Fix later with a transactional outbox (a good
  "refactoring" item for check-in II).
- **Single notification instance:** the SSE connection map lives in memory.
- **Production:** replace `:80` + `auto_https off` in the Caddyfile with your
  domain name to get automatic HTTPS and HTTP/2 on the Oracle VM.
  - **Set a TTL (time to live) on each push**. Delayed delivery isn't just a quirk: by default, a "new pickup available" alert could reach a volunteer hours later, after someone else accepted it. web-push lets you set a TTL so the push service drops a message once it's stale. Keep this short for time-sensitive events like new requests, and longer for things like "your pickup was accepted.
  - **Push Status** - check on page load:
whether notification permission is already granted, and
whether the service worker already has a subscription, using pushManager.getSubscription().
