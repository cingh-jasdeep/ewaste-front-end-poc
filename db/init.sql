-- Minimal schema for the proof of concept.
CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  is_volunteer BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE pickup_requests (
  id           SERIAL PRIMARY KEY,
  resident_id  TEXT NOT NULL REFERENCES users(id),
  description  TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open',   -- open | accepted
  volunteer_id TEXT REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE push_subscriptions (
  id           SERIAL PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  endpoint     TEXT NOT NULL UNIQUE,
  subscription JSONB NOT NULL
);

-- Mock users. A user can be a resident and a volunteer at the same time.
INSERT INTO users (id, name, is_volunteer) VALUES
  ('res-1', 'Riya (resident)', FALSE),
  ('vol-1', 'Vik (volunteer)', TRUE),
  ('vol-2', 'Mia (resident + volunteer)', TRUE);
