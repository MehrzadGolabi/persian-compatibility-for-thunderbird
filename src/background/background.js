/*
Default settings. Initialize storage to these values.
*/
let datePrefrences = {
  longMonth: true,
  twoDigitYear: false,
  showTime: true,
  weekDay: false,
  englishNumbers: false,
};

/*
Persian calendar (calendar tab / minimonth / today pane) settings.
Stored separately from the column settings.
*/
let calendarPrefs = {
  enabled: true,
  persianText: false,
};

/*
Generic error logger.
*/
function onError(e) {
  console.error(e);
}

/*
Load stored settings (falling back to / filling in the defaults) and
store the defaults on first run.
*/
async function loadSettings() {
  const stored = await browser.storage.local.get();
  if (!stored.datePrefrences) {
    await browser.storage.local.set({ datePrefrences: datePrefrences });
  } else {
    datePrefrences = { ...datePrefrences, ...stored.datePrefrences };
  }
}

async function loadCalendarSettings() {
  const stored = await browser.storage.local.get("calendarPrefs");
  if (stored.calendarPrefs) {
    calendarPrefs = { ...calendarPrefs, ...stored.calendarPrefs };
  }
}

/*
Apply the calendar settings: show the Persian calendar, or restore Gregorian.
Called on startup and by the options page.
*/
async function applyCalendar(newPrefs) {
  if (newPrefs) {
    calendarPrefs = { ...calendarPrefs, ...newPrefs };
  }
  if (!calendarPrefs.enabled) {
    await browser.persianCalendar.disable();
    return;
  }
  const result = await browser.persianCalendar.enable({
    persianText: calendarPrefs.persianText,
    englishNumbers: datePrefrences.englishNumbers,
  });
  if (!result.enabled) {
    console.warn("Persian calendar not enabled:", result.reason);
  }
}

/*
(Re)create the column with the given settings. Called by the options page.
*/
async function repaint(newSettings) {
  datePrefrences = newSettings;
  await browser.customColumns.remove("persianDateColumn");
  await browser.customColumns.add(
    "persianDateColumn",
    "Persian Date",
    "persianDate",
    newSettings
  );
  // The digit style also applies to the calendar when it uses Persian text.
  await applyCalendar();
}

/*
On startup, read the stored settings first so the column is created with them.
*/
loadSettings()
  .catch(onError)
  .then(() =>
    browser.customColumns.add(
      "persianDateColumn",
      "Persian Date",
      "persianDate",
      datePrefrences
    )
  )
  .catch(onError)
  // The calendar is independent of the column: a failure in one must not stop the other.
  .then(() => loadCalendarSettings())
  .then(() => applyCalendar())
  .catch(onError);
