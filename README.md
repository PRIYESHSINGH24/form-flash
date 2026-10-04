# FormFlash

A Chrome extension that fills Google Forms and Microsoft Forms using answers you save once.
Answers live in `chrome.storage.local`, nothing is sent anywhere, and the extension never
submits a form for you.

## Install

1. Clone or download this folder.
2. Open `chrome://extensions` and turn on Developer mode.
3. Click "Load unpacked" and pick this folder (the one with `manifest.json`).
4. Pin the extension so the icon stays in the toolbar.

After editing any file, hit Reload on the extension card and refresh the form page.

## Using it

Open a Google or Microsoft form and click the FormFlash icon in the toolbar, or the
"Fill form" button the extension puts in the bottom right corner of the page.

- Fields you already filled in are left alone.
- Nothing is submitted. Check the answers and submit the form yourself.
- Filled fields are outlined in orange for a moment so you can find them quickly.

### Detected questions

As soon as the popup opens on a form, it scans the page and lists every question it can
fill, whether or not you have an answer for it:

- `saved` means a saved answer matches the question.
- `filled` means the field already has a value on the page.
- `missing` means there is nothing to fill it with yet.

Missing questions get an input box, or a dropdown built from the form's own choices, plus a
Save button. Saving records that answer so the next form with the same question fills
itself. Questions that are already saved get their own Fill button, so you can fill one
question without running a full fill. The scan button in the panel header re-reads the page
if the form was still loading.

Keyboard shortcut: `Alt+Shift+F`. Change it at `chrome://extensions/shortcuts`.

The popup follows your system light or dark setting.

## Saving answers

The Answers tab has one row per answer: keywords on the left, the answer on the right.
Keywords are matched against the question text, so `email` covers "Email", "Email address"
and "College email". The longest matching keyword wins.

Prefix a keyword with `=` to require the whole question to match:

- `name` matches "Name", "Father's name" and "Full name"
- `=name` only matches "Name"

A few more notes:

- Checkbox answers go in as a comma separated list, e.g. `Java, Python`.
- Grid questions ("rate each of these") are matched row by row, so a keyword like
  `communication` can answer just the Communication row.
- Date, time and number answers are converted to what the input expects. `31/12/2026`,
  `October 4, 2026` and `2026-12-31` all work in a date field, and `9:30 am` works in a
  time field.

## Settings

Both toggles are on by default.

- "Keep filling as I move through sections" fills each new section of a multi-page form
  after you have filled the form once yourself.
- "Show the fill button on form pages" can be turned off if you prefer the toolbar popup
  or the shortcut.

Export and import write a JSON file you can move between browsers. "Delete all saved
answers" clears everything.

## What it fills

Text and paragraph boxes, radio buttons, checkboxes, dropdowns (native and ARIA), date,
time and number inputs, contenteditable answer boxes, and multiple choice and checkbox
grids. File uploads and image questions are skipped.

Google and Microsoft change their markup from time to time. If something stops working,
open an issue with the provider, the question type and what happened.

## Privacy

- Answers are stored locally with `chrome.storage.local`. There is no account and no server.
- The extension makes no network requests.
- Local storage is not encrypted, so treat it like anything else in your browser profile.
- When you submit a form, the form provider receives whatever you submit, as usual.

## Development

No build step and no dependencies. Load the folder as an unpacked extension and reload it
after edits.

Matching and input formatting live in `lib/matcher.js`. That file has no DOM access, so the
tests run in plain Node:

```bash
npm test
```

`tests/popup-preview.html` renders the popup in a normal tab with the extension APIs stubbed
out, which is handy for UI work:

```bash
python3 -m http.server 8765 --bind 127.0.0.1
# then open http://127.0.0.1:8765/tests/popup-preview.html
```

## Files

```
manifest.json      extension config (MV3)
background.js      keyboard shortcut -> fill request
content.js         runs on form pages: finds questions, matches, fills
lib/matcher.js     keyword matching and input formatting (shared, tested)
popup.html/css/js  the toolbar UI
tests/             unit tests and the popup preview
icons/             toolbar and store icons
```

## License

No license has been chosen yet. Ask before reusing the code.
