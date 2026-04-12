import { PlannerConfig, PlannerData } from './types';

// AJS is provided by Confluence at runtime; declare it for TypeScript
declare const AJS: {
  contextPath(): string;
  $: {
    ajax(options: {
      type: string;
      url: string;
      contentType?: string;
      data?: string;
      success(result: unknown): void;
      error(xhr: unknown, status: unknown, err: unknown): void;
    }): void;
  };
};

// Fallback for visual test harness (non-Confluence environment)
function getContextPath(): string {
  if (typeof AJS !== 'undefined' && AJS.contextPath) {
    return AJS.contextPath();
  }
  return '';
}

function ajax(method: string, url: string, data?: unknown): Promise<unknown> {
  // In Confluence, use AJS.$ (jQuery) which includes XSRF token handling
  if (typeof AJS !== 'undefined' && AJS.$) {
    return new Promise((resolve, reject) => {
      AJS.$.ajax({
        type: method,
        url,
        contentType: 'application/json',
        data: data ? JSON.stringify(data) : undefined,
        success: resolve,
        error: (_xhr: unknown, _status: unknown, err: unknown) => reject(err)
      });
    });
  }
  // Fallback for visual harness (use fetch)
  return fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: data ? JSON.stringify(data) : undefined,
  }).then(r => r.ok ? r.json().catch(() => null) : Promise.reject(r.status));
}

export class DataManager {
  private config: PlannerConfig;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: PlannerConfig) {
    this.config = config;
  }

  private url(): string {
    return `${getContextPath()}/rest/circular-planner/1/planner/${this.config.pageId}/${this.config.plannerId}`;
  }

  async load(): Promise<PlannerData | null> {
    try {
      const result = await ajax('GET', this.url()) as PlannerData;
      if (result && Array.isArray(result.lanes)) return result;
      return null;
    } catch {
      return null;
    }
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
      await ajax('PUT', this.url(), data);
    } catch (e) {
      console.error('CircularPlanner: failed to save', e);
    }
  }

  async deleteDraft(): Promise<void> {
    try {
      await ajax('DELETE', this.url());
    } catch { /* ignore */ }
  }
}
