'use client';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useEventStream } from '@/lib/useEventStream';
import { enablePush } from '@/lib/push';

function RequestList({ items, empty, action }) {
  if (!items?.length) return <p className="muted">{empty}</p>;
  return (
    <ul>
      {items.map((r) => (
        <li key={r.id}>
          #{r.id} · {r.description} · <b>{r.status}</b>
          {r.volunteer_id ? ` (volunteer: ${r.volunteer_id})` : ''} {action?.(r)}
        </li>
      ))}
    </ul>
  );
}

export default function Dashboard({ user }) {
  const qc = useQueryClient();
  const { log, status } = useEventStream();
  const [pushMsg, setPushMsg] = useState('');

  // Reads: plain REST via useQuery
  const mine = useQuery({ queryKey: ['pickups', 'mine'], queryFn: () => api('/api/pickups/mine') });
  const available = useQuery({
    queryKey: ['pickups', 'available'],
    queryFn: () => api('/api/pickups/available'),
    enabled: user.is_volunteer,
  });
  const assigned = useQuery({
    queryKey: ['pickups', 'assigned'],
    queryFn: () => api('/api/pickups/assigned'),
    enabled: user.is_volunteer,
  });

  // Actions: plain REST via useMutation; the backend publishes the event
  const create = useMutation({
    mutationFn: () => api('/api/pickups', { method: 'POST', body: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pickups'] }),
  });
  const accept = useMutation({
    mutationFn: (id) => api(`/api/pickups/${id}/accept`, { method: 'POST' }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['pickups'] }),
  });
  const logout = useMutation({
    mutationFn: () => api('/auth/logout', { method: 'POST' }),
    onSuccess: () => qc.resetQueries(),
  });

  return (
    <main>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>Hi, {user.name}</h1>
        <button onClick={() => logout.mutate()}>Log out</button>
      </div>
      <p className="muted">SSE: {status}</p>

      <section>
        <h2>Background notifications</h2>
        <div className="row">
          <button onClick={() => enablePush().then(() => setPushMsg('Push enabled'), (e) => setPushMsg(e.message))}>
            Enable push
          </button>
          <span className="muted">{pushMsg}</span>
        </div>
      </section>

      <section>
        <h2>Resident: my requests</h2>
        <button className="primary" onClick={() => create.mutate()} disabled={create.isPending}>
          Create mock pickup request
        </button>
        <RequestList items={mine.data} empty="No requests yet." />
      </section>

      {user.is_volunteer && (
        <section>
          <h2>Volunteer: available pickups</h2>
          {accept.isError && <p className="error">{accept.error.message}</p>}
          <RequestList
            items={available.data}
            empty="Nothing available right now."
            action={(r) => <button onClick={() => accept.mutate(r.id)}>Accept</button>}
          />
          <h2>Volunteer: accepted by me</h2>
          <RequestList items={assigned.data} empty="None yet." />
        </section>
      )}

      <section>
        <h2>Events received over SSE</h2>
        <pre>{log.length ? log.map((e) => JSON.stringify(e)).join('\n') : 'Waiting for events…'}</pre>
      </section>
    </main>
  );
}
