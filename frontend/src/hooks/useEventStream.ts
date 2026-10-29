'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';

export interface SseMessageEvent {
  type: string;
  timestamp: string;
  data: any;
}

interface UseEventStreamOptions {
  enabled?: boolean;
  onEvent?: (event: SseMessageEvent) => void;
}

/**
 * React hook connecting to the backend Server-Sent Events (SSE) stream.
 * Automatically invalidates relevant React Query caches on processing status updates
 * and manages reconnection with exponential backoff.
 */
export function useEventStream(options: UseEventStreamOptions = {}) {
  const { enabled = true, onEvent } = options;
  const queryClient = useQueryClient();
  const [isConnected, setIsConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<SseMessageEvent | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const eventSourceRef = useRef<EventSource | null>(null);

  const handleMessage = useCallback(
    (type: string, rawData: string) => {
      try {
        const parsed = JSON.parse(rawData);
        const event: SseMessageEvent = {
          type,
          timestamp: new Date().toISOString(),
          data: parsed,
        };

        setLastEvent(event);
        if (onEvent) {
          onEvent(event);
        }

        // Automatic React Query cache synchronization
        if (type === 'RESUME_STATUS') {
          queryClient.invalidateQueries({ queryKey: ['resumes'] });
          if (parsed.resumeId) {
            queryClient.invalidateQueries({ queryKey: ['resume', parsed.resumeId] });
          }
        } else if (type === 'MATCH_STATUS') {
          queryClient.invalidateQueries({ queryKey: ['resumes'] });
          queryClient.invalidateQueries({ queryKey: ['matches'] });
          if (parsed.resumeId) {
            queryClient.invalidateQueries({ queryKey: ['resume-matches', parsed.resumeId] });
          }
        }
      } catch (err) {
        // Ignore unparseable SSE payloads
      }
    },
    [onEvent, queryClient]
  );

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;

    let isSubscribed = true;
    let reconnectTimeout: NodeJS.Timeout | null = null;

    function connect() {
      if (!isSubscribed) return;

      try {
        // Connect with credentials so the session cookie is passed
        const es = new EventSource('/v1/events/stream', { withCredentials: true });
        eventSourceRef.current = es;

        es.onopen = () => {
          if (!isSubscribed) return;
          setIsConnected(true);
          reconnectAttemptsRef.current = 0;
        };

        es.addEventListener('connected', () => {
          if (!isSubscribed) return;
          setIsConnected(true);
        });

        es.addEventListener('RESUME_STATUS', (e: MessageEvent) => {
          if (!isSubscribed) return;
          handleMessage('RESUME_STATUS', e.data);
        });

        es.addEventListener('MATCH_STATUS', (e: MessageEvent) => {
          if (!isSubscribed) return;
          handleMessage('MATCH_STATUS', e.data);
        });

        es.onerror = () => {
          if (!isSubscribed) return;
          setIsConnected(false);
          es.close();
          eventSourceRef.current = null;

          // Exponential backoff reconnection capped at 30 seconds
          const delay = Math.min(1000 * 2 ** reconnectAttemptsRef.current, 30000);
          reconnectAttemptsRef.current += 1;
          reconnectTimeout = setTimeout(connect, delay);
        };
      } catch (err) {
        setIsConnected(false);
      }
    }

    connect();

    return () => {
      isSubscribed = false;
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [enabled, handleMessage]);

  return { isConnected, lastEvent };
}

