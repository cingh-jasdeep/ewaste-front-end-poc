// Pickup service: handles REST reads + actions and is the EVENT PRODUCER.
// Flow per action: validate -> write to Postgres -> publish event to RabbitMQ.
import express from 'express';
import pg from 'pg';
import amqp from 'amqplib';

const EXCHANGE = 'pickup.events'; // topic exchange; routing keys like "pickup.requested"
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
let channel;

async function connectBroker() {
  for (;;) {
    try {
      const conn = await amqp.connect(process.env.RABBITMQ_URL);
      channel = await conn.createChannel();
      await channel.assertExchange(EXCHANGE, 'topic', { durable: true });
      console.log('[pickup] connected to RabbitMQ');
      return;
    } catch (err) {
      console.log('[pickup] RabbitMQ not ready, retrying in 2s:', err.message);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// NOTE: DB write + publish is a "dual write". See README (transactional outbox).
function publish(routingKey, payload) {
  const event = { type: routingKey, at: new Date().toISOString(), ...payload };
  channel.publish(EXCHANGE, routingKey, Buffer.from(JSON.stringify(event)), {
    contentType: 'application/json',
    persistent: true,
  });
  console.log('[pickup] published', routingKey, payload);
}

const app = express();
app.use(express.json());

// Caddy's forward_auth guarantees this header comes from the auth service.
app.use((req, res, next) => {
  req.userId = req.get('X-User-Id');
  if (!req.userId) return res.status(401).json({ error: 'Not logged in' });
  next();
});

// ---------- Reads (REST, straight to the database; no broker) ----------
app.get('/api/pickups/mine', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM pickup_requests WHERE resident_id = $1 ORDER BY id DESC',
    [req.userId]
  );
  res.json(rows);
});

app.get('/api/pickups/available', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM pickup_requests
     WHERE status = 'open' AND resident_id <> $1
     ORDER BY id DESC`,
    [req.userId]
  );
  res.json(rows);
});

app.get('/api/pickups/assigned', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM pickup_requests WHERE volunteer_id = $1 ORDER BY id DESC',
    [req.userId]
  );
  res.json(rows);
});

// ---------- Actions (REST in, event out) ----------
app.post('/api/pickups', async (req, res) => {
  const description = req.body?.description || 'Mock e-waste: 1 old laptop, 2 phones';
  const { rows } = await pool.query(
    'INSERT INTO pickup_requests (resident_id, description) VALUES ($1, $2) RETURNING *',
    [req.userId, description]
  );
  const request = rows[0];
  publish('pickup.requested', { requestId: request.id, residentId: request.resident_id });
  res.status(201).json(request);
});

app.post('/api/pickups/:id/accept', async (req, res) => {
  const { rows: users } = await pool.query('SELECT is_volunteer FROM users WHERE id = $1', [req.userId]);
  if (!users[0]?.is_volunteer) return res.status(403).json({ error: 'Only volunteers can accept' });

  // Check-and-update in ONE statement so two volunteers can't both win.
  const { rows } = await pool.query(
    `UPDATE pickup_requests SET status = 'accepted', volunteer_id = $1
     WHERE id = $2 AND status = 'open' AND resident_id <> $1
     RETURNING *`,
    [req.userId, req.params.id]
  );
  if (rows.length === 0) return res.status(409).json({ error: 'Request is no longer open' });

  const request = rows[0];
  publish('pickup.accepted', {
    requestId: request.id,
    residentId: request.resident_id,
    volunteerId: request.volunteer_id,
  });
  res.json(request);
});

await connectBroker();
app.listen(4001, () => console.log('[pickup] listening on :4001'));
