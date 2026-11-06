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
  .catch(onError);
