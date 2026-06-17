export interface PlannerConfig {
  plannerId: number;
  title: string;
  startDate: string; // YYYY-MM-DD
  endDate: string;   // YYYY-MM-DD
  isOwner: boolean;
  permission: 'owner' | 'edit' | 'view';
  isPublic: boolean;
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

export type RecurrenceType = 'daily' | 'weekly' | 'monthly' | 'yearly';

export type ActivityStatus = 'planned' | 'in_progress' | 'done' | 'cancelled';

/**
 * Rule for monthly recurrence:
 *   dom   – repeat on a fixed day-of-month (1..31); skips months that don't have that day.
 *   nthwd – repeat on the Nth weekday of the month (week 1..5, or -1 for last); weekday 0=Sun..6=Sat.
 */
export type MonthlyRule =
  | { kind: 'dom'; day: number }
  | { kind: 'nthwd'; week: 1 | 2 | 3 | 4 | 5 | -1; weekday: number };

export interface Recurrence {
  type: RecurrenceType;
  interval: number;           // >= 1
  weekdays?: number[];        // 0=Sun..6=Sat; required when type='weekly'
  monthlyRule?: MonthlyRule;  // required when type='monthly'; ignored for other types
  until?: string;             // YYYY-MM-DD; optional cap
  exceptions?: string[];      // YYYY-MM-DD dates to skip; works for all recurrence types
  overrides?: Record<string, Partial<Pick<Activity, 'title'|'description'|'startDate'|'endDate'|'color'|'label'|'status'>>>;
}

export interface TaggedUser {
  id?: number | null;
  username: string;
  fullName?: string;
  pending?: boolean;
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
  status?: ActivityStatus;    // default 'planned'
  isMilestone?: boolean;      // default false; if true, startDate === endDate
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
  selectedPeopleIds: Set<number>;     // people-view picker; empty = auto (tagged + members)
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
  isPublic: boolean;
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
