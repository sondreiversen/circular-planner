export interface PlannerConfig {
  plannerId: number;
  title: string;
  startDate: string; // YYYY-MM-DD
  endDate: string;   // YYYY-MM-DD
  isOwner: boolean;
  permission: 'owner' | 'edit' | 'view';
}

/**
 * Top-level field returned by GET /api/planners/:id alongside `config` and `data`.
 * Stored by the client and sent back as `client_updated_at` in the PUT body so the
 * server can detect concurrent edits (409 if the row was modified by another session).
 * The PUT response also returns `updated_at` so the client can refresh its copy.
 */
export interface PlannerTimestamp {
  updated_at: string; // ISO 8601 string, e.g. "2026-04-20T12:34:56.789Z"
}

export interface PlannerData {
  lanes: Lane[];
}

export interface Lane {
  id: string;
  name: string;
  order: number;   // 0 = innermost ring
  color: string;   // background tint for the ring
  activities: Activity[];
}

export type RecurrenceType = 'daily' | 'weekly';

export interface Recurrence {
  type: RecurrenceType;
  interval: number;     // >= 1; for 'daily' = every N days, for 'weekly' = every N weeks
  weekdays?: number[];  // 0=Sun..6=Sat; required & non-empty when type='weekly'
  until?: string;       // YYYY-MM-DD; optional cap
}

export interface TaggedUser {
  id: number;
  username: string;
  fullName?: string;
}

export interface Activity {
  id: string;
  laneId: string;
  title: string;
  description: string;
  startDate: string; // YYYY-MM-DD
  endDate: string;   // YYYY-MM-DD
  color: string;     // arc fill color
  label: string;     // free-text label, e.g. "vacation" — empty = none
  createdBy?: string | null;
  taggedUsers?: TaggedUser[];
  recurrence?: Recurrence | null;
}

export enum ZoomLevel {
  Year = 'year',
  Quarter = 'quarter',
  Month = 'month',
  Week = 'week',
}

export interface Viewport {
  windowStart: Date;  // maps to angle -PI/2 (12 o'clock)
  windowEnd: Date;    // maps to angle 3*PI/2
  zoomLevel: ZoomLevel;
}

export interface GridSpec {
  majorTicks: Date[];   // prominent gridlines (darker)
  minorTicks: Date[];   // lighter sub-divisions
  labels: Array<{ date: Date; text: string; anchor?: boolean }>;
  subLabels?: Array<{ date: Date; text: string }>; // inner day-number labels (Year zoom only)
}

export interface FilterState {
  hiddenLaneIds: Set<string>;
  searchTerm: string;
  activeLabels: Set<string>;          // inclusive OR filter; empty = show all
  activeTaggedUserIds: Set<number>;   // inclusive OR filter; empty = show all
}

export interface User {
  id: number;
  username: string;
  email: string;
  fullName?: string | null;
}

export interface PlannerSummary {
  id: number;
  title: string;
  startDate: string;
  endDate: string;
  isOwner: boolean;
  permission: 'owner' | 'view' | 'edit';
  ownerName: string;
}

export interface ShareEntry {
  user_id: number;
  username: string;
  email: string;
  fullName?: string | null;
  permission: 'view' | 'edit';
}

export interface DiscGeometry {
  cx: number;
  cy: number;
  coreRadius: number;    // inner hole radius (for title)
  outerRadius: number;   // total outer radius of outermost lane
  laneWidth: number;     // width of each lane
  slotByLaneId: Map<string, number>; // visible-lane id → slot index (0 = innermost visible)
  innerRadiusFn: (slot: number) => number;
  outerRadiusFn: (slot: number) => number;
}
