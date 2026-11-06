const longMonthInput = document.querySelector("#longMonth");
const twoDigitYearInput = document.querySelector("#twoDigitYear");
const showTimeInput = document.querySelector("#showTime");
const weekDayInput = document.querySelector("#weekDay");
const englishNumbersInput = document.querySelector("#englishNumbers");
const calendarEnabledInput = document.querySelector("#calendarEnabled");
const rtlEnabledInput = document.querySelector("#rtlEnabled");
const calendarPersianTextInput = document.querySelector("#calendarPersianText");

/*
Store the currently selected settings using browser.storage.local.
*/
function storeSettings() {
  const newSettings = {
    longMonth: longMonthInput.checked,
    twoDigitYear: twoDigitYearInput.checked,
    showTime: showTimeInput.checked,
    weekDay: weekDayInput.checked,
    englishNumbers: englishNumbersInput.checked,
  };
  browser.storage.local.set({
    datePrefrences: newSettings,
  });
  browser.extension.getBackgroundPage().repaint(newSettings);
}

/*
Calendar settings are stored apart from the column settings.
*/
function storeCalendarSettings() {
  const calendarPrefs = {
    enabled: calendarEnabledInput.checked,
    persianText: calendarPersianTextInput.checked,
  };
  browser.storage.local.set({ calendarPrefs });
  browser.extension.getBackgroundPage().applyCalendar(calendarPrefs);
}

function storeRtlSettings() {
  const rtlPrefs = { enabled: rtlEnabledInput.checked };
  browser.storage.local.set({ rtlPrefs });
  browser.extension.getBackgroundPage().applyRtl(rtlPrefs);
}

function updateRtlUI(restored) {
  rtlEnabledInput.checked = { enabled: true, ...restored.rtlPrefs }.enabled;
}

function updateCalendarUI(restored) {
  const prefs = { enabled: true, persianText: false, ...restored.calendarPrefs };
  calendarEnabledInput.checked = prefs.enabled;
  calendarPersianTextInput.checked = prefs.persianText;
}

/*
Update the options UI with the settings values retrieved from storage,
or the default settings if the stored settings are empty.
*/
function updateUI(restoredSettings) {
  longMonthInput.checked = restoredSettings.datePrefrences.longMonth;
  twoDigitYearInput.checked = restoredSettings.datePrefrences.twoDigitYear;
  showTimeInput.checked = restoredSettings.datePrefrences.showTime;
  weekDayInput.checked = restoredSettings.datePrefrences.weekDay;
  englishNumbersInput.checked = restoredSettings.datePrefrences.englishNumbers;
}

function onError(e) {
  console.error(e);
}

/*
On opening the options page, fetch stored settings and update the UI with them.
*/
browser.storage.local.get().then(updateUI, onError);
browser.storage.local.get("calendarPrefs").then(updateCalendarUI, onError);
browser.storage.local.get("rtlPrefs").then(updateRtlUI, onError);

/*
On blur, save the currently selected settings.
*/
longMonthInput.addEventListener("change", storeSettings);
twoDigitYearInput.addEventListener("change", storeSettings);
showTimeInput.addEventListener("change", storeSettings);
weekDayInput.addEventListener("change", storeSettings);
englishNumbersInput.addEventListener("change", storeSettings);
rtlEnabledInput.addEventListener("change", storeRtlSettings);
calendarEnabledInput.addEventListener("change", storeCalendarSettings);
calendarPersianTextInput.addEventListener("change", storeCalendarSettings);
