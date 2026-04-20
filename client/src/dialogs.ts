import { Activity, Lane } from './types';
import { COLOR_PALETTE, LANE_COLORS, randomId, formatDate, parseDate, escapeHtml, ymdToDmy, dmyToYmd, laneColor } from './utils';
import { api } from './api-client';

type SaveActivityCallback = (activity: Activity) => void;
type DeleteActivityCallback = (activityId: string) => void;
type SaveLaneCallback = (lane: Lane) => void;
type DeleteLaneCallback = (laneId: string) => void;

function removeSafe(id: string): void {
  const el = document.getElementById(id);
  if (el) el.remove();
}

// ── Focus management helpers ──────────────────────────────────────────────────

const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Install focus trap inside `dialogEl`. Returns cleanup function. */
function installFocusTrap(dialogEl: HTMLElement): () => void {
  const handler = (e: KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const focusable = Array.from(dialogEl.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      .filter(el => el.offsetParent !== null); // skip hidden elements
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };
  dialogEl.addEventListener('keydown', handler);
  return () => dialogEl.removeEventListener('keydown', handler);
}

/** Wrap a close function so it also restores focus to `previouslyFocused`. */
function withFocusRestore(closeFn: () => void, previouslyFocused: Element | null): () => void {
  return () => {
    closeFn();
    if (previouslyFocused && (previouslyFocused as HTMLElement).focus) {
      (previouslyFocused as HTMLElement).focus();
    }
  };
}

function createColorPicker(selectedColor: string, palette: string[]): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'cp-planner-color-picker';
  wrapper.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-top:4px;';

  palette.forEach(color => {
    const swatch = document.createElement('span');
    swatch.style.cssText = `width:22px;height:22px;border-radius:50%;background:${color};cursor:pointer;display:inline-block;border:2px solid transparent;`;
    if (color === selectedColor) {
      swatch.style.border = '2px solid #333';
      swatch.setAttribute('data-selected', 'true');
    }
    swatch.setAttribute('data-color', color);
    swatch.addEventListener('click', () => {
      wrapper.querySelectorAll('[data-color]').forEach(s => {
        (s as HTMLElement).style.border = '2px solid transparent';
        s.removeAttribute('data-selected');
      });
      swatch.style.border = '2px solid #333';
      swatch.setAttribute('data-selected', 'true');
    });
    wrapper.appendChild(swatch);
  });

  return wrapper;
}

function getSelectedColor(picker: HTMLElement): string {
  const selected = picker.querySelector('[data-selected]') as HTMLElement | null;
  return selected ? selected.getAttribute('data-color') || COLOR_PALETTE[0] : COLOR_PALETTE[0];
}

