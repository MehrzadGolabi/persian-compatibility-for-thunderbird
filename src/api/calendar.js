/*
 * Persian (Jalali) calendar for the Thunderbird calendar UI (experiment API).
 *
 * Nothing here converts dates by hand. The pieces that already exist are reused:
 *   - Gecko's Intl does the formatting (`calendar: "persian"`).
 *   - Gecko's Temporal does the calendar arithmetic (Persian months/years).
 *   - Thunderbird's own central formatter (cal.dtz.formatter) is where the calendar
 *     UI gets its date strings, so that is where the text is switched.
 *   - Week start / days off are Thunderbird's own prefs (calendar.week.*).
 * What has to be patched is only what hard-codes Gregorian months: the minimonth
 * grid, the month view's range/navigation, and a few labels.
 *
 * Stored calendar data is never touched: everything stays Gregorian internally and
 * only the presentation/navigation changes.
 *
 * Every patch is recorded and reversible. If applying any of them throws (e.g. a
 * Thunderbird version whose calendar code differs), everything is rolled back and the
 * calendar stays Gregorian: a half-Persian calendar is worse than none.
 *
 * Parts of showMonth()/selectDate() below are adapted from Thunderbird's
 * calendar-minimonth.js (MPL 2.0), changed to use Persian months.
 */

