# FormFlash

> **One-click autofill for Google Forms & Microsoft Forms — local-first, privacy-friendly, customizable, and open source.**

FormFlash is a browser extension that lets you save your commonly used answers once and reuse them across supported forms with a single click.

Your saved answers stay in your browser using `chrome.storage.local`. FormFlash does not require an account or a FormFlash backend, and it **never submits a form automatically**.

---

## Features

- **One-click autofill** for supported Google Forms and Microsoft Forms
- **Local-first storage** using `chrome.storage.local`
- **Custom question mappings** — teach FormFlash new questions as you encounter them
- **Keyword-based matching** so one saved answer can work across similar question wording
- **Exact matching** with `=keyword` for cases where precision matters
- **Text inputs, radio buttons, checkboxes, and dropdown-style controls** where supported by the current provider implementation
- **Unmatched question detection** so you can quickly add missing answers
- **Import / export** of your saved answers
- **Does not overwrite existing filled fields**
- **No automatic form submission**
- **No FormFlash backend required**

---

## Privacy by Design

FormFlash is designed around a simple principle:

> **Your saved answers should stay on your device unless you choose to submit them to a third-party form.**

FormFlash currently stores answer mappings in the browser through `chrome.storage.local` and does not require a FormFlash account or cloud database.

### What FormFlash does

```text
You save an answer
       ↓
chrome.storage.local
       ↓
You open a supported form
       ↓
FormFlash finds matching questions
       ↓
You click “Fill form”
       ↓
Fields are populated locally in the page
```

### Important

Local storage does **not** mean encryption or password-manager-level protection.

Also, when you submit a completed form, the form provider (for example, Google or Microsoft) can receive whatever information you submit through that form. FormFlash does not control the privacy practices of those third-party services.

---

## Supported Forms

FormFlash currently targets:

| Provider | Status |
|---|---|
| Google Forms | Supported |
| Microsoft Forms | Supported |

The extension currently matches these domains through its Manifest V3 content-script configuration:

- `docs.google.com/forms/*`
- `forms.office.com/*`
- `forms.microsoft.com/*`
- `forms.cloud.microsoft/*`

> Form providers can change their page structure over time. If a control stops working, please open an issue with a minimal reproducible example or sanitized DOM details.

---

## Installation

FormFlash can currently be installed locally as an unpacked Chrome extension.

### 1. Download the repository

```bash
git clone https://github.com/<your-username>/formflash.git
cd formflash
```

### 2. Open Chrome extensions

Go to:

```text
chrome://extensions
```

Turn on **Developer mode**.

### 3. Load FormFlash

Click **Load unpacked** and select the project directory containing `manifest.json`.

### 4. Pin the extension

Open the Chrome extensions menu and pin **FormFlash** for quick access.

---

## How to Use

### Step 1 — Save your answers

Open the FormFlash popup and add reusable mappings such as:

```text
Keyword: email
Answer: priyesh@example.com
```

```text
Keyword: phone
Answer: 9876543210
```

```text
Keyword: college
Answer: Bennett University
```

Answers are auto-saved locally in the browser.

### Step 2 — Open a supported form

Open a Google Form or Microsoft Form supported by the current implementation.

FormFlash provides a **Fill form** action through the extension UI and, where supported by the current page flow, a floating fill button on the form page.

### Step 3 — Review unmatched questions

Questions that could not be matched can be added from the popup under **Needs your answer**.

This creates a useful learning loop:

```text
New question
    ↓
No match
    ↓
Add answer once
    ↓
Save locally
    ↓
Reuse next time
```

### Step 4 — Review before submitting

FormFlash fills fields but **does not submit the form automatically**.

Always review the populated answers before pressing the form's own Submit button.

---

## Matching Rules

FormFlash uses keyword-based matching rather than blindly mapping every question to an answer.

### Normal keyword matching

```text
Keyword: email
```

Can match questions such as:

```text
Email
Email address
College email address
```

### Exact matching

Prefix a keyword with `=` when the whole normalized question should match that value.

```text
=name
```

This is intended to match:

```text
Name
```

without treating it as a generic match for questions such as:

```text
Father's Name
Mother's Name
Full Name
```

### Checkboxes

For multiple checkbox values, enter comma-separated answers:

```text
Java, Python
```

### Existing values are preserved

FormFlash avoids overwriting fields that are already populated by the user.

### Multi-page forms

For multi-page forms, you may need to run the fill action again after moving to a new page.

---

## Current Architecture

FormFlash is currently a Manifest V3 browser extension with four main parts:

```text
                  ┌──────────────────────┐
                  │      Popup UI        │
                  │ popup.html/css/js    │
                  └──────────┬───────────┘
                             │
                             ▼
                  ┌──────────────────────┐
                  │  chrome.storage.local│
                  │   Saved answers      │
                  └──────────┬───────────┘
                             │
                             ▼
                  ┌──────────────────────┐
                  │     content.js       │
                  │  Form page runtime   │
                  └──────────┬───────────┘
                             │
                    ┌────────┴────────┐
                    ▼                 ▼
             Google Forms      Microsoft Forms
                    │                 │
                    └────────┬────────┘
                             ▼
                    Question matching
                             │
                             ▼
                       Field filling
```

### Current repository files

```text
formflash/
├── manifest.json     # Chrome Manifest V3 configuration
├── content.js        # Form detection, matching, filling and page-side UI
├── popup.html        # Extension popup markup
├── popup.css         # Popup styling
├── popup.js          # Saved answers, import/export and popup behavior
├── icons/             # Extension icons
└── README.md          # Project documentation
```

