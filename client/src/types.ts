export interface PlannerConfig {
  plannerId: number;
  title: string;
  startDate: string; // YYYY-MM-DD
  endDate: string;   // YYYY-MM-DD
  isOwner: boolean;
  permission: 'owner' | 'edit' | 'view';
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

export interface Activity {
  id: string;
  laneId: string;
  title: string;
  description: string;
  startDate: string; // YYYY-MM-DD
  endDate: string;   // YYYY-MM-DD
  color: string;     // arc fill color
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
  labels: Array<{ date: Date; text: string }>;
}

export interface FilterState {
  hiddenLaneIds: Set<string>;
  searchTerm: string;
}

export interface User {
  id: number;
  username: string;
  email: string;
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
  permission: 'view' | 'edit';
}

export interface DiscGeometry {
  cx: number;
  cy: number;
  coreRadius: number;    // inner hole radius (for title)
  outerRadius: number;   // total outer radius of outermost lane
  laneWidth: number;     // width of each lane
  innerRadiusFn: (order: number) => number;
  outerRadiusFn: (order: number) => number;
}