// All experiment scripts of an add-on share one global scope (implementation.js already
// declares ExtensionSupport, ExtensionCommon, ...), so keep everything inside a function.
var persianCalendar = (() => {
const { ExtensionSupport } = ChromeUtils.importESModule(
  "resource:///modules/ExtensionSupport.sys.mjs"
);
const { ExtensionCommon } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);

// `console` is not guaranteed in the experiment scope.
function log(level, ...args) {
  try {
    globalThis.console[level](...args);
  } catch (ex) {
    Services.console.logStringMessage(`Mahoor [${level}] ${args.join(" ")}`);
  }
}

const MIN_TESTED_MAJOR = 159;
const LISTENER_ID = "mahoor-persian-calendar";
const MESSENGER_URL = "chrome://messenger/content/messenger.xhtml";
// Documents (including iframes) that contain date pickers.
const PICKER_URLS = [
  "chrome://calendar/content/calendar-item-iframe.xhtml", // event/task editor (tab, dialog)
  "chrome://calendar/content/calendar-event-dialog-recurrence.xhtml",
  "chrome://calendar/content/calendar-event-dialog-attendees.xhtml",
  "chrome://calendar/content/calendar-event-dialog-reminder.xhtml",
  "chrome://calendar/content/calendar-event-dialog-timezone.xhtml",
];

/** Windows we patched: window -> list of recorded patches. */
const patchedWindows = new Map();
/** Patches of the shared (process-wide) calendar formatter module. */
const sharedPatches = [];
let localeObserver = null;
let listenerRegistered = false;
let documentObserver = null;
let printObserver = null;
/** The helpers of the current enable(): lets late callbacks detect they are stale. */
let currentHelpers = null;

// ---------------------------------------------------------------------------
// Reversible patching
// ---------------------------------------------------------------------------

/**
 * Replace obj[key] and record the original descriptor so restore() can undo it.
 *
 * @param {Array} list - where to record the patch
 * @param {object} obj
 * @param {string} key
 * @param {Function|object} value - a function (replaces the data/method value) or
 *   a partial property descriptor (e.g. { set(v) {} } to replace just a setter).
 * @returns {object|undefined} the original property descriptor
 */
function patch(list, obj, key, value) {
  const orig = Object.getOwnPropertyDescriptor(obj, key);
  let desc;
  if (typeof value == "function") {
    desc = { value, writable: true, configurable: true, enumerable: orig ? orig.enumerable : false };
  } else if ("value" in value) {
    desc = { configurable: true, enumerable: orig ? orig.enumerable : false, writable: true, value: value.value };
  } else {
    desc = { configurable: true, enumerable: orig ? orig.enumerable : false, ...orig, ...value };
  }
  Object.defineProperty(obj, key, desc);
  list.push({ obj, key, orig });
  return orig;
}

/** Record a cleanup action (e.g. removing an event listener) next to the patches. */
function onRestore(list, undo) {
  list.push({ undo });
}

function restore(list) {
  while (list.length) {
    const { obj, key, orig, undo } = list.pop();
    try {
      if (undo) {
        undo();
      } else if (orig) {
        Object.defineProperty(obj, key, orig);
      } else {
        delete obj[key];
      }
    } catch (ex) {
      // The object (e.g. a closed window) is gone; nothing to restore.
    }
  }
}

// ---------------------------------------------------------------------------
// Persian date helpers (Temporal + Intl)
// ---------------------------------------------------------------------------

function hasPersianTemporal(T) {
  try {
    const d = T.PlainDate.from({ year: 2026, month: 3, day: 21 }).withCalendar("persian");
    return d.year == 1405 && d.month == 1 && d.day == 1;
  } catch (ex) {
    return false;
  }
}

/**
 * @param {object} T - the Temporal namespace
 * @param {object} cal - Thunderbird's calendar utils namespace
 * @param {object} settings - { persianText, englishNumbers }
 */
function createHelpers(T, cal, settings) {
  const fmtCache = new Map();
  // The default follows the application language, like the stock calendar does.
  const locale = settings.persianText
    ? `fa-IR-u-nu-${settings.englishNumbers ? "latn" : "arabext"}`
    : undefined;

  /** An Intl.DateTimeFormat for the Persian calendar (cached). */
  function fmt(options) {
    const key = JSON.stringify(options);
    let f = fmtCache.get(key);
    if (!f) {
      const opts = { ...options, calendar: "persian" };
      f = locale
        ? new Intl.DateTimeFormat(locale, opts)
        : new Services.intl.DateTimeFormat(undefined, opts);
      fmtCache.set(key, f);
    }
    return f;
  }

  // Intl adds an era ("AP") that nobody writes in Iran. Drop it.
  const tidy = s => s.replace(/\s+/g, " ").trim();
  function format(options, jsDate) {
    return tidy(
      fmt(options)
        .formatToParts(jsDate)
        .filter(p => p.type != "era")
        .map(p => p.value)
        .join("")
    );
  }
  function formatRange(options, a, b) {
    return tidy(
      fmt(options)
        .formatRangeToParts(a, b)
        .filter(p => p.type != "era")
        .map(p => p.value)
        .join("")
    );
  }

  // --- calIDateTime -> JS Date, exactly like cal.dtz.formatter does internally ---
  const isRelative = dt => dt.isDate || dt.timezone.isFloating;
  function adjustedJsDate(dt) {
    const js = cal.dtz.dateTimeToJsDate(dt);
    // Floating times and dates are shown the same in every timezone; everything
    // else is shifted by its own offset and formatted as UTC.
    return isRelative(dt) ? js : new Date(js.valueOf() + dt.timezoneOffset * 1000);
  }
  const tzOption = dt => (isRelative(dt) ? undefined : "UTC");
  function formatDT(dt, options) {
    return format({ ...options, timeZone: tzOption(dt) }, adjustedJsDate(dt));
  }

  // --- JS Date <-> Persian PlainDate; always via year/month/day fields ---
  const toPD = d =>
    T.PlainDate.from({
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      day: d.getDate(),
    }).withCalendar("persian");
  // 12:34 avoids DST change points, as stock Thunderbird does for its grids.
  const toJS = pd => {
    const g = pd.withCalendar("iso8601");
    return new Date(g.year, g.month - 1, g.day, 12, 34, 0, 0);
  };
  const dtToPD = dt =>
    T.PlainDate.from({ year: dt.year, month: dt.month + 1, day: dt.day }).withCalendar("persian");
  const monthKey = pd => pd.year * 12 + pd.month;
  /** A calIDateTime like `template` but on the given Persian date (as a date-only or keeping the time). */
  function pdToDT(template, pd, dateOnly) {
    const g = pd.withCalendar("iso8601");
    const c = template.clone();
    c.resetTo(
      g.year,
      g.month - 1,
      g.day,
      dateOnly ? 0 : template.hour,
      dateOnly ? 0 : template.minute,
      dateOnly ? 0 : template.second,
      template.timezone
    );
    c.isDate = !!dateOnly;
    return c;
  }

  /** The first day of the Persian month containing the JS date, as a JS date. */
  const firstOfMonth = d => toJS(toPD(d).with({ day: 1 }));

  let monthNamesCache = null;
  /** The 12 Persian month names in the display language. */
  function monthNames() {
    if (!monthNamesCache) {
      monthNamesCache = [];
      for (let m = 1; m <= 12; m++) {
        const d = toJS(T.PlainDate.from({ calendar: "persian", year: 1404, month: m, day: 1 }));
        monthNamesCache.push(format({ month: "long" }, d));
      }
    }
    return monthNamesCache;
  }

  // --- Date pickers: always Iranian numeric yyyy/mm/dd (Latin digits unless Persian text+digits) ---
  const faDigits = !!settings.persianText && !settings.englishNumbers;
  const toFa = str => str.replace(/\d/g, d => "۰۱۲۳۴۵۶۷۸۹"[d]);
  const toLatin = str =>
    str
      .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06f0))
      .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660));
  const pad = n => String(n).padStart(2, "0");
  function formatNumeric(pd) {
    const str = `${pd.year}/${pad(pd.month)}/${pad(pd.day)}`;
    return faDigits ? toFa(str) : str;
  }
  const formatPickerDate = jsDate => formatNumeric(toPD(jsDate));

  /**
   * Parse what a user types into a date field. Accepts yyyy/mm/dd (also d/m/yyyy), any
   * separator, Persian/Arabic/Latin digits. A year of 1700 or more is read as Gregorian,
   * so pasting 2026-03-21 still works. Returns a local-midnight Date, or null.
   */
  function parsePickerDate(text) {
    const m = /^\D*(\d+)\D+(\d+)\D+(\d+)/.exec(toLatin(String(text)));
    if (!m) {
      return null;
    }
    let y, mo, d;
    if (m[3].length >= 3 && m[1].length < 3) {
      [d, mo, y] = [+m[1], +m[2], +m[3]];
    } else {
      [y, mo, d] = [+m[1], +m[2], +m[3]];
    }
    try {
      let g;
      if (y >= 1700) {
        g = T.PlainDate.from({ year: y, month: mo, day: d }, { overflow: "reject" });
      } else {
        if (y < 100) {
          // Two-digit year: within 30 years ahead / 69 back, like the stock picker.
          const cur = toPD(new Date()).year;
          y += cur - (cur % 100);
          if (y < cur - 69) {
            y += 100;
          }
          if (y > cur + 30) {
            y -= 100;
          }
        }
        g = T.PlainDate.from({ calendar: "persian", year: y, month: mo, day: d }, { overflow: "reject" })
          .withCalendar("iso8601");
      }
      return new Date(g.year, g.month - 1, g.day);
    } catch (ex) {
      return null;
    }
  }

  return {
    formatNumeric, formatPickerDate, parsePickerDate,
    fmt, format, formatRange, formatDT, adjustedJsDate, tzOption, isRelative,
    toPD, toJS, dtToPD, pdToDT, monthKey, firstOfMonth, monthNames, locale, cal,
  };
}

