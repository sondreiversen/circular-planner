import { PlannerConfig, PlannerData } from './types';
import { api } from './api-client';

export class DataManager {
  private config: PlannerConfig;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: PlannerConfig) {
    this.config = config;
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
    try {
      await api.put(`/api/planners/${this.config.plannerId}`, { lanes: data.lanes });
    } catch (e) {
      console.error('CircularPlanner: failed to save', e);
    }
  }
}
