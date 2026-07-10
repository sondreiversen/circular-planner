import { PlannerConfig, PlannerData, Lane, Activity } from './types';
import { api } from './api-client';

export type SaveEvent = 'saving' | 'saved' | 'error' | 'conflict';
type SaveHandler = () => void;

export class DataManager {
  private config: PlannerConfig;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private lastKnownUpdatedAt: string | null = null;
  private listeners: Map<SaveEvent, SaveHandler[]> = new Map();
  /** True while a PUT is in flight */
  private saving = false;
  /** Latest data queued while a save is already in flight; run once the current save completes */
  private pendingData: PlannerData | null = null;
  /** True whenever there is unsaved (or unconfirmed-saved) local data */
  private dirty = false;

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
    this.dirty = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save(data);
    }, 800);
  }

  /**
   * True if there is local state that is not confirmed saved on the server:
   * a debounce timer is pending, a PUT is currently in flight, or the last
   * attempted save has not yet succeeded.
   */
  isDirty(): boolean {
    return this.dirty || this.saving || this.saveTimer !== null;
  }

  /** Serialise PlannerData for the wire: strip client-only fields, convert taggedUsers → taggedUserIds + taggedUsernames */
  private serialiseLanes(data: PlannerData): unknown {
    return data.lanes.map((lane: Lane) => ({
      ...lane,
      activities: lane.activities.map((a: Activity) => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { taggedUsers, createdBy, ...rest } = a;
        const resolved = (taggedUsers ?? []).filter(u => u.id != null);
        const pending  = (taggedUsers ?? []).filter(u => u.id == null);
        return {
          ...rest,
          taggedUserIds: resolved.map(u => u.id as number),
          taggedUsernames: pending.map(u => u.username),
        };
      }),
    }));
  }

  /**
   * Save the given data. If a save is already in flight, the data is stashed
   * as `pendingData` and a single follow-up save runs automatically once the
   * in-flight PUT completes (looping until no data is left pending) — this
   * prevents two overlapping PUTs from racing on `lastKnownUpdatedAt` and
   * triggering spurious 409s.
   */
  async save(data: PlannerData): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.dirty = true;
    if (this.saving) {
      this.pendingData = data;
      return;
    }
    await this.performSave(data);
  }

  private async performSave(data: PlannerData): Promise<void> {
    this.saving = true;
    this.emit('saving');
    try {
      const body: Record<string, unknown> = { lanes: this.serialiseLanes(data) };
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
      // Only clear dirty if nothing newer arrived while this PUT was in flight
      if (!this.pendingData) {
        this.dirty = false;
      }
    } catch (e: unknown) {
      // api-client throws with the server error message; check for conflict
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.toLowerCase().includes('conflict')) {
        this.emit('conflict');
      } else {
        this.emit('error');
      }
      console.error('CircularPlanner: failed to save', e);
    } finally {
      this.saving = false;
      if (this.pendingData) {
        const next = this.pendingData;
        this.pendingData = null;
        await this.performSave(next);
      }
    }
  }
}