// ---------------------------------------------------------------------------
// Shared formatter (cal.dtz.formatter): only members that take a calIDateTime.
// Members that take Gregorian year/month numbers (formatMonthLong, monthNames,
// formatYear, ...) are deliberately left alone: other code indexes them as Gregorian.
// ---------------------------------------------------------------------------

function patchFormatter(cal, H) {
  const f = cal.dtz.formatter;
  const p = (key, fn) => patch(sharedPatches, f, key, fn);

  // Short dates: the Iranian numeric yyyy/mm/dd (also what the date pickers show/accept).
  p("formatDateShort", dt => H.formatNumeric(H.dtToPD(dt)));
  p("formatDateLong", dt => H.formatDT(dt, { dateStyle: "full" }));
  p("formatDateWithoutYear", dt => H.formatDT(dt, { month: "short", day: "numeric" }));
  p("formatDateLongWithoutYear", dt =>
    H.formatDT(dt, { weekday: "long", month: "long", day: "numeric" })
  );
  p("formatDateOnly", dt => H.formatDT(dt, { day: "numeric" }));

  const origDateTime = f.formatDateTime;
  p("formatDateTime", function (dt) {
    if (dt.isDate) {
      // "<date> All day": the original builds it with this.formatDate(), now Persian.
      return origDateTime.call(this, dt);
    }
    const long = Services.prefs.getIntPref("calendar.date.format", 0) == 0;
    return H.formatDT(dt, { dateStyle: long ? "full" : "short", timeStyle: "short" });
  });

  const origInterval = f.formatInterval;
  p("formatInterval", function (start, end) {
    if (start == null || end == null) {
      return origInterval.call(this, start, end);
    }
    return H.formatRange(
      {
        dateStyle: start.isDate ? "long" : "full",
        timeStyle: start.isDate ? undefined : "short",
        timeZone: H.tzOption(start),
      },
      H.adjustedJsDate(start),
      H.adjustedJsDate(end)
    );
  });

  if (H.locale) {
    // Persian-language mode: weekday names are calendar independent, so it is safe
    // to show them in Persian too (otherwise headers mix Persian and English).
    const names = style => {
      const wf = new Intl.DateTimeFormat(H.locale, { weekday: style });
      // 2001-01-07 was a Sunday: index 0 = Sunday, like the stock arrays.
      return [7, 1, 2, 3, 4, 5, 6].map(d => wf.format(new Date(2001, 0, d)));
    };
    for (const [key, style] of [
      ["narrowWeekdayNames", "narrow"],
      ["shortWeekdayNames", "short"],
      ["weekdayNames", "long"],
    ]) {
      patch(sharedPatches, f, key, { value: names(style) });
    }
  }
}

// ---------------------------------------------------------------------------
// Per-window patches (calendar custom elements live in messenger.xhtml)
// ---------------------------------------------------------------------------

