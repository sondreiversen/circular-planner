import { PlannerConfig, PlannerData } from './types';
import { api } from './api-client';

export type SaveEvent = 'saving' | 'saved' | 'error' | 'conflict';
type SaveHandler = () => void;

export class DataManager {
  private config: PlannerConfig;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private lastKnownUpdatedAt: string | null = null;
  private listeners: Map<SaveEvent, SaveHandler[]> = new Map();

  constructor(config: PlannerConfig) {
    this.config = config;
  }

  /** Store the server's latest updated_at after load or successful save */
  setUpdatedAt(updatedAt: string): void {
    this.lastKnownUpdatedAt = updatedAt;
  }

  /** Subscribe to save-state events */
  on(event: SaveEvent, handler: SaveHandler): void {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event)!.push(handler);
  }

  private emit(event: SaveEvent): void {
    this.listeners.get(event)?.forEach(h => h());
  }

  /** Debounced save — waits 800ms after last call before sending */
  scheduleSave(data: PlannerData): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(data), 800);
  }

  async save(data: PlannerData): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.emit('saving');
    try {
      const body: Record<string, unknown> = { lanes: data.lanes };
      if (this.lastKnownUpdatedAt) {
        body.client_updated_at = this.lastKnownUpdatedAt;
      }
      const result = await api.put<{ success: boolean; updated_at?: string }>(
        `/api/planners/${this.config.plannerId}`,
        body,
      );
      if (result.updated_at) {
        this.lastKnownUpdatedAt = result.updated_at;
      }
      this.emit('saved');
    } catch (e: unknown) {
      // api-client throws with the server error message; check for conflict
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.toLowerCase().includes('conflict')) {
        this.emit('conflict');
      } else {
        this.emit('error');
      }
      console.error('CircularPlanner: failed to save', e);
    }
  }
}
