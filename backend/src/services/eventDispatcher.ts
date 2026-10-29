import { createRedisClient, redisClient } from '../queues/redis.js';
import type { Redis } from 'ioredis';

export type EventType = 'RESUME_STATUS' | 'MATCH_STATUS' | 'JOB_STATUS' | 'PING';

export interface SseEvent<T = any> {
  type: EventType;
  timestamp: string;
  data: T;
}

export interface ResumeStatusEventData {
  resumeId: string;
  status: string;
  atsScore?: number | null;
  method?: string | null;
  error?: string | null;
}

export interface MatchStatusEventData {
  jobId: string;
  resumeId: string;
  status?: string;
  score?: number | null;
  verdict?: string | null;
}

type EventListener = (event: SseEvent) => void;

class EventDispatcher {
  private subscriber: Redis | null = null;
  private userListeners: Map<string, Set<EventListener>> = new Map();
  private isConnecting = false;

  private getChannelName(userId: string): string {
    return `resumatch:events:user:${userId}`;
  }

  private async ensureSubscriber(): Promise<Redis> {
    if (this.subscriber) {
      return this.subscriber;
    }

    if (this.isConnecting) {
      // Wait for existing connection attempt
      while (this.isConnecting) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (this.subscriber) return this.subscriber;
    }

    this.isConnecting = true;
    try {
      const sub = createRedisClient();
      await sub.connect().catch(() => {});

      sub.on('message', (channel: string, message: string) => {
        try {
          const prefix = 'resumatch:events:user:';
          if (!channel.startsWith(prefix)) return;
          const userId = channel.slice(prefix.length);
          const listeners = this.userListeners.get(userId);
          if (!listeners || listeners.size === 0) return;

          const parsedEvent: SseEvent = JSON.parse(message);
          for (const listener of listeners) {
            try {
              listener(parsedEvent);
            } catch (err) {
              // Swallow listener error to avoid disrupting other subscribers
            }
          }
        } catch (err) {
          // Ignore invalid JSON payloads
        }
      });

      this.subscriber = sub;
      return sub;
    } finally {
      this.isConnecting = false;
    }
  }

  /**
   * Subscribes an SSE connection listener to all events for a specific user.
   * Returns an unsubscribe cleanup callback.
   */
  async subscribeUser(userId: string, listener: EventListener): Promise<() => void> {
    const channel = this.getChannelName(userId);
    let listeners = this.userListeners.get(userId);

    const isFirst = !listeners || listeners.size === 0;
    if (!listeners) {
      listeners = new Set();
      this.userListeners.set(userId, listeners);
    }
    listeners.add(listener);

    if (isFirst) {
      const sub = await this.ensureSubscriber();
      await sub.subscribe(channel);
    }

    return async () => {
      const activeListeners = this.userListeners.get(userId);
      if (activeListeners) {
        activeListeners.delete(listener);
        if (activeListeners.size === 0) {
          this.userListeners.delete(userId);
          if (this.subscriber) {
            await this.subscriber.unsubscribe(channel).catch(() => {});
          }
        }
      }
    };
  }

  /**
   * Publishes an event to a user's private event channel.
   */
  async publishUserEvent(userId: string, event: Omit<SseEvent, 'timestamp'> & { timestamp?: string }): Promise<void> {
    const channel = this.getChannelName(userId);
    const fullEvent: SseEvent = {
      ...event,
      timestamp: event.timestamp || new Date().toISOString(),
    };

    try {
      await redisClient.publish(channel, JSON.stringify(fullEvent));
    } catch (err) {
      // Non-fatal if Redis publish drops; events are best-effort reactive updates
    }
  }

  /**
   * Disconnects subscriber client on application shutdown.
   */
  async close(): Promise<void> {
    if (this.subscriber) {
      await this.subscriber.quit().catch(() => {});
      this.subscriber = null;
    }
    this.userListeners.clear();
  }
}

export const eventDispatcher = new EventDispatcher();

