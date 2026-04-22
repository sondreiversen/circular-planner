import { ymdToDmy, dmyToYmd } from './utils';

const CALENDAR_ICON = `<svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <rect x="1.5" y="2.5" width="12" height="11" rx="1.5"/>
  <line x1="1.5" y1="6" x2="13.5" y2="6"/>
  <line x1="4.5" y1="1" x2="4.5" y2="4"/>
  <line x1="10.5" y1="1" x2="10.5" y2="4"/>
</svg>`;

// Monday-first weekday headers to match DD/MM/YYYY European convention
const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

interface DatePickerOptions {
  min?: string; // YYYY-MM-DD
  max?: string; // YYYY-MM-DD
}

interface DatePickerState {
  viewYear: number;
  viewMonth: number; // 0-based
  focusDay: string | null; // YYYY-MM-DD
}

function ymd(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function todayYmd(): string {
  const d = new Date();
  return ymd(d.getFullYear(), d.getMonth(), d.getDate());
}

function positionPopup(popup: HTMLElement, input: HTMLElement): void {
  const rect = input.getBoundingClientRect();
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  const popupWidth = 240;

  let left = rect.left + scrollX;
  let top = rect.bottom + scrollY + 4;

  // Prevent overflow off right edge of viewport
  if (left + popupWidth > window.innerWidth + scrollX) {
    left = Math.max(0, rect.right + scrollX - popupWidth);
  }

  popup.style.left = `${left}px`;
  popup.style.top = `${top}px`;
}

export function attachDatePicker(input: HTMLInputElement, options: DatePickerOptions = {}): void {
  // Wrap input in a relative-positioned span so the icon button can sit inside it
  const wrapper = document.createElement('span');
  wrapper.className = 'cp-date-field';
  input.insertAdjacentElement('beforebegin', wrapper);
  wrapper.appendChild(input);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'cp-date-field__btn';
  btn.setAttribute('aria-label', 'Open calendar');
  btn.innerHTML = CALENDAR_ICON;
  wrapper.appendChild(btn);

  let popup: HTMLElement | null = null;
  let state: DatePickerState = { viewYear: 0, viewMonth: 0, focusDay: null };

  function getSeedDate(): { year: number; month: number } {
    const parsed = dmyToYmd(input.value);
    if (parsed) {
      const [y, m] = parsed.split('-').map(Number);
      return { year: y, month: m - 1 };
    }
    const t = new Date();
    return { year: t.getFullYear(), month: t.getMonth() };
  }

  function closePopup(): void {
    if (popup) {
      popup.remove();
      popup = null;
    }
    document.removeEventListener('mousedown', onOutsideClick, true);
    window.removeEventListener('resize', closePopup);
    window.removeEventListener('scroll', closePopup, true);
  }

  function onOutsideClick(e: MouseEvent): void {
    if (popup && !popup.contains(e.target as Node) && e.target !== btn && e.target !== input) {
      closePopup();
    }
  }

  function selectDay(dayYmd: string): void {
    input.value = ymdToDmy(dayYmd);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    closePopup();
    input.focus();
  }

  function renderPopup(): void {
    if (!popup) return;

    const { viewYear, viewMonth, focusDay } = state;
    const today = todayYmd();
    const selectedYmd = dmyToYmd(input.value);

    // First day of the displayed month (0=Sun, 1=Mon, ..., 6=Sat)
    const firstDow = new Date(viewYear, viewMonth, 1).getDay();
    // Monday-first offset: Monday=0, ... Sunday=6
    const startOffset = (firstDow === 0 ? 6 : firstDow - 1);
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();

    const monthLabel = new Date(viewYear, viewMonth, 1).toLocaleString('en-GB', { month: 'long', year: 'numeric' });

    const cells: string[] = [];
    const totalCells = 42; // 6 rows × 7 cols

    for (let i = 0; i < totalCells; i++) {
      const dayNum = i - startOffset + 1;
      let cellYmd: string;
      let otherMonth = false;

      if (dayNum <= 0) {
        const prevMonthDays = new Date(viewYear, viewMonth, 0).getDate();
        const d = prevMonthDays + dayNum;
        const prevMonth = viewMonth === 0 ? 11 : viewMonth - 1;
        const prevYear = viewMonth === 0 ? viewYear - 1 : viewYear;
        cellYmd = ymd(prevYear, prevMonth, d);
        otherMonth = true;
      } else if (dayNum > daysInMonth) {
        const d = dayNum - daysInMonth;
        const nextMonth = viewMonth === 11 ? 0 : viewMonth + 1;
        const nextYear = viewMonth === 11 ? viewYear + 1 : viewYear;
        cellYmd = ymd(nextYear, nextMonth, d);
        otherMonth = true;
      } else {
        cellYmd = ymd(viewYear, viewMonth, dayNum);
      }

      const classes: string[] = ['cp-datepicker__day'];
      if (otherMonth) classes.push('cp-datepicker__day--other-month');
      if (cellYmd === today) classes.push('cp-datepicker__day--today');
      if (cellYmd === selectedYmd) classes.push('cp-datepicker__day--selected');
      if (focusDay === cellYmd) classes.push('cp-datepicker__day--focus');

      const disabled = (options.min && cellYmd < options.min) || (options.max && cellYmd > options.max);
      if (disabled) classes.push('cp-datepicker__day--disabled');

      const dayOfMonth = cellYmd.split('-')[2];
      cells.push(
        `<div class="${classes.join(' ')}" data-ymd="${cellYmd}" tabindex="-1">${parseInt(dayOfMonth, 10)}</div>`
      );
    }

    popup.innerHTML = `
      <div class="cp-datepicker__head">
        <button class="cp-datepicker__nav" data-action="prev" type="button" aria-label="Previous month">&#8249;</button>
        <span class="cp-datepicker__label">${monthLabel}</span>
        <button class="cp-datepicker__nav" data-action="next" type="button" aria-label="Next month">&#8250;</button>
      </div>
      <div class="cp-datepicker__weekdays">${WEEKDAYS.map(d => `<div>${d}</div>`).join('')}</div>
      <div class="cp-datepicker__grid">${cells.join('')}</div>
    `;

    // Focus the keyboard-focus cell if any
    if (focusDay) {
      const focusEl = popup.querySelector<HTMLElement>(`[data-ymd="${focusDay}"]`);
      focusEl?.focus();
    }
  }

  function openPopup(): void {
    if (popup) { closePopup(); return; }

    const seed = getSeedDate();
    const parsed = dmyToYmd(input.value);
    state = {
      viewYear: seed.year,
      viewMonth: seed.month,
      focusDay: parsed || null,
    };

    popup = document.createElement('div');
    popup.className = 'cp-datepicker-popup';
    document.body.appendChild(popup);
    positionPopup(popup, input);
    renderPopup();

    // Day click handler
    popup.addEventListener('click', (e) => {
      const target = (e.target as HTMLElement).closest('[data-ymd]') as HTMLElement | null;
      if (!target) return;
      if (target.classList.contains('cp-datepicker__day--disabled')) return;
      selectDay(target.dataset.ymd!);
    });

    // Nav buttons
    popup.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
      if (!btn) return;
      if (btn.dataset.action === 'prev') {
        if (state.viewMonth === 0) { state.viewYear--; state.viewMonth = 11; }
        else state.viewMonth--;
        renderPopup();
      } else if (btn.dataset.action === 'next') {
        if (state.viewMonth === 11) { state.viewYear++; state.viewMonth = 0; }
        else state.viewMonth++;
        renderPopup();
      }
    });

    // Keyboard nav inside popup
    popup.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closePopup(); input.focus(); return; }

      const current = state.focusDay || dmyToYmd(input.value) || todayYmd();
      const [cy, cm, cd] = current.split('-').map(Number);
      const currentDate = new Date(cy, cm - 1, cd);

      let handled = false;
      if (e.key === 'ArrowLeft')  { currentDate.setDate(currentDate.getDate() - 1); handled = true; }
      if (e.key === 'ArrowRight') { currentDate.setDate(currentDate.getDate() + 1); handled = true; }
      if (e.key === 'ArrowUp')    { currentDate.setDate(currentDate.getDate() - 7); handled = true; }
      if (e.key === 'ArrowDown')  { currentDate.setDate(currentDate.getDate() + 7); handled = true; }
      if (e.key === 'PageUp')   { currentDate.setMonth(currentDate.getMonth() - 1); handled = true; }
      if (e.key === 'PageDown') { currentDate.setMonth(currentDate.getMonth() + 1); handled = true; }

      if (e.key === 'Enter') {
        if (state.focusDay) {
          const focusEl = popup?.querySelector<HTMLElement>(`[data-ymd="${state.focusDay}"]`);
          if (focusEl && !focusEl.classList.contains('cp-datepicker__day--disabled')) {
            selectDay(state.focusDay);
          }
        }
        return;
      }

      if (handled) {
        e.preventDefault();
        const newYmd = ymd(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate());
        state.focusDay = newYmd;
        state.viewYear = currentDate.getFullYear();
        state.viewMonth = currentDate.getMonth();
        renderPopup();
      }
    });

    document.addEventListener('mousedown', onOutsideClick, true);
    window.addEventListener('resize', closePopup);
    window.addEventListener('scroll', closePopup, true);
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    openPopup();
  });

  // Alt+Down on the input opens the picker
  input.addEventListener('keydown', (e) => {
    if (e.altKey && e.key === 'ArrowDown') {
      e.preventDefault();
      openPopup();
    }
    if (e.key === 'Escape' && popup) {
      closePopup();
    }
  });
}
