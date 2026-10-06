'use client';
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

// Opens the SSE stream and turns each event into a TanStack Query invalidation.
// Events carry no data the UI renders; they just say "something changed".
export function useEventStream() {
  const qc = useQueryClient();
  const [log, setLog] = useState([]);
  const [status, setStatus] = useState('connecting');

  useEffect(() => {
    const source = new EventSource('/api/events');

    source.onopen = () => {
      setStatus('open');
      // After a (re)connect we may have missed events: refetch everything once.
      qc.invalidateQueries({ queryKey: ['pickups'] });
    };
    source.onerror = () => setStatus('reconnecting');
    source.onmessage = (e) => {
      const event = JSON.parse(e.data);
      setLog((prev) => [event, ...prev].slice(0, 20));
      qc.invalidateQueries({ queryKey: ['pickups'] }); // prefix: mine, available, assigned
    };

    return () => source.close();
  }, [qc]);

  return { log, status };
}