function patchWindow(win, H, kind) {
  const list = [];
  patchedWindows.set(win, list);
  const p = (obj, key, value) => patch(list, obj, key, value);
  const { toPD, toJS, dtToPD, pdToDT, monthKey, firstOfMonth, format, cal } = H;

  // ----- minimonth ---------------------------------------------------------
  const Minimonth = win.customElements.get("calendar-minimonth");
  if (!Minimonth) {
    throw new Error("calendar-minimonth is not defined");
  }
  const mm = Minimonth.prototype;
  p(mm, "showMonth", function (aDate) {
    aDate = firstOfMonth(new Date(aDate || this.mExtraDate));
    // Don't fire the monthchange event upon initialization.
    const monthChanged = this.mEditorDate && this.mEditorDate.valueOf() != aDate.valueOf();
    this.mEditorDate = aDate; // Only place mEditorDate is set.

    if (this.mSelected) {
      this.mSelected.removeAttribute("selected");
      this.mSelected = null;
    }

    const today = new Date();

    if (!monthChanged && this.dayBoxes.size > 0) {
      this.mSelected = this.getBoxForDate(this.value);
      if (this.mSelected) {
        this.mSelected.toggleAttribute("selected", true);
      }
      const todayBox = this.getBoxForDate(today);
      if (this.mToday != todayBox) {
        if (this.mToday) {
          this.mToday.removeAttribute("today");
        }
        this.mToday = todayBox;
        if (this.mToday) {
          this.mToday.setAttribute("today", "true");
        }
      }
      return;
    }

    if (this.mToday) {
      this.mToday.removeAttribute("today");
      this.mToday = null;
    }
    if (this.mExtra) {
      this.mExtra.removeAttribute("extra");
      this.mExtra = null;
    }

    const pMain = toPD(aDate);
    // year/month attributes are data (other code selects on them): keep them
    // Gregorian, describing the same first-of-month date.
    this.setAttribute("year", aDate.getFullYear());
    this.setAttribute("month", aDate.getMonth());

    const names = H.monthNames();
    const miniMonthName = this.querySelector(".minimonth-month-name");
    const miniYearName = this.querySelector(".minimonth-year-name");
    const monthString = names[pMain.month - 1];
    miniMonthName.style.width = `${Math.max(...names.map(n => n.length)) + 1}ch`;
    miniMonthName.setAttribute("value", monthString);
    miniMonthName.setAttribute("monthIndex", pMain.month - 1);
    miniYearName.setAttribute("value", format({ year: "numeric" }, aDate));
    const monthYear = format({ month: "long", year: "numeric" }, aDate);
    this.mReadOnlyHeader.textContent = monthYear;

    const calbox = this.querySelector(".minimonth-calendar");
    const date = this._getStartDate(aDate);
    const shown = this.mValue || this.mExtraDate;
    calbox.ariaLabel = toPD(shown).year == pMain.year ? monthString : monthYear;

    this.dayBoxes.clear();
    const defaultTz = cal.dtz.defaultTimezone;
    const doc = this.ownerDocument;
    for (let k = 1; k < 7; k++) {
      // Set the week number (ISO weeks, as everywhere else in the calendar).
      const firstElement = this._getCalBoxNode(k, 0);
      firstElement.hidden = !this.showWeekNumber;
      if (this.showWeekNumber) {
        const weekNumber = cal.weekInfoService.getWeekTitle(
          cal.dtz.jsDateToDateTime(date, defaultTz)
        );
        firstElement.textContent = weekNumber;
        doc.l10n.setAttributes(firstElement, "week-title-label", { title: weekNumber });
      }

      for (let i = 1; i < 8; i++) {
        const day = this._getCalBoxNode(k, i);
        this.setBoxForDate(date, day);

        if (this.getAttribute("readonly") != "true") {
          day.setAttribute("interactive", "true");
        }

        const pd = toPD(date);
        const inMonth = monthKey(pd) == monthKey(pMain);
        if (inMonth) {
          day.removeAttribute("othermonth");
        } else {
          day.setAttribute("othermonth", "true");
        }

        if (this._sameDay(today, date)) {
          this.mToday = day;
          day.setAttribute("today", "true");
        }
        if (this._sameDay(this.value, date)) {
          this.mSelected = day;
          day.toggleAttribute("selected", true);
        }
        if (this._sameDay(this.mExtraDate, date)) {
          this.mExtra = day;
          day.setAttribute("extra", "true");
        }

        day.setAttribute(
          "aria-label",
          format(inMonth ? { day: "numeric" } : { dateStyle: "long" }, date)
        );
        day.removeAttribute("busy");

        day.date = new Date(date);
        day.textContent = format({ day: "numeric" }, date);
        date.setDate(date.getDate() + 1);

        this.resetAttributesForBox(day);
      }
    }

    if (!this.mFocused) {
      this.setFocusedDate(this.mValue || this.mExtraDate);
    }
    this.fireEvent("monthchange");
    if (this.getAttribute("freebusy") == "true") {
      this.getItems();
    }
  });

  p(mm, "updateAccessibleLabel", function () {
    if (this.mValue) {
      this.removeAttribute("data-l10n-id");
      this.setAttribute("aria-label", format({ dateStyle: "long" }, this.mValue));
    } else {
      this.ownerDocument.l10n.setAttributes(this, "minimonth-no-selected-date");
    }
  });

  p(mm, "advanceMonth", function (aDir) {
    this.showMonth(toJS(toPD(this.mEditorDate).add({ months: aDir })));
  });
  p(mm, "advanceYear", function (aDir) {
    this.showMonth(toJS(toPD(this.mEditorDate).add({ years: aDir })));
  });
  p(mm, "switchMonth", function (aMonth) {
    this.showMonth(toJS(toPD(this.mEditorDate).with({ month: aMonth + 1 })));
  });
  p(mm, "switchYear", function (aYear) {
    this.showMonth(toJS(toPD(this.mEditorDate).with({ year: aYear })));
  });
  p(mm, "moveDateByOffset", function (aYears, aMonths, aDays) {
    const pd = toPD(this.mFocused.date).add({ years: aYears, months: aMonths }).add({ days: aDays });
    this.focusDate(toJS(pd));
  });

  p(mm, "selectDate", function (aDate, aMainDate) {
    if (aMainDate) {
      // Month-like views: the "main" month is the one with the most visible days.
      // The caller computed it with Gregorian months; redo it with Persian ones.
      const counts = new Map();
      const view = win.currentView();
      const cur = view.startDay.clone();
      const end = view.endDay;
      let best = null;
      for (let n = 0; n < 60 && cur.compare(end) <= 0; n++) {
        const pd = dtToPD(cur);
        const key = monthKey(pd);
        const count = (counts.get(key) || 0) + 1;
        counts.set(key, count);
        if (!best || count > best.count) {
          best = { count, pd };
        }
        cur.day += 1;
      }
      aMainDate = best ? toJS(best.pd.with({ day: 1 })) : null;
    }
    if (!aMainDate || aDate < this._getStartDate(aMainDate) || aDate > this._getEndDate(aMainDate)) {
      aMainDate = firstOfMonth(aDate);
    }
    // Note that aMainDate and this.mEditorDate refer to the first day of the
    // corresponding (Persian) month.
    const sameMonth = this._sameDay(aMainDate, this.mEditorDate);
    const sameDate = this._sameDay(aDate, this.mValue);
    const setShowsToday = () => {
      const today = new Date();
      this.mShowsToday = this._sameDay(this.mValue, today);
    };
    if (!sameMonth && !sameDate) {
      this.mValue = aDate;
      setShowsToday();
      this.showMonth(aMainDate);
    } else if (!sameMonth) {
      this.showMonth(aMainDate);
    } else if (!sameDate) {
      const day = this.getBoxForDate(aDate);
      if (this.mSelected) {
        this.mSelected.removeAttribute("selected");
      }
      this.mSelected = day;
      day.toggleAttribute("selected", true);
      this.mValue = aDate;
      setShowsToday();
      this.setFocusedDate(aDate);
    }
  });

  // ----- date pickers (text field + popup) ---------------------------------
  // The popup is a minimonth (patched above). The text field formats and parses through
  // functions private to datetimepickers.js, so: replace the formatting setter, and take
  // over the field's "change" event (capture phase, before the stock handler) to parse.
  const Datepicker = win.customElements.get("datepicker");
  if (Datepicker) {
    const dpProto = Datepicker.prototype;
    p(dpProto, "_inputBoxValue", {
      set(val) {
        if (val == "forever") {
          this._inputField.value = this._foreverItem.label;
          return;
        }
        this._inputField.value = H.formatPickerDate(val);
      },
    });
    const hook = dp => {
      if (!dp._menulist || dp._mahoorHooked) {
        return;
      }
      const onChange = event => {
        // Only the text field's own change event. Not the picker's re-dispatched one
        // (target is the picker) and not the popup minimonth's change events.
        if (event.target == dp || dp._popup.contains(event.target)) {
          return;
        }
        event.stopImmediatePropagation();
        event.stopPropagation();
        const value = H.parsePickerDate(dp._inputBoxValue);
        if (!value) {
          dp._inputBoxValue = dp._minimonthValue; // not a date: put the old one back
          return;
        }
        dp._inputBoxValue = dp._minimonthValue = value;
        dp._valueIsForever = false;
        dp.dispatchEvent(new win.CustomEvent("change", { bubbles: true }));
      };
      dp._mahoorHooked = true;
      dp.addEventListener("change", onChange, true);
      onRestore(list, () => {
        dp.removeEventListener("change", onChange, true);
        delete dp._mahoorHooked;
      });
    };
    const origConnected = dpProto.connectedCallback;
    p(dpProto, "connectedCallback", function () {
      origConnected.call(this);
      hook(this);
    });
    for (const dp of win.document.querySelectorAll("datepicker")) {
      hook(dp); // pickers that were connected before we patched
    }
  }

  if (win.document.documentURI.endsWith("calendar-event-dialog-recurrence.xhtml")) {
    patchRecurrencePreview(win, H, p);
  }

  if (kind != "main") {
    return;
  }

  // ----- month view --------------------------------------------------------
  const BaseMonth = win.MozElements.CalendarMonthBaseView.prototype;
  const MonthView = win.customElements.get("calendar-month-view").prototype;

  /** Persian month range (as dates, like startOfMonth/endOfMonth) around a calIDateTime. */
  function monthRange(date) {
    const pd = dtToPD(date);
    const first = pd.with({ day: 1 });
    return [pdToDT(date, first, true), pdToDT(date, first.with({ day: pd.daysInMonth }), true)];
  }

  const origShowDate = BaseMonth.showDate;
  p(BaseMonth, "showDate", function (date) {
    if (!date || !this.showFullMonth) {
      return origShowDate.call(this, date);
    }
    const [start, end] = monthRange(date);
    this.setDateRange(start, end);
    this.selectedDay = date;
    return undefined;
  });

  // Day boxes outside the shown month are greyed out and the first/last day of a
  // month carries a month label: both were decided with Gregorian months in relayout().
  const origRelayout = BaseMonth.relayout;
  p(BaseMonth, "relayout", function () {
    origRelayout.call(this);
    const boxes = this.mDateBoxes;
    if (!boxes || !boxes.length) {
      return;
    }
    const mainKey = monthKey(dtToPD(this.rangeStartDate));
    for (const box of boxes) {
      const pd = dtToPD(box.mDate);
      if (this.showFullMonth) {
        const cls = box.classList;
        const current = monthKey(pd) == mainKey;
        cls.toggle("calendar-month-day-box-current-month", current);
        cls.toggle("calendar-month-day-box-other-month", !current);
      }
      box.showMonthLabel = pd.day == 1 || pd.day == pd.daysInMonth;
    }
    if (!this.showFullMonth) {
      boxes[0].showMonthLabel = true;
      boxes[boxes.length - 1].showMonthLabel = true;
    }
  });

  p(MonthView, "getRangeDescription", function () {
    const start = this.rangeStartDate;
    return format(
      { month: "long", year: "numeric" },
      new Date(start.year, start.month, start.day, 12, 34)
    );
  });

  p(MonthView, "moveView", function (number) {
    this.displayDaysOff = !this.mWorkdaysOnly;
    if (number) {
      const oldSelectedDay = this.selectedDay;
      // rangeStartDate is the first day of the Persian month being shown.
      const first = dtToPD(this.rangeStartDate).add({ months: number });
      this.goToDay(pdToDT(this.rangeStartDate, first, true));

      // Select the same day number in the new month (clamped to its length by Temporal).
      const moved = dtToPD(oldSelectedDay).add({ months: number });
      this.selectedDay = pdToDT(oldSelectedDay, moved, oldSelectedDay.isDate);
    } else {
      const date = cal.dtz.now();
      this.goToDay(date);
      this.selectedDay = date;
    }
  });

  // ----- today pane header (day number and "Mon YYYY") ---------------------
  const TodayPane = win.TodayPane;
  if (TodayPane && typeof TodayPane.setDay == "function") {
    const origSetDay = TodayPane.setDay;
    p(TodayPane, "setDay", function (aNewDate, aDontUpdateMinimonth) {
      origSetDay.call(this, aNewDate, aDontUpdateMinimonth);
      if (this.start) {
        const js = toJS(dtToPD(this.start));
        win.document.getElementById("datevalue-label").value = format({ day: "numeric" }, js);
        win.document.getElementById("monthNameContainer").value = format(
          { month: "short", year: "numeric" },
          js
        );
      }
    });
  }

  // ----- today pane mini date ----------------------------------------------
  const Minidate = win.customElements.get("calendar-minidate");
  if (Minidate) {
    const orig = Object.getOwnPropertyDescriptor(Minidate.prototype, "date");
    p(Minidate.prototype, "date", {
      ...orig,
      set(value) {
        const parts = H.fmt({ month: "short", day: "2-digit", year: "numeric" })
          .formatToParts(cal.dtz.dateTimeToJsDate(value))
          .reduce((prev, curr) => {
            prev[curr.type] = curr.value;
            return prev;
          }, {});
        this._monthSpan.textContent = parts.month;
        this._daySpan.textContent = parts.day;
        this._yearSpan.textContent = parts.year;
      },
    });
  }
}

