/*
 * Loaded by api/calendar.js into the recurrence dialog's own global (Services.scriptloader.loadSubScript),
 * only to hand out its top-level `const RecurrencePreview`: that is a lexical binding, so it is not a
 * window property, and the dialog's CSP blocks eval.
 */
window.__mahoorRecurrencePreview = typeof RecurrencePreview == "undefined" ? null : RecurrencePreview;
