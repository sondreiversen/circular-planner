import { Activity, Lane, Recurrence } from './types';
import { COLOR_PALETTE, LANE_COLORS, randomId, formatDate, parseDate, escapeHtml, laneColor } from './utils';
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
      swatch.setAttribute('data-selected', 'true');
    }
    swatch.setAttribute('data-color', color);
    swatch.addEventListener('click', () => {
      wrapper.querySelectorAll('[data-color]').forEach(s => {
        s.removeAttribute('data-selected');
      });
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
  onDelete: DeleteActivityCallback,
  plannerEndDate?: string
): void {
  const DIALOG_ID = 'cp-activity-dialog';
  removeSafe(DIALOG_ID);
  const previouslyFocused = document.activeElement;

  const isEdit = !!existingActivity;
  const defaultColor = existingActivity?.color || COLOR_PALETTE[0];
  const defaultStart = existingActivity ? existingActivity.startDate : formatDate(initialDate);
  const defaultEnd   = existingActivity ? existingActivity.endDate
    : formatDate(new Date(initialDate.getTime() + 7 * 24 * 3600 * 1000));

  const laneOptions = lanes
    .sort((a, b) => a.order - b.order)
    .map(l => `<option value="${l.id}" ${(existingActivity?.laneId || laneId) === l.id ? 'selected' : ''}>${escapeHtml(l.name)}</option>`)
    .join('');

  const colorPicker = createColorPicker(defaultColor, COLOR_PALETTE);
  const colorPickerHolder = document.createElement('div');
  colorPickerHolder.id = 'cp-color-picker-holder';

  const existingRec = existingActivity?.recurrence ?? null;
  const recType = existingRec?.type ?? 'none';
  const recInterval = existingRec?.interval ?? 1;
  const recUntil = existingRec?.until ?? plannerEndDate ?? '';
  const recWeekdays: Set<number> = new Set(existingRec?.weekdays ?? []);

  const weekdayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  // JS weekday numbers for Mon..Sun: 1,2,3,4,5,6,0
  const weekdayValues = [1, 2, 3, 4, 5, 6, 0];
  const weekdayCheckboxes = weekdayLabels.map((label, idx) => {
    const val = weekdayValues[idx];
    const checked = recWeekdays.has(val) ? 'checked' : '';
    return `<label style="display:inline-flex;align-items:center;gap:2px;font-size:12px;cursor:pointer;">
      <input type="checkbox" name="cp-act-wd" value="${val}" ${checked}> ${label}
    </label>`;
  }).join('');

  const dialog = document.createElement('section');
  dialog.id = DIALOG_ID;
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'cp-act-dialog-title');
  dialog.className = 'cp-dialog-backdrop';

  dialog.innerHTML = `
    <div class="cp-dialog-box">
      <h2 id="cp-act-dialog-title" class="cp-dialog-title">${isEdit ? 'Edit Activity' : 'Add Activity'}</h2>
      <label class="cp-dialog-label">
        Title <span class="cp-required">*</span>
        <input id="cp-act-title" type="text" value="${escapeHtml(existingActivity?.title || '')}"
          class="cp-dialog-input">
      </label>
      <div class="cp-dialog-row">
        <label class="cp-dialog-label cp-dialog-label--flex">
          Start date <span class="cp-required">*</span>
          <input id="cp-act-start" type="date" value="${defaultStart}"
            class="cp-dialog-input">
        </label>
        <label class="cp-dialog-label cp-dialog-label--flex">
          End date <span class="cp-required">*</span>
          <input id="cp-act-end" type="date" value="${defaultEnd}"
            class="cp-dialog-input">
        </label>
      </div>
      <label class="cp-dialog-label">
        Lane
        <select id="cp-act-lane" class="cp-dialog-select">
          ${laneOptions}
        </select>
      </label>
      <label class="cp-dialog-label">
        Description
        <textarea id="cp-act-desc" rows="3" class="cp-dialog-textarea">${escapeHtml(existingActivity?.description || '')}</textarea>
      </label>
      <label class="cp-dialog-label">
        Label <span class="cp-dialog-hint">(e.g. vacation, launch)</span>
        <input id="cp-act-label" type="text" value="${escapeHtml(existingActivity?.label || '')}" placeholder="optional tag"
          class="cp-dialog-input">
      </label>
      <label class="cp-dialog-label">
        Repeat
        <select id="cp-act-recur-type" class="cp-dialog-select">
          <option value="none" ${recType === 'none' ? 'selected' : ''}>Does not repeat</option>
          <option value="daily" ${recType === 'daily' ? 'selected' : ''}>Daily</option>
          <option value="weekly" ${recType === 'weekly' ? 'selected' : ''}>Weekly</option>
        </select>
      </label>
      <div id="cp-act-recur-opts" style="${recType === 'none' ? 'display:none' : ''}">
        <div class="cp-dialog-row" style="align-items:center;gap:6px;">
          <span style="font-size:13px;">Every</span>
          <input id="cp-act-recur-interval" type="number" min="1" value="${recInterval}"
            class="cp-dialog-input" style="width:56px;">
          <span id="cp-act-recur-unit" style="font-size:13px;">${recType === 'weekly' ? 'week(s)' : 'day(s)'}</span>
        </div>
        <div id="cp-act-weekdays-row" style="${recType !== 'weekly' ? 'display:none' : ''}margin-top:6px;">
          <div style="font-size:12px;color:#5f6b7a;margin-bottom:4px;">Repeat on</div>
          <div style="display:flex;flex-wrap:wrap;gap:6px;">
            ${weekdayCheckboxes}
          </div>
        </div>
        <label class="cp-dialog-label" style="margin-top:6px;">
          Repeat until
          <input id="cp-act-recur-until" type="date" value="${recUntil}"
            class="cp-dialog-input">
        </label>
      </div>
      <label class="cp-dialog-label cp-dialog-label--last">
        Colour
        <div id="cp-color-picker-holder"></div>
      </label>
      ${isEdit && existingActivity?.createdBy ? `<div class="cp-dialog-meta">Created by ${escapeHtml(existingActivity.createdBy)}</div>` : ''}
      <div class="cp-dialog-actions">
        <div>
          ${isEdit ? '<button id="cp-act-delete" class="cp-dialog-btn cp-dialog-btn--danger">Delete</button>' : ''}
        </div>
        <div class="cp-dialog-actions-right">
          <button id="cp-act-cancel" class="cp-dialog-btn">Cancel</button>
          <button id="cp-act-save" class="cp-dialog-btn cp-dialog-btn--primary">${isEdit ? 'Save' : 'Add'}</button>
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

  // Wire recurrence type select
  const recurTypeEl = document.getElementById('cp-act-recur-type') as HTMLSelectElement;
  const recurOptsEl = document.getElementById('cp-act-recur-opts') as HTMLElement;
  const recurUnitEl = document.getElementById('cp-act-recur-unit') as HTMLElement;
  const weekdaysRowEl = document.getElementById('cp-act-weekdays-row') as HTMLElement;

  recurTypeEl?.addEventListener('change', () => {
    const val = recurTypeEl.value;
    recurOptsEl.style.display = val === 'none' ? 'none' : '';
    recurUnitEl.textContent = val === 'weekly' ? 'week(s)' : 'day(s)';
    weekdaysRowEl.style.display = val === 'weekly' ? '' : 'none';
  });

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
    const start = startRaw;
    const end   = endRaw;
    if (start > end) { alert('Start date must be before end date.'); return; }

    let recurrence: Recurrence | null = null;
    const selectedRecurType = (document.getElementById('cp-act-recur-type') as HTMLSelectElement)?.value;
    if (selectedRecurType && selectedRecurType !== 'none') {
      const intervalVal = parseInt((document.getElementById('cp-act-recur-interval') as HTMLInputElement)?.value || '1', 10);
      if (isNaN(intervalVal) || intervalVal < 1) { alert('Repeat interval must be at least 1.'); return; }

      const untilVal = (document.getElementById('cp-act-recur-until') as HTMLInputElement)?.value || undefined;

      if (selectedRecurType === 'weekly') {
        const checkedBoxes = Array.from(dialog.querySelectorAll<HTMLInputElement>('input[name="cp-act-wd"]:checked'));
        const selectedWeekdays = checkedBoxes.map(cb => parseInt(cb.value, 10));
        if (selectedWeekdays.length === 0) { alert('Please select at least one weekday for weekly recurrence.'); return; }
        recurrence = { type: 'weekly', interval: intervalVal, weekdays: selectedWeekdays, until: untilVal || undefined };
      } else {
        recurrence = { type: 'daily', interval: intervalVal, until: untilVal || undefined };
      }
    }

    const activity: Activity = {
      id: existingActivity?.id || randomId(),
      laneId: lane,
      title,
      description: desc,
      startDate: start,
      endDate: end,
      color,
      label,
      recurrence,
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
  dialog.className = 'cp-dialog-backdrop';

  dialog.innerHTML = `
    <div class="cp-dialog-box cp-dialog-box--narrow">
      <h2 id="cp-lane-dialog-title" class="cp-dialog-title">${isEdit ? 'Edit Lane' : 'Add Lane'}</h2>
      <label class="cp-dialog-label">
        Lane name <span class="cp-required">*</span>
        <input id="cp-lane-name" type="text" value="${escapeHtml(existingLane?.name || '')}"
          class="cp-dialog-input">
      </label>
      <label class="cp-dialog-label cp-dialog-label--last">
        Background colour
        <div id="cp-lane-color-holder"></div>
      </label>
      <div class="cp-dialog-actions">
        <div>
          ${isEdit ? '<button id="cp-lane-delete" class="cp-dialog-btn cp-dialog-btn--danger">Delete lane</button>' : ''}
        </div>
        <div class="cp-dialog-actions-right">
          <button id="cp-lane-cancel" class="cp-dialog-btn">Cancel</button>
          <button id="cp-lane-save" class="cp-dialog-btn cp-dialog-btn--primary">${isEdit ? 'Save' : 'Add'}</button>
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

// ── Calendar File Import Dialog ────────────────────────────────────────────

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
  dialog.className = 'cp-dialog-backdrop';

  dialog.innerHTML = `
    <div class="cp-dialog-box">
      <h2 id="cp-import-dialog-title" class="cp-dialog-title">Import Calendar</h2>
      <p class="cp-dialog-hint">Upload an exported calendar file (.ics or .csv) to import events as activities.</p>

      <label class="cp-dialog-label">
        Calendar file <span class="cp-required">*</span>
        <input id="cp-import-file" type="file" accept=".ics,.csv"
          class="cp-dialog-file-input">
      </label>

      <label class="cp-dialog-label">
        Target lane
        <select id="cp-import-lane" class="cp-dialog-select">
          <option value="">+ Auto-create "Imported" lane</option>
          ${laneOptions}
        </select>
      </label>

      <div id="cp-import-error" class="cp-dialog-error" style="display:none;"></div>

      <div class="cp-dialog-actions">
        <button id="cp-import-cancel" class="cp-dialog-btn">Cancel</button>
        <button id="cp-import-submit" class="cp-dialog-btn cp-dialog-btn--primary">Import</button>
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

  const errorEl = document.getElementById('cp-import-error')!;

  function showError(msg: string): void {
    errorEl.textContent = msg;
    errorEl.style.display = 'block';
  }

  document.getElementById('cp-import-submit')?.addEventListener('click', async () => {
    errorEl.style.display = 'none';
    const fileInput = document.getElementById('cp-import-file') as HTMLInputElement;
    const laneSelect = document.getElementById('cp-import-lane') as HTMLSelectElement;
    const submitBtn = document.getElementById('cp-import-submit') as HTMLButtonElement;

    const file = fileInput.files?.[0];
    if (!file) { showError('Please choose a .ics or .csv file.'); return; }

    const laneValue = laneSelect.value; // empty = auto-create

    submitBtn.disabled = true;
    submitBtn.textContent = 'Importing…';

    try {
      const formData = new FormData();
      formData.append('file', file);
      if (laneValue) formData.append('laneId', laneValue);

      // Use fetch directly with credentials (HttpOnly cookie auth)
      const resp = await fetch(`/api/planners/${plannerId}/import`, {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });

      if (!resp.ok) {
        const body = await resp.json().catch(() => ({ error: resp.statusText }));
        throw new Error(body.error || `Server error ${resp.status}`);
      }

      const result = await resp.json() as { imported: number; laneId: string; message?: string };

      if (result.imported === 0) {
        showError(result.message || 'No events found in the file.');
        return;
      }

      // Determine the lane used (existing or newly created on server).
      const targetLaneId = result.laneId;
      const existingLane = lanes.find(l => l.id === targetLaneId);
      let newLane: Lane | null = null;

      if (!existingLane) {
        newLane = {
          id: targetLaneId,
          name: 'Imported',
          order: nextLaneOrder,
          color: laneColor(nextLaneOrder),
          activities: [],
        };
      }

      // The server already persisted the activities; we signal the caller to
      // reload planner data rather than passing inline activities.
      // Pass an empty array — caller should trigger a full reload.
      onImport([], targetLaneId, newLane);
      closeAndCleanup();
    } catch (err) {
      showError((err as Error).message || 'Import failed.');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Import';
    }
  });

  (document.getElementById('cp-import-file') as HTMLInputElement)?.focus();
}