/** The add-on's base URL (set when the API is created), to find its helper script. */
let extensionBase = null;
let helperScript = null;

/** Compile (once) the helper that hands out the recurrence dialog's RecurrencePreview. */
async function loadHelperScript() {
  if (!helperScript) {
    helperScript = await ChromeUtils.compileScript(`${extensionBase}api/recurrence-preview.js`);
  }
}

/**
 * The recurrence dialog's `RecurrencePreview` is a top-level `const`, so it is not a window
 * property, and the dialog's CSP blocks eval. A small script of ours, executed in that window's
 * global (as Thunderbird does for content scripts), can see it and hand it out.
 */
function getRecurrencePreview(win) {
  helperScript.executeInGlobal(win);
  const value = win.__mahoorRecurrencePreview;
  delete win.__mahoorRecurrencePreview;
  return value;
}

/**
 * The recurrence dialog previews the occurrences in nine read-only minimonths. It steps through
 * Gregorian months by itself, so replace those few methods with Persian-month versions.
 * (The recurrence *rules* stay Gregorian: that is what iCalendar can express.)
 * Adapted from calendar-event-dialog-recurrence.js (MPL 2.0).
 */
function patchRecurrencePreview(win, H, p) {
  const Preview = getRecurrencePreview(win);
  if (!Preview) {
    throw new Error("RecurrencePreview not found");
  }
  const { toPD, toJS, dtToPD, firstOfMonth, cal } = H;
  // The minimonths are keyed by the Gregorian year/month of the first day of the Persian month
  // they show. Those first days fall in different Gregorian months, and the 25th of that
  // Gregorian month is always inside the Persian month that started in it.
  const firstDayOfKey = (year, month) =>
    toPD(new Date(parseInt(year, 10), parseInt(month, 10), 25, 12, 34)).with({ day: 1 });

  p(Preview, "nextMonthDate", (year, month) => toJS(firstDayOfKey(year, month).add({ months: 1 })));
  p(Preview, "previousMonthDate", (year, month) =>
    toJS(firstDayOfKey(year, month).add({ months: -1 }))
  );

  const origDisplayCurrentMonths = Preview.displayCurrentMonths;
  p(Preview, "displayCurrentMonths", function (activeDate) {
    return origDisplayCurrentMonths.call(this, firstOfMonth(activeDate));
  });

  p(Preview, "updateContent", function () {
    let date = firstOfMonth(cal.dtz.dateTimeToJsDate(this.dateTime));
    for (const minimonth of this.node.children) {
      minimonth.showMonth(date);
      date = toJS(toPD(date).add({ months: 1 }));
    }
  });

  p(Preview, "updatePreview", function (recurrenceInfo) {
    const calMinimonth = this.node.querySelector("calendar-minimonth");
    this.node.style.minHeight = calMinimonth.getBoundingClientRect().height + "px";
    this.mRecurrenceInfo = recurrenceInfo;

    const dayStart = pd => {
      const g = pd.withCalendar("iso8601");
      const c = this.dateTime.clone();
      c.resetTo(g.year, g.month - 1, g.day, 0, 0, 0, c.timezone);
      return c;
    };
    let pd = dtToPD(this.dateTime).with({ day: 1 });
    let start = dayStart(pd);
    let end = dayStart(pd.add({ months: 1 }));

    for (const minimonth of this.node.children) {
      // 'start' and 'end' are the interval this minimonth shows (one Persian month).
      minimonth.showMonth(cal.dtz.dateTimeToJsDate(start));
      if (recurrenceInfo) {
        const dates = recurrenceInfo.getOccurrenceDates(start, end, 0);
        let index = 0;
        let occurrence = null;
        if (index < dates.length) {
          occurrence = dates[index++].getInTimezone(start.timezone);
        }
        const current = start.clone();
        while (current.compare(end) < 0) {
          const box = minimonth.getBoxForDate(current);
          if (box) {
            if (
              occurrence &&
              occurrence.day == current.day &&
              occurrence.month == current.month &&
              occurrence.year == current.year
            ) {
              box.setAttribute("busy", 1);
              if (index < dates.length) {
                occurrence = dates[index++].getInTimezone(start.timezone);
                // The very next occurrence can happen on the same day as the previous one.
                if (
                  occurrence.day == current.day &&
                  occurrence.month == current.month &&
                  occurrence.year == current.year
                ) {
                  continue;
                }
              } else {
                occurrence = null;
              }
            } else {
              box.removeAttribute("busy");
            }
          }
          current.day++;
        }
      }
      pd = pd.add({ months: 1 });
      start = end;
      end = dayStart(pd.add({ months: 1 }));
    }
  });
}

