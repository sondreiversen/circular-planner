import { Activity, Lane } from './types';
import { COLOR_PALETTE, LANE_COLORS, randomId, formatDate, parseDate } from './utils';

type SaveActivityCallback = (activity: Activity) => void;
type DeleteActivityCallback = (activityId: string) => void;
type SaveLaneCallback = (lane: Lane) => void;
type DeleteLaneCallback = (laneId: string) => void;

function removeSafe(id: string): void {
  const el = document.getElementById(id);
  if (el) el.remove();
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

  const isEdit = !!existingActivity;
  const defaultColor = existingActivity?.color || COLOR_PALETTE[0];
  const defaultStart = existingActivity ? existingActivity.startDate : formatDate(initialDate);
  const defaultEnd   = existingActivity ? existingActivity.endDate
    : formatDate(new Date(initialDate.getTime() + 7 * 24 * 3600 * 1000));

  const laneOptions = lanes
    .sort((a, b) => a.order - b.order)
    .map(l => `<option value="${l.id}" ${(existingActivity?.laneId || laneId) === l.id ? 'selected' : ''}>${escHtml(l.name)}</option>`)
    .join('');

  const colorPicker = createColorPicker(defaultColor, COLOR_PALETTE);
  const colorPickerHolder = document.createElement('div');
  colorPickerHolder.id = 'cp-color-picker-holder';

  const dialog = document.createElement('section');
  dialog.id = DIALOG_ID;
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.style.cssText = `
    position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;
    display:flex;align-items:center;justify-content:center;
    background:rgba(0,0,0,0.4);
  `;

  dialog.innerHTML = `
    <div style="background:white;border-radius:6px;padding:24px;width:420px;max-width:95vw;box-shadow:0 8px 32px rgba(0,0,0,0.2);">
      <h2 style="margin:0 0 16px;font-size:16px;font-family:sans-serif;">${isEdit ? 'Edit Activity' : 'Add Activity'}</h2>
      <label style="display:block;margin-bottom:12px;font-family:sans-serif;font-size:13px;">
        Title <span style="color:red">*</span>
        <input id="cp-act-title" type="text" value="${escHtml(existingActivity?.title || '')}"
          style="display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:6px 8px;border:1px solid #ccc;border-radius:3px;font-size:13px;">
      </label>
      <div style="display:flex;gap:12px;margin-bottom:12px;">
        <label style="flex:1;font-family:sans-serif;font-size:13px;">
          Start date <span style="color:red">*</span>
          <input id="cp-act-start" type="date" value="${defaultStart}"
            style="display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:6px 8px;border:1px solid #ccc;border-radius:3px;font-size:13px;">
        </label>
        <label style="flex:1;font-family:sans-serif;font-size:13px;">
          End date <span style="color:red">*</span>
          <input id="cp-act-end" type="date" value="${defaultEnd}"
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
          style="display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:6px 8px;border:1px solid #ccc;border-radius:3px;font-size:13px;resize:vertical;">${escHtml(existingActivity?.description || '')}</textarea>
      </label>
      <label style="display:block;margin-bottom:16px;font-family:sans-serif;font-size:13px;">
        Colour
        <div id="cp-color-picker-holder"></div>
      </label>
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

  const close = () => removeSafe(DIALOG_ID);

  dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); });
  document.getElementById('cp-act-cancel')?.addEventListener('click', close);

  document.getElementById('cp-act-save')?.addEventListener('click', () => {
    const title = (document.getElementById('cp-act-title') as HTMLInputElement).value.trim();
    const start = (document.getElementById('cp-act-start') as HTMLInputElement).value;
    const end   = (document.getElementById('cp-act-end') as HTMLInputElement).value;
    const lane  = (document.getElementById('cp-act-lane') as HTMLSelectElement).value;
    const desc  = (document.getElementById('cp-act-desc') as HTMLTextAreaElement).value.trim();
    const color = getSelectedColor(colorPicker);

    if (!title || !start || !end) { alert('Please fill in title, start date, and end date.'); return; }
    if (start > end) { alert('Start date must be before end date.'); return; }

    const activity: Activity = {
      id: existingActivity?.id || randomId(),
      laneId: lane,
      title,
      description: desc,
      startDate: start,
      endDate: end,
      color,
    };
    onSave(activity);
    close();
  });

  document.getElementById('cp-act-delete')?.addEventListener('click', () => {
    if (existingActivity && confirm(`Delete activity "${existingActivity.title}"?`)) {
      onDelete(existingActivity.id);
      close();
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

  const isEdit = !!existingLane;
  const defaultColor = existingLane?.color || LANE_COLORS[nextOrder % LANE_COLORS.length];

  const colorPicker = createColorPicker(defaultColor, LANE_COLORS);

  const dialog = document.createElement('section');
  dialog.id = DIALOG_ID;
  dialog.setAttribute('role', 'dialog');
  dialog.style.cssText = `
    position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;
    display:flex;align-items:center;justify-content:center;
    background:rgba(0,0,0,0.4);
  `;

  dialog.innerHTML = `
    <div style="background:white;border-radius:6px;padding:24px;width:360px;max-width:95vw;box-shadow:0 8px 32px rgba(0,0,0,0.2);">
      <h2 style="margin:0 0 16px;font-size:16px;font-family:sans-serif;">${isEdit ? 'Edit Lane' : 'Add Lane'}</h2>
      <label style="display:block;margin-bottom:12px;font-family:sans-serif;font-size:13px;">
        Lane name <span style="color:red">*</span>
        <input id="cp-lane-name" type="text" value="${escHtml(existingLane?.name || '')}"
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

  const close = () => removeSafe(DIALOG_ID);

  dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); });
  document.getElementById('cp-lane-cancel')?.addEventListener('click', close);

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
    close();
  });

  document.getElementById('cp-lane-delete')?.addEventListener('click', () => {
    if (existingLane && confirm(`Delete lane "${existingLane.name}" and all its activities?`)) {
      onDelete(existingLane.id);
      close();
    }
  });

  (document.getElementById('cp-lane-name') as HTMLInputElement)?.focus();
}

function escHtml(str: string): string {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
