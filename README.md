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

Open a Google or Microsoft form. FormFlash docks a panel to the right edge of the page,
vertically centered, and fills in what it can:

- If a question has no saved answer, the panel opens by itself and lists those questions.
  Type or pick an answer and press Enter (or "Save & fill"). The answer is saved for next
  time and filled into the page right away.
- Questions you answered by hand are offered under "You answered N yourself", prefilled with
  what you typed, so one click saves them for the next form.
- "Fill saved answers" fills every question that has a saved answer. Nothing is submitted.
  Check the answers and submit the form yourself.
- When you move to the next section of a form, the panel checks the new questions and
  opens again if some have no answer. Questions it already asked about do not re-open it.
- Close the panel with the arrow or Esc. It collapses to a tab on the right edge with a
  count of unanswered questions (a check mark when everything has an answer).
- Fields you already filled in are left alone, and filled fields are outlined in orange for
  a moment so you can find them.

The toolbar icon opens the same information as a popup.

### Detected questions (toolbar popup)

As soon as the popup opens on a form, it scans the page and lists every question it can
fill, whether or not you have an answer for it:

- `saved` means a saved answer matches the question.
- `filled` means the field already has a value on the page.
- `missing` means there is nothing to fill it with yet.

Missing questions get an input box, or a dropdown built from the form's own choices, plus a
Save button. Questions that are already saved get their own Fill button, so you can fill one
question without running a full fill. The scan button in the panel header re-reads the page
if the form was still loading.

Keyboard shortcuts (change them at `chrome://extensions/shortcuts`):

- `Alt+Shift+F` fills the form.
- `Alt+Shift+P` opens or collapses the on-page panel.

The popup and the panel follow your system light or dark setting.

## Saving answers

The Answers tab has one row per answer: keywords on the left, the answer on the right.
Keywords are matched against the question text, so `email` covers "Email", "Email address"
and "College email". The longest matching keyword wins.

Answers you save from a question are stored with a safe keyword: one- and two-word questions
("Name", "Email") become exact `=` keywords so they cannot fill "Father's name"; longer
questions are saved as plain keywords. If a row already matches the question (the starter
rows for email, phone and so on), its answer is filled in instead of adding a duplicate.

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

All three toggles are on by default.

- "Fill new sections while I go through a multi-page form" fills each new section of a
  multi-page form after you have filled the form once yourself.
- "Show the FormFlash panel on form pages" can be turned off if you prefer the toolbar popup
  or the shortcut.
- "Open the panel by itself when a question has no saved answer" controls the auto-open.
  The panel also has a "Don't open automatically" link that switches it off.

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

`tests/e2e` has browser tests that run the content script and the popup in Chromium against
a mock form, with the `chrome` APIs stubbed (they do not load the extension itself):

```bash
npm i --no-save playwright && npx playwright install chromium
npm run e2e
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
background.js      keyboard shortcuts -> fill / toggle panel requests
content.js         runs on form pages: finds questions, matches, fills, draws the panel
lib/matcher.js     keyword matching and input formatting (shared, tested)
popup.html/css/js  the toolbar UI
tests/             unit tests, the popup preview and the browser tests (tests/e2e)
icons/             toolbar and store icons
```

## License

No license has been chosen yet. Ask before reusing the code.