/** Re-render what is already on screen after patching or unpatching. */
function refreshWindow(win) {
  for (const mm of win.document.querySelectorAll("calendar-minimonth")) {
    if (mm.dayBoxes) {
      // Same as the minimonth's own reaction to a preference change.
      mm.dayBoxes.clear();
      mm.refreshDisplay();
    }
  }
  if (win.document.documentURI.endsWith("calendar-event-dialog-recurrence.xhtml")) {
    try {
      const preview = getRecurrencePreview(win);
      if (preview && preview.node && preview.mDateTime) {
        preview.updatePreview(preview.mRecurrenceInfo);
      }
    } catch (ex) {
      log("warn", "Mahoor: could not refresh the recurrence preview", ex);
    }
  }
  for (const dp of win.document.querySelectorAll("datepicker")) {
    try {
      if (dp._menulist && !dp._valueIsForever) {
        dp._inputBoxValue = dp._minimonthValue; // re-render the text field
      }
    } catch (ex) {
      // not initialised yet
    }
  }
  if (win.TodayPane?.start) {
    try {
      win.TodayPane.setDay(win.TodayPane.start, true); // re-render the header labels
    } catch (ex) {
      // today pane not ready
    }
  }
  // Weekday/date header labels cache their text; re-assign so they re-read the formatter.
  for (const label of win.document.querySelectorAll("calendar-day-label")) {
    try {
      if (typeof label.mWeekday == "number") {
        label.weekDay = label.mWeekday;
      }
      if (label.mDate) {
        label.date = label.mDate;
      }
    } catch (ex) {
      // not initialised yet
    }
  }
  for (const view of win.document.querySelectorAll(
    "calendar-month-view, calendar-multiweek-view, calendar-week-view, calendar-day-view"
  )) {
    try {
      if (!view.hasConnected || !(view.mStartDate || view.startDate)) {
        continue;
      }
      const selected = view.selectedDay;
      if (view.showFullMonth !== undefined && selected) {
        view.goToDay(selected); // month views: ranges differ, so this re-lays out.
      }
      if (typeof view.relayout == "function") {
        view.relayout();
      }
    } catch (ex) {
      log("warn", "Mahoor: could not refresh calendar view", ex);
    }
  }
}