/** Show modal to add/edit an activity. */
export function showActivityDialog(
  laneId: string,
  lanes: Lane[],
  initialDate: Date,
  existingActivity: Activity | null,
  onSave: SaveActivityCallback,
  onDelete: DeleteActivityCallback
): void {
  const DIALOG_ID = 'cp-activity-dialog';
  removeSafe(DIALOG_ID);
  const previouslyFocused = document.activeElement;

  const isEdit = !!existingActivity;
  const defaultColor = existingActivity?.color || COLOR_PALETTE[0];
  const defaultStart = ymdToDmy(existingActivity ? existingActivity.startDate : formatDate(initialDate));
  const defaultEnd   = ymdToDmy(existingActivity ? existingActivity.endDate
    : formatDate(new Date(initialDate.getTime() + 7 * 24 * 3600 * 1000)));

  const laneOptions = lanes
    .sort((a, b) => a.order - b.order)
    .map(l => `<option value="${l.id}" ${(existingActivity?.laneId || laneId) === l.id ? 'selected' : ''}>${escapeHtml(l.name)}</option>`)
    .join('');

  const colorPicker = createColorPicker(defaultColor, COLOR_PALETTE);
  const colorPickerHolder = document.createElement('div');
  colorPickerHolder.id = 'cp-color-picker-holder';

  const dialog = document.createElement('section');
  dialog.id = DIALOG_ID;
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'cp-act-dialog-title');
  dialog.style.cssText = `
    position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;
    display:flex;align-items:center;justify-content:center;
    background:rgba(0,0,0,0.4);
  `;

  dialog.innerHTML = `
    <div style="background:white;border-radius:6px;padding:24px;width:420px;max-width:95vw;box-shadow:0 8px 32px rgba(0,0,0,0.2);">
      <h2 id="cp-act-dialog-title" style="margin:0 0 16px;font-size:16px;font-family:sans-serif;">${isEdit ? 'Edit Activity' : 'Add Activity'}</h2>
      <label style="display:block;margin-bottom:12px;font-family:sans-serif;font-size:13px;">
        Title <span style="color:red">*</span>
        <input id="cp-act-title" type="text" value="${escapeHtml(existingActivity?.title || '')}"
          style="display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:6px 8px;border:1px solid #ccc;border-radius:3px;font-size:13px;">
      </label>
      <div style="display:flex;gap:12px;margin-bottom:12px;">
        <label style="flex:1;font-family:sans-serif;font-size:13px;">
          Start date <span style="color:red">*</span>
          <input id="cp-act-start" type="text" inputmode="numeric" placeholder="DD/MM/YYYY" value="${defaultStart}"
            style="display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:6px 8px;border:1px solid #ccc;border-radius:3px;font-size:13px;">
        </label>
        <label style="flex:1;font-family:sans-serif;font-size:13px;">
          End date <span style="color:red">*</span>
          <input id="cp-act-end" type="text" inputmode="numeric" placeholder="DD/MM/YYYY" value="${defaultEnd}"
            style="display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:6px 8px;border:1px solid #ccc;border-radius:3px;font-size:13px;">
        </label>
      </div>
      <label style="display:block;margin-bottom:12px;font-family:sans-serif;font-size:13px;">
        Lane
        <select id="cp-act-lane" style="display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:6px 8px;border:1px solid #ccc;border-radius:3px;font-size:13px;">
          ${laneOptions}
        </select>
      </label>
      <label style="display:block;margin-bottom:12px;font-family:sans-serif;font-size:13px;">
        Description
        <textarea id="cp-act-desc" rows="3"
          style="display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:6px 8px;border:1px solid #ccc;border-radius:3px;font-size:13px;resize:vertical;">${escapeHtml(existingActivity?.description || '')}</textarea>
      </label>
      <label style="display:block;margin-bottom:12px;font-family:sans-serif;font-size:13px;">
        Label <span style="color:#8896a5;font-weight:400;">(e.g. vacation, launch)</span>
        <input id="cp-act-label" type="text" value="${escapeHtml(existingActivity?.label || '')}" placeholder="optional tag"
          style="display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:6px 8px;border:1px solid #ccc;border-radius:3px;font-size:13px;">
      </label>
      <label style="display:block;margin-bottom:16px;font-family:sans-serif;font-size:13px;">
        Colour
        <div id="cp-color-picker-holder"></div>
      </label>
      ${isEdit && existingActivity?.createdBy ? `<div style="font-family:sans-serif;font-size:12px;color:#8896a5;margin-bottom:12px;">Created by ${escapeHtml(existingActivity.createdBy)}</div>` : ''}
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <div>
          ${isEdit ? '<button id="cp-act-delete" style="padding:7px 14px;background:#e53935;color:white;border:none;border-radius:3px;cursor:pointer;font-size:13px;">Delete</button>' : ''}
        </div>
        <div style="display:flex;gap:8px;">
          <button id="cp-act-cancel" style="padding:7px 14px;background:#f4f4f4;border:1px solid #ccc;border-radius:3px;cursor:pointer;font-size:13px;">Cancel</button>
          <button id="cp-act-save" style="padding:7px 14px;background:#0052cc;color:white;border:none;border-radius:3px;cursor:pointer;font-size:13px;">${isEdit ? 'Save' : 'Add'}</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(dialog);

  // Mount color picker
  const pickerSlot = document.getElementById('cp-color-picker-holder');
  if (pickerSlot) pickerSlot.replaceWith(colorPicker);

  const closeRaw = () => removeSafe(DIALOG_ID);
  const close = withFocusRestore(closeRaw, previouslyFocused);
  const removeTrap = installFocusTrap(dialog);
  const closeAndCleanup = () => { removeTrap(); close(); };

  dialog.addEventListener('click', (e) => { if (e.target === dialog) closeAndCleanup(); });
  document.getElementById('cp-act-cancel')?.addEventListener('click', closeAndCleanup);

  document.getElementById('cp-act-save')?.addEventListener('click', () => {
    const title = (document.getElementById('cp-act-title') as HTMLInputElement).value.trim();
    const startRaw = (document.getElementById('cp-act-start') as HTMLInputElement).value;
    const endRaw   = (document.getElementById('cp-act-end') as HTMLInputElement).value;
    const lane  = (document.getElementById('cp-act-lane') as HTMLSelectElement).value;
    const desc  = (document.getElementById('cp-act-desc') as HTMLTextAreaElement).value.trim();
    const label = (document.getElementById('cp-act-label') as HTMLInputElement).value.trim();
    const color = getSelectedColor(colorPicker);

    if (!title || !startRaw || !endRaw) { alert('Please fill in title, start date, and end date.'); return; }
    const start = dmyToYmd(startRaw);
    const end   = dmyToYmd(endRaw);
    if (!start || !end) { alert('Dates must be in DD/MM/YYYY format.'); return; }
    if (start > end) { alert('Start date must be before end date.'); return; }

    const activity: Activity = {
      id: existingActivity?.id || randomId(),
      laneId: lane,
      title,
      description: desc,
      startDate: start,
      endDate: end,
      color,
      label,
    };
    onSave(activity);
    closeAndCleanup();
  });

  document.getElementById('cp-act-delete')?.addEventListener('click', () => {
    if (existingActivity && confirm(`Delete activity "${existingActivity.title}"?`)) {
      onDelete(existingActivity.id);
      closeAndCleanup();
    }
  });

  (document.getElementById('cp-act-title') as HTMLInputElement)?.focus();
}

/** Show modal to add/edit a lane. */
export function showLaneDialog(
  existingLane: Lane | null,
  nextOrder: number,
  onSave: SaveLaneCallback,
  onDelete: DeleteLaneCallback
): void {
  const DIALOG_ID = 'cp-lane-dialog';
  removeSafe(DIALOG_ID);
  const previouslyFocused = document.activeElement;

  const isEdit = !!existingLane;
  const defaultColor = existingLane?.color || LANE_COLORS[nextOrder % LANE_COLORS.length];

  const colorPicker = createColorPicker(defaultColor, LANE_COLORS);

  const dialog = document.createElement('section');
  dialog.id = DIALOG_ID;
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'cp-lane-dialog-title');
  dialog.style.cssText = `
    position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;
    display:flex;align-items:center;justify-content:center;
    background:rgba(0,0,0,0.4);
  `;

  dialog.innerHTML = `
    <div style="background:white;border-radius:6px;padding:24px;width:360px;max-width:95vw;box-shadow:0 8px 32px rgba(0,0,0,0.2);">
      <h2 id="cp-lane-dialog-title" style="margin:0 0 16px;font-size:16px;font-family:sans-serif;">${isEdit ? 'Edit Lane' : 'Add Lane'}</h2>
      <label style="display:block;margin-bottom:12px;font-family:sans-serif;font-size:13px;">
        Lane name <span style="color:red">*</span>
        <input id="cp-lane-name" type="text" value="${escapeHtml(existingLane?.name || '')}"
          style="display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:6px 8px;border:1px solid #ccc;border-radius:3px;font-size:13px;">
      </label>
      <label style="display:block;margin-bottom:16px;font-family:sans-serif;font-size:13px;">
        Background colour
        <div id="cp-lane-color-holder"></div>
      </label>
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <div>
          ${isEdit ? '<button id="cp-lane-delete" style="padding:7px 14px;background:#e53935;color:white;border:none;border-radius:3px;cursor:pointer;font-size:13px;">Delete lane</button>' : ''}
        </div>
        <div style="display:flex;gap:8px;">
          <button id="cp-lane-cancel" style="padding:7px 14px;background:#f4f4f4;border:1px solid #ccc;border-radius:3px;cursor:pointer;font-size:13px;">Cancel</button>
          <button id="cp-lane-save" style="padding:7px 14px;background:#0052cc;color:white;border:none;border-radius:3px;cursor:pointer;font-size:13px;">${isEdit ? 'Save' : 'Add'}</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(dialog);

  const pickerSlot = document.getElementById('cp-lane-color-holder');
  if (pickerSlot) pickerSlot.replaceWith(colorPicker);

  const closeRaw = () => removeSafe(DIALOG_ID);
  const close = withFocusRestore(closeRaw, previouslyFocused);
  const removeTrap = installFocusTrap(dialog);
  const closeAndCleanup = () => { removeTrap(); close(); };

  dialog.addEventListener('click', (e) => { if (e.target === dialog) closeAndCleanup(); });
  document.getElementById('cp-lane-cancel')?.addEventListener('click', closeAndCleanup);

  document.getElementById('cp-lane-save')?.addEventListener('click', () => {
    const name = (document.getElementById('cp-lane-name') as HTMLInputElement).value.trim();
    if (!name) { alert('Please enter a lane name.'); return; }
    const color = getSelectedColor(colorPicker);

    const lane: Lane = {
      id: existingLane?.id || randomId(),
      name,
      order: existingLane?.order ?? nextOrder,
      color,
      activities: existingLane?.activities || [],
    };
    onSave(lane);
    closeAndCleanup();
  });

  document.getElementById('cp-lane-delete')?.addEventListener('click', () => {
    if (existingLane && confirm(`Delete lane "${existingLane.name}" and all its activities?`)) {
      onDelete(existingLane.id);
      closeAndCleanup();
    }
  });

  (document.getElementById('cp-lane-name') as HTMLInputElement)?.focus();
}

