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

const LISTENER_ID = "mahoor-persian-calendar";
const MESSENGER_URL = "chrome://messenger/content/messenger.xhtml";

/** Windows we patched: window -> list of recorded patches. */
const patchedWindows = new Map();
/** Patches of the shared (process-wide) calendar formatter module. */
const sharedPatches = [];
let localeObserver = null;
let listenerRegistered = false;

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

function restore(list) {
  while (list.length) {
    const { obj, key, orig } = list.pop();
    try {
      if (orig) {
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

  return {
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

  p("formatDateShort", dt => H.formatDT(dt, { dateStyle: "short" }));
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

function patchWindow(win, H) {
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

/** Re-render what is already on screen after patching or unpatching. */
function refreshWindow(win) {
  for (const mm of win.document.querySelectorAll("calendar-minimonth")) {
    if (mm.dayBoxes) {
      // Same as the minimonth's own reaction to a preference change.
      mm.dayBoxes.clear();
      mm.refreshDisplay();
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

function disableAll() {
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

  const wins = [...Services.wm.getEnumerator("mail:3pane")];
  const T = wins[0]?.Temporal ?? globalThis.Temporal;
  if (!T || !hasPersianTemporal(T)) {
    return { enabled: false, reason: "This Thunderbird has no Temporal API with a Persian calendar (needs 140+)." };
  }
  const { cal } = ChromeUtils.importESModule("resource:///modules/calendar/calUtils.sys.mjs");
  const H = createHelpers(T, cal, options);

  try {
    patchFormatter(cal, H);
    listenerRegistered = true;
    ExtensionSupport.registerWindowListener(LISTENER_ID, {
      chromeURLs: [MESSENGER_URL],
      onLoadWindow(win) {
        try {
          patchWindow(win, H);
        } catch (ex) {
          // Atomic: undo this window's partial patches and the shared ones.
          log("error", "Mahoor: Persian calendar not applied, staying Gregorian:", ex);
          rollbackAfterFailure();
          return;
        }
        refreshWindow(win);
      },
      onUnloadWindow(win) {
        patchedWindows.delete(win);
      },
    });
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