// ---------------------------------------------------------------------------
// enable / disable
// ---------------------------------------------------------------------------

/** Every open chrome window and the chrome iframes inside it. */
function* chromeWindowsDeep() {
  const walk = function* (w) {
    yield w;
    let count = 0;
    try {
      count = w.frames.length;
    } catch (ex) {
      return;
    }
    for (let i = 0; i < count; i++) {
      try {
        yield* walk(w.frames[i]);
      } catch (ex) {
        // inaccessible frame
      }
    }
  };
  for (const w of Services.wm.getEnumerator(null)) {
    yield* walk(w);
  }
}

/**
 * Patch a calendar document once its custom elements exist. Used for the main window and
 * for the editor/dialog documents that hold date pickers.
 */
function applyToWindow(win, H, kind) {
  if (patchedWindows.has(win)) {
    return;
  }
  // "datepicker" itself is not a valid name for whenDefined() (no hyphen). datetimepickers.js
  // defines it right after menulist-editable, and our callback is queued after its own.
  const names = kind == "picker" ? ["calendar-minimonth", "menulist-editable"] : ["calendar-minimonth"];
  Promise.all([loadHelperScript(), ...names.map(n => win.customElements.whenDefined(n))]).then(
    () => {
      // Still enabled with the same settings, window still alive and not patched yet?
      if (H !== currentHelpers || win.closed || patchedWindows.has(win)) {
        return;
      }
      try {
        patchWindow(win, H, kind);
      } catch (ex) {
        // Atomic: undo every patch (this window's partial ones and all the others).
        log("error", "Mahoor: Persian calendar not applied, staying Gregorian:", ex);
        rollbackAfterFailure();
        return;
      }
      win.addEventListener("unload", () => patchedWindows.delete(win), { once: true });
      refreshWindow(win);
    },
    ex => log("error", "Mahoor: calendar elements never became ready:", ex)
  );
}

