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
Right-to-left support for reading and writing mail (rtl/*.js, rtl/*.css), registered
through Thunderbird's own composeScripts / messageDisplayScripts APIs so it can be switched off.
*/
let rtlPrefs = {
  enabled: true,
};
let rtlRegistrations = [];

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

async function loadRtlSettings() {
  const stored = await browser.storage.local.get("rtlPrefs");
  if (stored.rtlPrefs) {
    rtlPrefs = { ...rtlPrefs, ...stored.rtlPrefs };
  }
}

/*
Register (or unregister) the RTL scripts for the compose editor and message display.
Called on startup and by the options page.
*/
async function applyRtl(newPrefs) {
  if (newPrefs) {
    rtlPrefs = { ...rtlPrefs, ...newPrefs };
  }
  for (const registration of rtlRegistrations.splice(0)) {
    try {
      await registration.unregister();
    } catch (e) {
      onError(e);
    }
  }
  if (!rtlPrefs.enabled) {
    return;
  }
  rtlRegistrations.push(
    await browser.composeScripts.register({
      js: [{ file: "rtl/common.js" }, { file: "rtl/compose.js" }],
      css: [{ file: "rtl/compose.css" }],
    })
  );
  rtlRegistrations.push(
    await browser.messageDisplayScripts.register({
      js: [{ file: "rtl/common.js" }, { file: "rtl/display.js" }],
      css: [{ file: "rtl/display.css" }],
      runAt: "document_end",
    })
  );
}

/*
With the default "Automatic" send format Thunderbird sends a simple HTML message as plain text
(it counts a bare dir="rtl" as "no formatting"), which would drop the direction we set while
writing. So, when the message carries a right-to-left direction and the user has not picked a
format, send HTML + text (what Automatic does for formatted mail). An explicit choice is kept.
*/
browser.compose.onBeforeSend.addListener(async (tab, details) => {
  try {
    if (
      rtlPrefs.enabled &&
      !details.isPlainText &&
      (details.deliveryFormat || "auto") === "auto" &&
      /<[a-z][^>]*\sdir=["']?rtl/i.test(details.body)
    ) {
      return { details: { deliveryFormat: "both" } };
    }
  } catch (e) {
    onError(e);
  }
  return {};
});

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
  .catch(onError)
  // Likewise for the mail RTL support.
  .then(() => loadRtlSettings())
  .then(() => applyRtl())
  .catch(onError);
