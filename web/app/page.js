'use client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import Dashboard from '@/components/Dashboard';

export default function Home() {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: () => api('/auth/me'), retry: false });
  const users = useQuery({ queryKey: ['users'], queryFn: () => api('/auth/users'), enabled: me.isError });
  const login = useMutation({
    mutationFn: (userId) => api('/auth/login', { method: 'POST', body: { userId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });

  if (me.isPending) return <main><p>Loading…</p></main>;
  if (me.data) return <Dashboard user={me.data} />;

  return (
    <main>
      <h1>E-waste Pickup PoC</h1>
      <p className="muted">Mock login: pick a seeded user. Open a second browser to log in as someone else.</p>
      <div className="row">
        {users.data?.map((u) => (
          <button key={u.id} onClick={() => login.mutate(u.id)}>{u.name}</button>
        ))}
      </div>
    </main>
  );
}
