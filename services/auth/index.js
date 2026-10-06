// Auth service (MOCK). Logs a user in by setting an httpOnly session cookie
// and answers Caddy's forward_auth checks on /verify.
// A real version would use signed sessions or JWTs and real passwords.
import express from 'express';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const app = express();
app.use(express.json());

function readSession(req) {
  const cookies = Object.fromEntries(
    (req.headers.cookie || '').split(';').filter(Boolean).map((c) => {
      const [k, ...v] = c.trim().split('=');
      return [k, decodeURIComponent(v.join('='))];
    })
  );
  return cookies.session || null;
}

async function findUser(id) {
  const { rows } = await pool.query('SELECT id, name, is_volunteer FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

// Mock "login screen" data: list seeded users.
app.get('/auth/users', async (_req, res) => {
  const { rows } = await pool.query('SELECT id, name, is_volunteer FROM users ORDER BY id');
  res.json(rows);
});

app.post('/auth/login', async (req, res) => {
  const user = await findUser(req.body?.userId);
  if (!user) return res.status(401).json({ error: 'Unknown user' });
  res.cookie('session', user.id, { httpOnly: true, sameSite: 'lax', path: '/' });
  res.json(user);
});

app.post('/auth/logout', (_req, res) => {
  res.clearCookie('session', { path: '/' });
  res.status(204).end();
});

app.get('/auth/me', async (req, res) => {
  const user = await findUser(readSession(req));
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  res.json(user);
});

// Called by Caddy's forward_auth before any /api/* request.
// 2xx = allowed (Caddy copies X-User-Id onto the original request).
app.all('/verify', async (req, res) => {
  const user = await findUser(readSession(req));
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  res.set('X-User-Id', user.id).status(200).end();
});

app.listen(4000, () => console.log('[auth] listening on :4000'));