// ── Outlook Import Dialog ─────────────────────────────────────────────────

interface ImportedEvent {
  subject: string;
  description: string;
  startDate: string;
  endDate: string;
  location: string;
  categories: string[];
  isAllDay: boolean;
}

interface ImportResponse {
  events: ImportedEvent[];
  totalFound: number;
  errors: string[];
}

export function showOutlookImportDialog(
  plannerId: number,
  lanes: Lane[],
  nextLaneOrder: number,
  onImport: (activities: Activity[], targetLaneId: string, newLane: Lane | null) => void,
): void {
  const DIALOG_ID = 'cp-outlook-import-dialog';
  removeSafe(DIALOG_ID);
  const previouslyFocused = document.activeElement;

  const laneOptions = lanes
    .sort((a, b) => a.order - b.order)
    .map(l => `<option value="${l.id}">${escapeHtml(l.name)}</option>`)
    .join('');

  const dialog = document.createElement('section');
  dialog.id = DIALOG_ID;
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'cp-import-dialog-title');
  dialog.style.cssText = `
    position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;
    display:flex;align-items:center;justify-content:center;
    background:rgba(0,0,0,0.4);
  `;

  dialog.innerHTML = `
    <div style="background:white;border-radius:6px;padding:24px;width:520px;max-width:95vw;max-height:90vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,0.2);">
      <h2 id="cp-import-dialog-title" style="margin:0 0 16px;font-size:16px;font-family:sans-serif;">Import from Outlook</h2>

      <div id="cp-import-form">
        <label style="display:block;margin-bottom:10px;font-family:sans-serif;font-size:13px;">
          Exchange Server URL
          <input id="cp-import-url" type="text" placeholder="https://mail.example.com/ews/exchange.asmx"
            style="display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:6px 8px;border:1px solid #ccc;border-radius:3px;font-size:13px;">
        </label>
        <div style="display:flex;gap:12px;margin-bottom:10px;">
          <label style="flex:1;font-family:sans-serif;font-size:13px;">
            Username
            <input id="cp-import-user" type="text" placeholder="DOMAIN\\username"
              style="display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:6px 8px;border:1px solid #ccc;border-radius:3px;font-size:13px;">
          </label>
          <label style="flex:1;font-family:sans-serif;font-size:13px;">
            Password
            <input id="cp-import-pass" type="password"
              style="display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:6px 8px;border:1px solid #ccc;border-radius:3px;font-size:13px;">
          </label>
        </div>
        <div style="display:flex;gap:12px;margin-bottom:10px;">
          <label style="flex:1;font-family:sans-serif;font-size:13px;">
            Auth method
            <select id="cp-import-auth" style="display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:6px 8px;border:1px solid #ccc;border-radius:3px;font-size:13px;">
              <option value="ntlm" selected>NTLM</option>
              <option value="basic">Basic</option>
            </select>
          </label>
          <label style="flex:1;font-family:sans-serif;font-size:13px;">
            Target lane
            <select id="cp-import-lane" style="display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:6px 8px;border:1px solid #ccc;border-radius:3px;font-size:13px;">
              <option value="__new__">+ New lane: Outlook Import</option>
              ${laneOptions}
            </select>
          </label>
        </div>
        <div style="display:flex;gap:12px;margin-bottom:10px;">
          <label style="flex:1;font-family:sans-serif;font-size:13px;">
            Start date
            <input id="cp-import-start" type="text" inputmode="numeric" placeholder="DD/MM/YYYY"
              style="display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:6px 8px;border:1px solid #ccc;border-radius:3px;font-size:13px;">
          </label>
          <label style="flex:1;font-family:sans-serif;font-size:13px;">
            End date
            <input id="cp-import-end" type="text" inputmode="numeric" placeholder="DD/MM/YYYY"
              style="display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:6px 8px;border:1px solid #ccc;border-radius:3px;font-size:13px;">
          </label>
        </div>
        <label style="display:flex;align-items:center;gap:6px;margin-bottom:14px;font-family:sans-serif;font-size:13px;">
          <input id="cp-import-selfsigned" type="checkbox"> Allow self-signed certificate
        </label>
        <div id="cp-import-error" style="color:#e53935;font-size:13px;font-family:sans-serif;margin-bottom:10px;display:none;"></div>
        <div style="display:flex;justify-content:flex-end;gap:8px;">
          <button id="cp-import-cancel" style="padding:7px 14px;background:#f4f4f4;border:1px solid #ccc;border-radius:3px;cursor:pointer;font-size:13px;">Cancel</button>
          <button id="cp-import-fetch" style="padding:7px 14px;background:#0052cc;color:white;border:none;border-radius:3px;cursor:pointer;font-size:13px;">Fetch Events</button>
        </div>
      </div>

      <div id="cp-import-preview" style="display:none;">
        <div id="cp-import-summary" style="font-family:sans-serif;font-size:13px;margin-bottom:10px;"></div>
        <div id="cp-import-list" style="max-height:300px;overflow-y:auto;border:1px solid #e4e7ed;border-radius:3px;margin-bottom:14px;"></div>
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <button id="cp-import-back" style="padding:7px 14px;background:#f4f4f4;border:1px solid #ccc;border-radius:3px;cursor:pointer;font-size:13px;">Back</button>
          <div style="display:flex;gap:8px;">
            <button id="cp-import-cancel2" style="padding:7px 14px;background:#f4f4f4;border:1px solid #ccc;border-radius:3px;cursor:pointer;font-size:13px;">Cancel</button>
            <button id="cp-import-confirm" style="padding:7px 14px;background:#0052cc;color:white;border:none;border-radius:3px;cursor:pointer;font-size:13px;">Import Selected</button>
          </div>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(dialog);

  const closeRaw = () => removeSafe(DIALOG_ID);
  const close = withFocusRestore(closeRaw, previouslyFocused);
  const removeTrap = installFocusTrap(dialog);
  const closeAndCleanup = () => { removeTrap(); close(); };
  dialog.addEventListener('click', (e) => { if (e.target === dialog) closeAndCleanup(); });
  document.getElementById('cp-import-cancel')?.addEventListener('click', closeAndCleanup);
  document.getElementById('cp-import-cancel2')?.addEventListener('click', closeAndCleanup);

  const errorEl = document.getElementById('cp-import-error')!;
  const formEl = document.getElementById('cp-import-form')!;
  const previewEl = document.getElementById('cp-import-preview')!;
  let fetchedEvents: ImportedEvent[] = [];

  function showError(msg: string): void {
    errorEl.textContent = msg;
    errorEl.style.display = 'block';
  }

  interface JobStatusResponse {
    state: 'running' | 'done' | 'failed';
    completed_pages: number;
    total_pages: number;
    last_error?: string;
    result?: ImportResponse;
  }

  /** Poll for job status every 1.5 s. Resolves with result or rejects on failure. */
  function pollJobStatus(plannerId: number, jobId: string, onProgress: (completed: number, total: number) => void): Promise<ImportResponse> {
    return new Promise((resolve, reject) => {
      const poll = async () => {
        try {
          const status = await api.get<JobStatusResponse>(`/api/planners/${plannerId}/import/status/${jobId}`);
          if (status.state === 'done' && status.result) {
            resolve(status.result);
          } else if (status.state === 'failed') {
            reject(new Error(status.last_error || 'Import failed'));
          } else {
            onProgress(status.completed_pages, status.total_pages);
            setTimeout(poll, 1500);
          }
        } catch (err) {
          reject(err);
        }
      };
      poll();
    });
  }

  // Fetch events from Exchange
  document.getElementById('cp-import-fetch')?.addEventListener('click', async () => {
    errorEl.style.display = 'none';
    const serverUrl = (document.getElementById('cp-import-url') as HTMLInputElement).value.trim();
    const username = (document.getElementById('cp-import-user') as HTMLInputElement).value.trim();
    const password = (document.getElementById('cp-import-pass') as HTMLInputElement).value;
    const authMethod = (document.getElementById('cp-import-auth') as HTMLSelectElement).value;
    const startDmy = (document.getElementById('cp-import-start') as HTMLInputElement).value.trim();
    const endDmy = (document.getElementById('cp-import-end') as HTMLInputElement).value.trim();
    const allowSelfSignedCert = (document.getElementById('cp-import-selfsigned') as HTMLInputElement).checked;

    if (!serverUrl) { showError('Exchange server URL is required.'); return; }
    if (!username)  { showError('Username is required.'); return; }
    if (!password)  { showError('Password is required.'); return; }

    const startDate = dmyToYmd(startDmy);
    const endDate = dmyToYmd(endDmy);
    if (!startDate) { showError('Invalid start date. Use DD/MM/YYYY format.'); return; }
    if (!endDate)   { showError('Invalid end date. Use DD/MM/YYYY format.'); return; }

    const fetchBtn = document.getElementById('cp-import-fetch') as HTMLButtonElement;
    fetchBtn.disabled = true;
    fetchBtn.textContent = 'Fetching...';

    try {
      // Start the async job
      const { jobId } = await api.post<{ jobId: string }>(`/api/planners/${plannerId}/import/outlook`, {
        serverUrl, username, password, authMethod, startDate, endDate, allowSelfSignedCert,
      });

      // Poll with live progress text
      const result = await pollJobStatus(plannerId, jobId, (completed, total) => {
        if (total > 1) {
          fetchBtn.textContent = `Fetching… (${completed}/${total} months)`;
        }
      });

      fetchedEvents = result.events;
      const listEl = document.getElementById('cp-import-list')!;
      const summaryEl = document.getElementById('cp-import-summary')!;

      let summaryText = `Found ${result.totalFound} event${result.totalFound !== 1 ? 's' : ''}`;
      if (result.errors.length > 0) {
        summaryText += ` (${result.errors.length} could not be parsed)`;
      }
      summaryEl.textContent = summaryText;

      if (fetchedEvents.length === 0) {
        listEl.innerHTML = '<div style="padding:12px;font-family:sans-serif;font-size:13px;color:#8896a5;">No events found in this date range.</div>';
      } else {
        listEl.innerHTML = fetchedEvents.map((ev, i) => `
          <label style="display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border-bottom:1px solid #f0f0f0;cursor:pointer;font-family:sans-serif;font-size:13px;">
            <input type="checkbox" data-idx="${i}" checked style="margin-top:2px;">
            <div>
              <div style="font-weight:500;">${escapeHtml(ev.subject)}</div>
              <div style="color:#8896a5;font-size:12px;">${escapeHtml(ev.startDate)}${ev.endDate !== ev.startDate ? ' - ' + escapeHtml(ev.endDate) : ''}${ev.categories.length ? ' &middot; ' + escapeHtml(ev.categories.join(', ')) : ''}</div>
            </div>
          </label>
        `).join('');
      }

      formEl.style.display = 'none';
      previewEl.style.display = 'block';
    } catch (err) {
      showError((err as Error).message || 'Failed to fetch events.');
    } finally {
      fetchBtn.disabled = false;
      fetchBtn.textContent = 'Fetch Events';
    }
  });

  // Back to form
  document.getElementById('cp-import-back')?.addEventListener('click', () => {
    previewEl.style.display = 'none';
    formEl.style.display = 'block';
  });

  // Confirm import
  document.getElementById('cp-import-confirm')?.addEventListener('click', () => {
    const listEl = document.getElementById('cp-import-list')!;
    const checkboxes = listEl.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    const selectedIndices = new Set<number>();
    checkboxes.forEach(cb => {
      if (cb.checked) selectedIndices.add(Number(cb.dataset.idx));
    });

    if (selectedIndices.size === 0) { alert('No events selected.'); return; }

    const laneSelect = document.getElementById('cp-import-lane') as HTMLSelectElement;
    const laneValue = laneSelect.value;

    let newLane: Lane | null = null;
    let targetLaneId: string;

    if (laneValue === '__new__') {
      newLane = {
        id: randomId(),
        name: 'Outlook Import',
        order: nextLaneOrder,
        color: laneColor(nextLaneOrder),
        activities: [],
      };
      targetLaneId = newLane.id;
    } else {
      targetLaneId = laneValue;
    }

    const activities: Activity[] = [];
    let colorIdx = 0;
    fetchedEvents.forEach((ev, i) => {
      if (!selectedIndices.has(i)) return;
      activities.push({
        id: randomId(),
        laneId: targetLaneId,
        title: ev.subject,
        description: ev.description,
        startDate: ev.startDate,
        endDate: ev.endDate,
        color: COLOR_PALETTE[colorIdx % COLOR_PALETTE.length],
        label: ev.categories[0] || '',
      });
      colorIdx++;
    });

    onImport(activities, targetLaneId, newLane);
    closeAndCleanup();
  });

  (document.getElementById('cp-import-url') as HTMLInputElement)?.focus();
}