function disableAll() {
  currentHelpers = null;
  if (printObserver) {
    Services.obs.removeObserver(printObserver, "subdialog-loaded");
    printObserver = null;
  }
  if (documentObserver) {
    Services.obs.removeObserver(documentObserver, "chrome-document-loaded");
    documentObserver = null;
  }
  if (listenerRegistered) {
    ExtensionSupport.unregisterWindowListener(LISTENER_ID);
    listenerRegistered = false;
  }
  if (localeObserver) {
    Services.obs.removeObserver(localeObserver, "intl:app-locales-changed");
    localeObserver = null;
  }
  const windows = [...patchedWindows.keys()];
  for (const win of windows) {
    restore(patchedWindows.get(win));
    patchedWindows.delete(win);
  }
  restore(sharedPatches);
  for (const win of windows) {
    try {
      refreshWindow(win);
    } catch (ex) {
      // window already gone
    }
  }
}

function enableAll(options) {
  disableAll(); // idempotent: re-enabling with new options starts from a clean slate

  // The patches replace copies of Thunderbird's own calendar code, which differs between
  // versions: only turn them on for versions they were written and tested against.
  if (parseInt(Services.appinfo.version, 10) < MIN_TESTED_MAJOR) {
    return { enabled: false, reason: `The Persian calendar needs Thunderbird ${MIN_TESTED_MAJOR} or newer.` };
  }
  const wins = [...Services.wm.getEnumerator("mail:3pane")];
  const T = wins[0]?.Temporal ?? globalThis.Temporal;
  if (!T || !hasPersianTemporal(T)) {
    return { enabled: false, reason: "This Thunderbird has no Temporal API with a Persian calendar." };
  }
  const { cal } = ChromeUtils.importESModule("resource:///modules/calendar/calUtils.sys.mjs");
  const H = createHelpers(T, cal, options);

  try {
    currentHelpers = H;
    patchFormatter(cal, H);

    // The main window (calendar tab, today pane): the stock way to follow windows.
    listenerRegistered = true;
    ExtensionSupport.registerWindowListener(LISTENER_ID, {
      chromeURLs: [MESSENGER_URL],
      onLoadWindow(win) {
        applyToWindow(win, H, "main");
      },
      onUnloadWindow(win) {
        patchedWindows.delete(win);
      },
    });

    // Documents with date pickers (event editor in a tab or dialog, recurrence, ...) are
    // often iframes, which window listeners don't see: watch chrome document loads.
    documentObserver = {
      observe(subject) {
        try {
          const doc = subject.document ?? subject;
          if (PICKER_URLS.includes(doc.documentURI) && doc.defaultView) {
            applyToWindow(doc.defaultView, H, "picker");
          }
        } catch (ex) {
          log("warn", "Mahoor: could not inspect a new document", ex);
        }
      },
    };
    Services.obs.addObserver(documentObserver, "chrome-document-loaded");

    // The calendar's print dialog (print.html): Thunderbird loads the calendar-minimonth element
    // into it only when printing a calendar, after the "print-settings" event (see calPrintUtils).
    // Its date-range pickers only supply dates, so they can be Persian.
    printObserver = {
      async observe(dialogWindow) {
        try {
          if (!dialogWindow.location.href.startsWith("chrome://global/content/print.html")) {
            return;
          }
          await new Promise(resolve =>
            dialogWindow.document.addEventListener("print-settings", resolve, { once: true })
          );
          if (
            dialogWindow.PrintEventHandler?.activeCurrentURI ==
            "chrome://calendar/content/printing-template.html"
          ) {
            applyToWindow(dialogWindow, H, "print");
          }
        } catch (ex) {
          log("warn", "Mahoor: could not inspect the print dialog", ex);
        }
      },
    };
    Services.obs.addObserver(printObserver, "subdialog-loaded");
    // ...and the ones that are already open.
    for (const win of chromeWindowsDeep()) {
      try {
        if (PICKER_URLS.includes(win.document.documentURI) && win.document.readyState == "complete") {
          applyToWindow(win, H, "picker");
        }
      } catch (ex) {
        // not a window we can inspect
      }
    }
  } catch (ex) {
    log("error", "Mahoor: Persian calendar not applied, staying Gregorian:", ex);
    disableAll();
    return { enabled: false, reason: String(ex) };
  }

  // Cached formatters depend on the application locale.
  localeObserver = () => enableAll(options);
  Services.obs.addObserver(localeObserver, "intl:app-locales-changed");
  return { enabled: true };
}

function rollbackAfterFailure() {
  Services.tm.dispatchToMainThread(() => disableAll());
}

return class extends ExtensionCommon.ExtensionAPI {
  getAPI(context) {
    context.callOnClose(this);
    extensionBase = context.extension.baseURL;
    return {
      persianCalendar: {
        async enable(options) {
          try {
            return enableAll({
              persianText: !!options?.persianText,
              englishNumbers: !!options?.englishNumbers,
            });
          } catch (ex) {
            // Never leave a half-patched calendar behind.
            disableAll();
            log("error", "Mahoor: Persian calendar not applied:", ex);
            return { enabled: false, reason: `${ex.message} @ ${ex.stack}` };
          }
        },
        async disable() {
          disableAll();
        },
      },
    };
  }

  close() {
    disableAll();
  }
};
})();
