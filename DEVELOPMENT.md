# Development

Notes for working on the Thunderbird Persian compatibility add-on. For installing and using it, see the
[README](README.md).

## Layout

```
src/
  manifest.json        add-on manifest (version, permissions, experiment APIs)
  background/          background script: reads settings, registers the column and the mail content scripts
  api/
    implementation.js  experiment API: the "Persian Date" message-list column
    calendar.js        experiment API: Persian calendar, date pickers, recurrence preview, print dialog
    *schema.json       the schemas of the two experiment APIs
  rtl/                 content scripts that lay out mail right-to-left (reading and writing)
  options/             the options page
  _locales/            English and Persian names and descriptions
  assets/              icons and the Vazirmatn font used by the options page
```

## How it works

The add-on reuses what Thunderbird and Firefox already provide instead of reimplementing it.

* **Dates:** Gecko's `Intl` (with `calendar: "persian"`) formats dates and `Temporal` does the Persian calendar
  arithmetic. There is no hand-written Jalali conversion. They agree on every day from 1900 to 2100.
* **Message list:** Thunderbird's `ThreadPaneColumns` custom-column API.
* **Calendar:** Thunderbird's central calendar formatter (`cal.dtz.formatter`) supplies every date string in the
  calendar, so that is where the text is switched. The mini-month, month view, today pane and date pickers hard-code
  Gregorian months, so those few custom elements are patched, per window, with every patch recorded and
  reversible. If any patch fails the calendar stays Gregorian: a half-Persian calendar is worse than none.
  Stored events and tasks are never changed; only how dates are shown and navigated.
* **Mail:** Thunderbird's official `composeScripts` and `messageDisplayScripts` APIs inject small content scripts
  (`src/rtl/`) that set `dir` on blocks, which Thunderbird's own quote and list styles already follow.
* **Week start and days off:** Thunderbird's own `calendar.week.*` settings.

## Build

The add-on is the contents of `src/` zipped into an XPI:

```sh
cd src && zip -r -X ../thunderbird-persian-compatibility.xpi . -x '.*'
```

## Try a change

* **Temporary load:** in Thunderbird open **Tools > Add-ons and Themes**, click the gear, choose
  **Debug Add-ons > Load Temporary Add-on...** and pick `src/manifest.json`. Temporary add-ons disappear on restart.
  Reload it from the same page after editing the code.
* **Installed XPI:** build the XPI as above and install it with **Install Add-on From File...**.

The experiment APIs only run in the Thunderbird versions listed in `strict_min_version` and `strict_max_version` in
the manifest. To support a newer Thunderbird, check that it works, then raise `strict_max_version`.

## Releases

Releases are built by GitHub Actions (`.github/workflows/release.yml`).

1. Set the new `version` in `src/manifest.json` and commit it.
2. Tag the commit and push the tag; the tag must be `v` plus the manifest version:

   ```sh
   git tag v2.0.1
   git push origin v2.0.1
   ```

3. The workflow checks that the tag matches the manifest, builds
   `thunderbird-persian-compatibility-<version>.xpi` and publishes it on the
   [releases](https://github.com/MehrzadGolabi/thunderbird-persian-compatibility/releases) page with generated
   release notes.

The workflow can also be started by hand from the **Actions** tab; that only builds the XPI and attaches it to the
run as an artifact.

## Useful links

* [WebExtension API Developers Guide](https://firefox-source-docs.mozilla.org/toolkit/components/extensions/webextensions/index.html)
* [Browser Extensions](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions)
* [WebExtensions examples](https://github.com/mdn/webextensions-examples)
* [Thunderbird add-on documentation](https://webextension-api.thunderbird.net/)
