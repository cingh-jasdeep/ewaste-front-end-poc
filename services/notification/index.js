// Notification service: the EVENT CONSUMER.
// Consumes pickup.* events from RabbitMQ, decides who should hear about each
// one, then delivers it via SSE (app open) and Web Push (app in background).
import express from 'express';
import pg from 'pg';
import amqp from 'amqplib';
import webpush from 'web-push';

const EXCHANGE = 'pickup.events';
const QUEUE = 'notification.pickup-events';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// ---------- Web Push setup ----------
let { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY } = process.env;
if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  ({ publicKey: VAPID_PUBLIC_KEY, privateKey: VAPID_PRIVATE_KEY } = webpush.generateVAPIDKeys());
  console.warn('[notification] No VAPID keys in env; generated temporary ones. ' +
    'Push subscriptions will stop working after a restart. See README.');
}
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:team@example.com',
  VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

// ---------- SSE connection registry: userId -> Set<response> ----------
const streams = new Map();

function sendSse(userId, event) {
  for (const res of streams.get(userId) || []) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
}

async function sendPush(userId, title, body) {
  const { rows } = await pool.query(
    'SELECT endpoint, subscription FROM push_subscriptions WHERE user_id = $1', [userId]);
  for (const { endpoint, subscription } of rows) {
    try {
      await webpush.sendNotification(subscription, JSON.stringify({ title, body }));
      console.log('[notification] push sent to', userId);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
      } else {
        console.error('[notification] push failed:', err.statusCode || err.message);
      }
    }
  }
}

// ---------- Event processing: decide recipients for each event ----------
async function volunteersExcept(...excluded) {
  const { rows } = await pool.query(
    'SELECT id FROM users WHERE is_volunteer AND NOT (id = ANY($1))', [excluded]);
  return rows.map((r) => r.id);
}

const handlers = {
  // MOCK matching: every volunteer except the requester. The real version
  // would match on each volunteer's saved criteria (area, item types, ...).
  async 'pickup.requested'(event) {
    for (const id of await volunteersExcept(event.residentId)) {
      sendSse(id, event);
      await sendPush(id, 'New e-waste pickup', `Request #${event.requestId} is available`);
    }
    sendSse(event.residentId, event); // keeps the resident's other tabs in sync
  },

  async 'pickup.accepted'(event) {
    sendSse(event.residentId, event);
    await sendPush(event.residentId, 'Pickup accepted',
      `A volunteer accepted request #${event.requestId}`);
    // Everyone else: refresh lists so the request disappears (no push needed).
    for (const id of await volunteersExcept(event.residentId)) sendSse(id, event);
  },
};

async function startConsumer() {
  for (;;) {
    try {
      const conn = await amqp.connect(process.env.RABBITMQ_URL);
      const ch = await conn.createChannel();
      await ch.assertExchange(EXCHANGE, 'topic', { durable: true });
      await ch.assertQueue(QUEUE, { durable: true });
      await ch.bindQueue(QUEUE, EXCHANGE, 'pickup.*');
      await ch.prefetch(10);
      await ch.consume(QUEUE, async (msg) => {
        if (!msg) return;
        try {
          const event = JSON.parse(msg.content.toString());
          console.log('[notification] consumed', msg.fields.routingKey, event);
          await handlers[msg.fields.routingKey]?.(event);
          ch.ack(msg);
        } catch (err) {
          console.error('[notification] failed to process event:', err);
          ch.nack(msg, false, false); // drop it rather than retry forever (PoC)
        }
      });
      console.log('[notification] consuming from', QUEUE);
      return;
    } catch (err) {
      console.log('[notification] RabbitMQ not ready, retrying in 2s:', err.message);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// ---------- HTTP endpoints (behind Caddy forward_auth) ----------
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  req.userId = req.get('X-User-Id');
  if (!req.userId) return res.status(401).json({ error: 'Not logged in' });
  next();
});

// SSE: no library needed, just a long-lived text/event-stream response.
app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  res.write(': connected\n\n'); // comment line: makes proxies flush immediately

  if (!streams.has(req.userId)) streams.set(req.userId, new Set());
  streams.get(req.userId).add(res);
  console.log('[notification] SSE open for', req.userId);

  req.on('close', () => {
    streams.get(req.userId)?.delete(res);
    console.log('[notification] SSE closed for', req.userId);
  });
});

// Heartbeat so idle connections aren't dropped by proxies.
setInterval(() => {
  for (const set of streams.values()) for (const res of set) res.write(': ping\n\n');
}, 25_000);

app.get('/api/push/public-key', (_req, res) => res.json({ publicKey: VAPID_PUBLIC_KEY }));

app.post('/api/push/subscribe', async (req, res) => {
  const sub = req.body;
  if (!sub?.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
  await pool.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, subscription) VALUES ($1, $2, $3)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, subscription = EXCLUDED.subscription`,
    [req.userId, sub.endpoint, sub]);
  res.status(201).json({ ok: true });
});

await startConsumer();
app.listen(5000, () => console.log('[notification] listening on :5000'));
