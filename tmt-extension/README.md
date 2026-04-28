# TMT Translator — Chrome/Firefox Extension
### Google TMT Hackathon 2026 | Track 01

---

## Project Structure

```
tmt-extension/
├── manifest.json     ← Extension config (Manifest V3)
├── popup.html        ← Extension popup UI
├── popup.js          ← Popup logic & API calls
├── content.js        ← Injected into web pages (page translation)
├── content.css       ← Styles injected into pages
├── background.js     ← Service worker (right-click context menu)
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## How to Load in Chrome (Developer Mode)

1. Open Chrome and go to: `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `tmt-extension/` folder
5. The TMT Translator icon will appear in your toolbar

## How to Load in Firefox

1. Go to: `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on**
3. Select the `manifest.json` file inside `tmt-extension/`

---

## First-Time Setup

1. Click the TMT Translator icon in your browser toolbar
2. Enter your team API key: `team_xxxxxxxxxxxxxxxx`
3. Click **Save** — the key is stored securely using `chrome.storage.local`
4. Select your source and target language
5. Start translating!

---

## Features

| Feature | How |
|---|---|
| **Manual text translation** | Type/paste in popup, click Translate |
| **Full page translation** | Click "Translate Page" in popup |
| **Right-click translation** | Select text → Right-click → "Translate Selected Text" → choose language |
| **Open translator** | Right-click on page → "Open TMT Translator" to open popup |
| **Translate current page** | Right-click on page → "Open TMT Translator" → "Translate current page" → choose language |
| **Language swap** | Click ⇄ button |
| **Copy output** | Click "Copy Translation" after translating |

---

## API Notes

- Base URL: `https://tmt.ilprl.ku.edu.np/lang-translate`
- Language codes: `en`, `ne`, `tmg`
- API works **sentence by sentence** — content.js splits text accordingly
- Rate limiting: 150ms delay between sentences for large pages
- Always check `message_type` field — HTTP status is always 200

---

## Security

- API key stored in `chrome.storage.local` — never exposed in code
- Never commit your real API key to GitHub
- Use environment variables or the extension's own secure storage

---

## Supported Translation Directions

- English → Nepali
- English → Tamang
- Nepali → English
- Nepali → Tamang
- Tamang → English
- Tamang → Nepali

## Recommended Improvements
To make the extension behave like a complete full-page translator (similar to Chrome Translate), the following architectural improvements are recommended:
- Batch Translation
    Translate multiple texts at once → faster, fewer API calls
- Dynamic Content 
    Use MutationObserver → translate content loaded after page load
- Full UI Coverage 
    Include buttons, inputs, placeholders, aria-labels → complete translation
- Deduplication 
    Avoid re-translating same nodes → prevents broken text
- Caching 
    Store repeated translations → improves speed
- Viewport Priority 
    Translate visible content first → better UX
- Progressive Rendering 
    Show translations gradually → feels faster