The project is intentionally lightweight and currently does not require a backend or build server to load the extension locally.

---

## Development

### Requirements

- Google Chrome or another Chromium-based browser with extension support
- Git
- A code editor

### Local development

Clone the repository:

```bash
git clone https://github.com/<your-username>/formflash.git
cd formflash
```

Load the project as an unpacked extension from:

```text
chrome://extensions
```

After changing extension files, use the **Reload** button on the extension card and refresh the form page.

### Recommended development loop

```text
Change code
    ↓
Reload extension
    ↓
Refresh form
    ↓
Test fill behavior
    ↓
Check console
    ↓
Update tests/docs
```

---

## Testing Strategy

As FormFlash evolves into a larger open-source project, the project should keep provider behavior and matching logic independently testable.

Priority areas:

```text
Core matching
    ↓
Option matching
    ↓
Question detection
    ↓
Google Forms controls
    ↓
Microsoft Forms controls
    ↓
Storage/import/export
    ↓
End-to-end browser behavior
```

When reporting a bug, include the provider, control type, question pattern, expected behavior, and actual behavior. Never include real personal information in issues or pull requests.

---

## Contributing

FormFlash is intended to be an open-source, community-driven project.

Contributions are welcome in areas such as:

- Improving question matching
- Fixing Google Forms compatibility
- Fixing Microsoft Forms compatibility
- Adding better support for form controls
- Improving accessibility
- Improving the popup UX
- Adding automated tests
- Improving documentation
- Adding browser/provider compatibility

### Contribution flow

```text
Fork
  ↓
Create a feature/fix branch
  ↓
Make your change
  ↓
Test locally
  ↓
Update documentation/tests
  ↓
Open a Pull Request
  ↓
Review
  ↓
Merge
```

Good branch examples:

```text
feat/profile-support
fix/google-checkbox
fix/microsoft-dropdown
test/matcher-cases
docs/installation-guide
refactor/provider-detection
```

For the full contribution process, see `CONTRIBUTING.md` once the contributor guide is added to the repository.

---

## Reporting Bugs

Before opening an issue:

1. Check whether the problem is already reported.
2. Confirm that you are using a supported form provider.
3. Reload the extension and reproduce the problem.
4. Remove all real personal information from screenshots and examples.

A useful bug report includes:

```text
Provider:
Browser:
Question type:
Expected behavior:
Actual behavior:
Steps to reproduce:
Console errors (if relevant):
```

For security vulnerabilities, do not publish sensitive details in a public GitHub issue. Use the project's private security-reporting process once `SECURITY.md` is configured.

---

## Roadmap

### Phase 1 — Reliable core

- [ ] Extract matching logic into independently testable modules
- [ ] Add provider-specific modules
- [ ] Add matcher unit tests
- [ ] Add DOM fixtures for supported controls
- [ ] Add storage schema/versioning
- [ ] Improve error and unmatched-question reporting

### Phase 2 — Better UX

- [ ] Multiple answer profiles
- [ ] Profile switching
- [ ] Better onboarding
- [ ] Bulk answer management
- [ ] Accessibility improvements

### Phase 3 — Ecosystem

- [ ] Broader browser support
- [ ] More form providers
- [ ] Public compatibility documentation
- [ ] Community discussions
- [ ] Chrome Web Store release

> The roadmap is directional. Issues and community contributions can change priorities as the project grows.

---

## Security Principles

FormFlash handles user-provided answers, so security and privacy are core engineering concerns.

The project aims to follow these principles:

- Store reusable answers locally by default
- Avoid unnecessary network communication
- Keep extension permissions minimal
- Never auto-submit forms
- Never commit real user data to the repository
- Review changes that affect storage, permissions, or form-page access carefully

If you discover a security issue, please report it privately rather than posting exploit details publicly.

---

## Current Permissions

The extension currently requests:

| Permission | Purpose |
|---|---|
| `storage` | Store saved answers locally in browser extension storage |
| `activeTab` | Support user-triggered actions on the active tab |
| `scripting` | Support script execution required by the extension's current behavior |

Permissions should be kept minimal. Any future permission change should be documented and justified in the relevant pull request.

---

## Design Principles

FormFlash follows a few simple rules:

> **Local first.**

Saved answers should stay on the user's device whenever possible.

> **Explicit user action.**

Filling should happen because the user asked FormFlash to fill the form.

> **Never silently submit.**

The user should review the completed form before submission.

> **Prefer precision over aggressive matching.**

A missed field is better than silently filling the wrong answer.

> **Open source by default.**

The architecture, behavior, privacy model, and contribution process should remain understandable and reviewable by the community.

---

## Project Status

FormFlash is an actively developed project. Google Forms and Microsoft Forms DOM structures can change independently of this project, so compatibility may evolve over time.

The repository is being structured for open-source contributions, automated testing, provider-specific compatibility work, and community-driven improvements.

---

## Community

If FormFlash is useful to you, the most valuable ways to support the project are:

- Report reproducible bugs
- Improve documentation
- Add tests
- Fix provider compatibility issues
- Contribute new features through pull requests

Please avoid sharing real personal form data in public issues, pull requests, screenshots, fixtures, or examples.

---

##  License

The project's license should be added to the repository before the first public release. See the repository's `LICENSE` file for the final terms.

---

**FormFlash — save once, fill faster, stay in control.**
