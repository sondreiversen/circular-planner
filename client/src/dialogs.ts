import { Activity, Lane, Recurrence, TaggedUser } from './types';
import { COLOR_PALETTE, LANE_COLORS, randomId, formatDate, parseDate, escapeHtml, laneColor, displayName } from './utils';
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

  // Track whether the selected color matches any preset swatch
  let presetMatched = false;

  palette.forEach(color => {
    const swatch = document.createElement('span');
    swatch.style.cssText = `width:22px;height:22px;border-radius:50%;background:${color};cursor:pointer;display:inline-block;border:2px solid transparent;`;
    if (color === selectedColor) {
      swatch.setAttribute('data-selected', 'true');
      presetMatched = true;
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

  // Custom hex color input
  const hexInput = document.createElement('input');
  hexInput.type = 'color';
  hexInput.title = 'Custom colour';
  hexInput.setAttribute('data-color', presetMatched ? palette[0] : selectedColor);
  hexInput.value = presetMatched ? palette[0] : selectedColor;
  hexInput.style.cssText = 'width:28px;height:22px;padding:0;border:2px solid transparent;border-radius:4px;cursor:pointer;background:none;vertical-align:middle;';
  if (!presetMatched) {
    hexInput.setAttribute('data-selected', 'true');
  }
  hexInput.addEventListener('input', () => {
    wrapper.querySelectorAll('[data-color]').forEach(s => {
      s.removeAttribute('data-selected');
    });
    hexInput.setAttribute('data-color', hexInput.value);
    hexInput.setAttribute('data-selected', 'true');
  });
  wrapper.appendChild(hexInput);

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
  // Tag-picker state — initialised from existing activity
  let selectedTags: TaggedUser[] = [...(existingActivity?.taggedUsers ?? [])];
  let tagSearchDebounce: ReturnType<typeof setTimeout> | null = null;
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
      <div class="cp-dialog-label">
        Tagged users <span class="cp-dialog-hint">(search by name or username)</span>
        <div id="cp-act-tag-chips" style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;min-height:24px;"></div>
        <div style="position:relative;">
          <input id="cp-act-tag-input" type="text" placeholder="Type to search users…"
            class="cp-dialog-input" style="margin-top:4px;" autocomplete="off">
          <div id="cp-act-tag-dropdown" style="display:none;position:absolute;z-index:200;left:0;right:0;background:var(--cp-surface,#fff);border:1px solid var(--cp-border,#d1d5db);border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,0.12);max-height:180px;overflow-y:auto;"></div>
        </div>
      </div>
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
          <div style="font-size:12px;color:var(--cp-text-muted);margin-bottom:4px;">Repeat on</div>
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

  // Wire tag picker
  const tagChipsEl = document.getElementById('cp-act-tag-chips') as HTMLElement;
  const tagInputEl = document.getElementById('cp-act-tag-input') as HTMLInputElement;
  const tagDropdownEl = document.getElementById('cp-act-tag-dropdown') as HTMLElement;

  function renderTagChips(): void {
    tagChipsEl.innerHTML = '';
    selectedTags.forEach(u => {
      const chip = document.createElement('span');
      chip.style.cssText = 'display:inline-flex;align-items:center;gap:3px;background:var(--cp-accent-light);color:var(--cp-accent-on);border-radius:12px;padding:2px 8px;font-size:12px;';
      const dn = displayName({ username: u.username, fullName: u.fullName });
      chip.textContent = dn;
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.textContent = '×';
      removeBtn.setAttribute('aria-label', `Remove ${dn}`);
      removeBtn.style.cssText = 'background:none;border:none;cursor:pointer;font-size:14px;line-height:1;padding:0 0 0 2px;color:inherit;';
      removeBtn.addEventListener('click', () => {
        selectedTags = selectedTags.filter(t => t.id !== u.id);
        renderTagChips();
      });
      chip.appendChild(removeBtn);
      tagChipsEl.appendChild(chip);
    });
  }

  function hideTagDropdown(): void {
    tagDropdownEl.style.display = 'none';
    tagDropdownEl.innerHTML = '';
  }

  renderTagChips();

  tagInputEl?.addEventListener('input', () => {
    const q = tagInputEl.value.trim();
    if (tagSearchDebounce) clearTimeout(tagSearchDebounce);
    if (q.length < 1) { hideTagDropdown(); return; }
    tagSearchDebounce = setTimeout(async () => {
      try {
        const users = await api.get<Array<{ id: number; username: string; email: string; fullName?: string | null }>>(`/api/users?q=${encodeURIComponent(q)}&includeSelf=1`);
        tagDropdownEl.innerHTML = '';
        if (users.length === 0) {
          const noResult = document.createElement('div');
          noResult.style.cssText = 'padding:8px 12px;font-size:13px;color:var(--cp-text-muted);';
          noResult.textContent = 'No users found';
          tagDropdownEl.appendChild(noResult);
          tagDropdownEl.style.display = '';
          return;
        }
        users.forEach(u => {
          if (selectedTags.find(t => t.id === u.id)) return; // already selected
          const item = document.createElement('div');
          item.style.cssText = 'padding:8px 12px;font-size:13px;cursor:pointer;';
          item.addEventListener('mouseenter', () => { item.style.background = 'var(--cp-accent-bg)'; });
          item.addEventListener('mouseleave', () => { item.style.background = ''; });
          const dn = displayName({ username: u.username, fullName: u.fullName ?? undefined });
          item.textContent = dn + (u.email ? ` <${u.email}>` : '');
          item.addEventListener('mousedown', (e) => {
            e.preventDefault(); // prevent blur on input
            const tag: TaggedUser = { id: u.id, username: u.username, fullName: u.fullName ?? undefined };
            if (!selectedTags.find(t => t.id === tag.id)) {
              selectedTags.push(tag);
              renderTagChips();
            }
            tagInputEl.value = '';
            hideTagDropdown();
            tagInputEl.focus();
          });
          tagDropdownEl.appendChild(item);
        });
        tagDropdownEl.style.display = '';
      } catch { hideTagDropdown(); }
    }, 200);
  });

  tagInputEl?.addEventListener('blur', () => {
    // Small delay so mousedown on a dropdown item fires first
    setTimeout(() => hideTagDropdown(), 150);
  });

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
      taggedUsers: selectedTags.length > 0 ? selectedTags : undefined,
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

