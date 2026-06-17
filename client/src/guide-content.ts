/**
 * Content for the in-app guide: the interactive tour steps and the
 * reference-panel sections. Pure data — no DOM. Consumed by guide.ts.
 *
 * Tour selectors point at real elements. Steps whose selector resolves to
 * null are skipped at runtime (e.g. edit-only controls in a view-only
 * planner), so this list can describe the full feature set safely.
 */

export interface TourStep {
  /** CSS selector for the element to spotlight. */
  selector: string;
  title: string;
  body: string;
  /** Preferred tooltip placement relative to the target. Defaults to 'bottom'. */
  placement?: 'top' | 'bottom' | 'left' | 'right';
}

export const TOUR_STEPS: TourStep[] = [
  {
    selector: '.cp-svg-container',
    title: 'The disc',
    body: 'This is your planner. Each ring is a lane, and each arc is an activity placed on a 12-month timeline that reads clockwise from the top.',
    placement: 'right',
  },
  {
    selector: '[data-tour="views"]',
    title: 'Three ways to look',
    body: 'Switch between the circular Disc, a chronological List, and a People view that groups activities by who they’re tagged to. (Keys 1 / 2 / 3.)',
    placement: 'bottom',
  },
  {
    selector: '[data-tour="nav"]',
    title: 'Navigate & zoom',
    body: 'Step backward and forward with ◀ ▶, zoom between Year → Quarter → Month → Week with − / +, and jump to Today. You can also scroll on the disc to zoom, or use the arrow keys.',
    placement: 'bottom',
  },
  {
    selector: '.cp-year-select',
    title: 'Jump to a year',
    body: 'Pick a year to move the view straight there.',
    placement: 'bottom',
  },
  {
    selector: '[data-tour="colorby"]',
    title: 'Colour by',
    body: 'Recolour every activity by Lane, Label, Status, or Owner to spot patterns at a glance.',
    placement: 'bottom',
  },
  {
    selector: '#cp-sidebar',
    title: 'Lanes, search & filters',
    body: 'The sidebar holds your lanes (add, rename, recolour, reorder, or hide them), full-text search, and filters by label, tagged person, or a custom date range.',
    placement: 'right',
  },
  {
    selector: '[data-tour="add-event"]',
    title: 'Add activities',
    body: 'Create an activity here or by pressing “n” — or just click an empty spot on a lane. Activities can be milestones, have a status, labels, tagged people, descriptions, and repeat rules. Drag an arc to move it, or drag its edges to reschedule.',
    placement: 'bottom',
  },
  {
    selector: '#share-btn',
    title: 'Share & collaborate',
    body: 'Invite people or groups with view or edit access, or publish a read-only public link to embed the disc anywhere.',
    placement: 'bottom',
  },
  {
    selector: '[data-tour="export"]',
    title: 'Print & export',
    body: 'Print the disc (or save it as a PDF) and download it as a PNG image.',
    placement: 'bottom',
  },
  {
    selector: '#guide-btn',
    title: 'That’s the tour!',
    body: 'Open this Guide button anytime to revisit the tour or browse the full feature reference. Press “?” for the keyboard-shortcut list.',
    placement: 'bottom',
  },
];

export interface ReferenceSection {
  title: string;
  items: string[];
}

export const REFERENCE_SECTIONS: ReferenceSection[] = [
  {
    title: 'Getting started',
    items: [
      'A planner is a disc covering a date range. Lanes are the concentric rings; activities are the arcs placed on them.',
      'Add a lane from the sidebar, then add activities to it — the disc reads clockwise from 12 o’clock.',
      'Changes save automatically; the badge in the toolbar shows “Saving…” then “Saved”.',
    ],
  },
  {
    title: 'The disc & views',
    items: [
      'Disc view: the circular timeline. List view: activities in chronological order. People view: grouped by tagged person (keys 1 / 2 / 3).',
      '“Colour by” recolours activities by Activity, Lane, Label, Status, or Owner.',
      'Statuses (planned, in progress, done, cancelled) and milestones get distinct markers on the disc.',
    ],
  },
  {
    title: 'Activities',
    items: [
      'Create: click an empty spot on a lane, press “n”, or use “+ Add event”.',
      'Edit: click an activity’s arc (or its row in List view) to open the dialog.',
      'Move: drag an arc to a new date or onto another lane. Resize: drag an arc’s start or end edge.',
      'Each activity can have a description (Markdown), a label, tagged people, a status, and a colour.',
      'Milestones are single-date activities shown as a diamond marker.',
      'Repeat rules: daily, weekly (pick weekdays), monthly (day-of-month or “Nth weekday”), or yearly — with an interval, an end date, and skipped occurrences.',
      'Copy / paste an activity with Ctrl/Cmd + C then Ctrl/Cmd + V (it date-shifts to today).',
    ],
  },
  {
    title: 'Lanes',
    items: [
      'Add a lane from the sidebar; give it a name and colour.',
      'Edit a lane with the pencil button on its sidebar row.',
      'Reorder lanes by dragging their rows — the top row is the outermost ring.',
      'Hide a lane with its checkbox to declutter; hidden lanes release their ring space.',
      'Deleting a lane removes its activities too (you’ll be asked to confirm).',
    ],
  },
  {
    title: 'Filtering & search',
    items: [
      'Search activity titles in the sidebar (press “/” to focus it).',
      'Filter by one or more labels, or by tagged people (inclusive OR).',
      'Toggle lane visibility to focus on specific rings.',
      'Set a custom start/end date range and apply it to the view.',
    ],
  },
  {
    title: 'Navigation & zoom',
    items: [
      'Zoom levels: Year → Quarter → Month → Week.',
      'Navigate with ◀ ▶ or the left/right arrow keys; zoom with − / +, the up/down arrows, or the scroll wheel on the disc.',
      'Use the year selector or the “Today” button to jump; Home / End jump to the planner’s start / end.',
      'Save views: store a named viewport + filter combination and switch between them.',
    ],
  },
  {
    title: 'Sharing & collaboration',
    items: [
      'Share with individual users by email, with view or edit permission.',
      'Share with a whole group, with optional per-member permission overrides.',
      'Enable a public link for read-only access without logging in, including an embed snippet.',
    ],
  },
  {
    title: 'Import & export',
    items: [
      'Import events from an .ics or .csv calendar file into a chosen (or new) lane.',
      'Print the disc or save it as a PDF.',
      'Download the disc as a PNG image.',
    ],
  },
  {
    title: 'Appearance & shortcuts',
    items: [
      'Toggle dark / light mode with the 🌙 button; the disc and dialogs follow the theme.',
      'Adjust lane border visibility and width in the sidebar’s Appearance section.',
      'Press “?” anytime for the full keyboard-shortcut list.',
    ],
  },
];
