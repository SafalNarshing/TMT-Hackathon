// ── Constants ──────────────────────────────────────────────
const API_URL = "https://tmt.ilprl.ku.edu.np/lang-translate";

const LANG_NAMES = {
  en:  "English",
  ne:  "Nepali",
  tmg: "Tamang"
};

// ── DOM References ──────────────────────────────────────────
const settingsBtn      = document.getElementById("settingsBtn");
const settingsModal    = document.getElementById("settingsModal");
const settingsClose    = document.getElementById("settingsClose");
const apiKeyInput      = document.getElementById("apiKeySettings");
const saveKeyBtn       = document.getElementById("saveKeySettings");
const keyStatus        = document.getElementById("keyStatusSettings");
const togglePassword   = document.getElementById("togglePassword");
const srcLangSel       = document.getElementById("srcLang");
const tgtLangSel       = document.getElementById("tgtLang");
const swapLangBtn      = document.getElementById("swapLang");
const inputText        = document.getElementById("inputText");
const translateBtn     = document.getElementById("translateBtn");
const clearBtn         = document.getElementById("clearBtn");
const outputBox        = document.getElementById("outputBox");
const outputMeta       = document.getElementById("outputMeta");
const copyBtn          = document.getElementById("copyBtn");
const translatePageBtn = document.getElementById("translatePageBtn");
const pageStatus       = document.getElementById("pageStatus");
const translateSelectedBtn = document.getElementById("translateSelectedBtn");
const selectedOutputBox = document.getElementById("selectedOutputBox");
const selectedOutputMeta = document.getElementById("selectedOutputMeta");
const copySelectedBtn = document.getElementById("copySelectedBtn");
const selectedStatus = document.getElementById("selectedStatus");

// Tab navigation
const tabBtns = document.querySelectorAll(".tab-btn");
const tabContents = document.querySelectorAll(".tab-content");
const themeToggleBtn = document.getElementById("themeToggle");
const themeIcon = document.getElementById("themeIcon");

// ── Theme Toggle ────────────────────────────────────────────
function setTheme(theme) {
  if (theme === "light") {
    document.body.classList.add("light-theme");
    themeIcon.innerHTML = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>';
    themeToggleBtn.title = "Switch to Dark Theme";
  } else {
    document.body.classList.remove("light-theme");
    themeIcon.innerHTML = '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>';
    themeToggleBtn.title = "Switch to Light Theme";
  }
  chrome.storage.local.set({ theme });
}

themeToggleBtn.addEventListener("click", () => {
  const currentTheme = document.body.classList.contains("light-theme") ? "light" : "dark";
  const newTheme = currentTheme === "light" ? "dark" : "light";
  setTheme(newTheme);
});

// Load saved theme on startup
chrome.storage.local.get("theme", (data) => {
  const theme = data.theme || "dark";
  setTheme(theme);
});

// ── Helper: Get API key from background service worker ────
async function getApiKeyFromBackground() {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: "getApiKey" }, (response) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError.message);
      } else if (response && response.apiKey) {
        resolve(response.apiKey);
      } else {
        reject("No API key set. Please set one in Settings.");
      }
    });
  });
}

// ── On Load: restore saved settings ────────────────────────
chrome.storage.local.get(["apiKey", "srcLang", "tgtLang"], (data) => {
  if (data.apiKey) {
    apiKeyInput.value = data.apiKey;
    keyStatus.textContent = "✓ API key loaded";
    keyStatus.className = "key-status ok";
  }
  if (data.srcLang) srcLangSel.value = data.srcLang;
  if (data.tgtLang) tgtLangSel.value = data.tgtLang;
});

// ── Settings Modal ──────────────────────────────────────────
settingsBtn.addEventListener("click", () => {
  settingsModal.classList.add("active");
});

settingsClose.addEventListener("click", () => {
  settingsModal.classList.remove("active");
});

// Close modal when clicking outside
settingsModal.addEventListener("click", (e) => {
  if (e.target === settingsModal) {
    settingsModal.classList.remove("active");
  }
});

// ── Tab Navigation ──────────────────────────────────────────
tabBtns.forEach(btn => {
  btn.addEventListener("click", () => {
    const tabName = btn.getAttribute("data-tab");
    
    // Remove active class from all buttons and contents
    tabBtns.forEach(b => b.classList.remove("active"));
    tabContents.forEach(c => c.classList.remove("active"));
    
    // Add active class to clicked button and corresponding content
    btn.classList.add("active");
    document.getElementById(`tab-${tabName}`).classList.add("active");
    
    // Save preference
    chrome.storage.local.set({ activeTab: tabName });
  });
});

// Restore active tab on load
chrome.storage.local.get("activeTab", (data) => {
  if (data.activeTab) {
    const btn = document.querySelector(`[data-tab="${data.activeTab}"]`);
    if (btn) btn.click();
  }
});

// ── Toggle API Key Visibility ──────────────────────────────
togglePassword.addEventListener("click", () => {
  const isPassword = apiKeyInput.type === "password";
  apiKeyInput.type = isPassword ? "text" : "password";
  const eyeIcon = document.getElementById("eyeIcon");
  
  if (isPassword) {
    // Show password - show crossed eye
    eyeIcon.innerHTML = '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>';
  } else {
    // Hide password - show open eye
    eyeIcon.innerHTML = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
  }
});
// ── Save API Key ────────────────────────────────────────────
saveKeyBtn.addEventListener("click", () => {
  const key = apiKeyInput.value.trim();
  if (!key.startsWith("team_")) {
    keyStatus.textContent = "✗ Key should start with 'team_'";
    keyStatus.className = "key-status err";
    return;
  }
  chrome.storage.local.set({ apiKey: key }, () => {
    keyStatus.textContent = "✓ API key saved securely";
    keyStatus.className = "key-status ok";
  });
});

// ── Swap Languages ──────────────────────────────────────────
swapLangBtn.addEventListener("click", () => {
  const tmp = srcLangSel.value;
  srcLangSel.value = tgtLangSel.value;
  tgtLangSel.value = tmp;
  saveLanguages();
});

// ── Save language preference on change ──────────────────────
srcLangSel.addEventListener("change", saveLanguages);
tgtLangSel.addEventListener("change", saveLanguages);

function saveLanguages() {
  chrome.storage.local.set({
    srcLang: srcLangSel.value,
    tgtLang: tgtLangSel.value
  });
}

// ── Save language preference on change ─────────────────────
// ── Save language preference on change ────────────────────────────
function saveLanguages() {
  chrome.storage.local.set({
    srcLang: srcLangSel.value,
    tgtLang: tgtLangSel.value
  });
}

// ── Core translate function ─────────────────────────────────
async function translateText(text, srcLang, tgtLang, apiKey) {
  if (srcLang === tgtLang) {
    throw new Error("Source and target languages must be different.");
  }

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      text: text,
      src_lang: srcLang,
      tgt_lang: tgtLang
    })
  });

  const data = await response.json();

  // API always returns HTTP 200 — check message_type
  if (data.message_type === "SUCCESS") {
    return data;
  } else {
    throw new Error(data.message || "Translation failed.");
  }
}

// ── Translate Button ────────────────────────────────────────
translateBtn.addEventListener("click", async () => {
  const text = inputText.value.trim();
  if (!text) return;

  let apiKey;
  try {
    apiKey = await getApiKeyFromBackground();
  } catch (err) {
    outputBox.textContent = `Error: ${err}`;
    outputBox.className = "output-box error";
    return;
  }

  const src = srcLangSel.value;
  const tgt = tgtLangSel.value;

  if (src === tgt) {
    outputBox.textContent = "Source and target languages cannot be the same.";
    outputBox.className = "output-box error";
    return;
  }

  // Loading state
  outputBox.textContent = "Translating…";
  outputBox.className = "output-box loading";
  outputMeta.textContent = "";
  copyBtn.style.display = "none";
  translateBtn.disabled = true;
  translateBtn.textContent = "Translating…";

  try {
    const result = await translateText(text, src, tgt, apiKey);
    outputBox.textContent = result.output;
    outputBox.className = "output-box";
    outputMeta.innerHTML = `
      <span>${LANG_NAMES[src]} → ${LANG_NAMES[tgt]}</span>
      <span>${new Date(result.timestamp).toLocaleTimeString()}</span>
    `;
    copyBtn.style.display = "block";
  } catch (err) {
    outputBox.textContent = `Error: ${err.message}`;
    outputBox.className = "output-box error";
  } finally {
    translateBtn.disabled = false;
    translateBtn.textContent = "Translate";
  }
});

// ── Clear Button ────────────────────────────────────────────
clearBtn.addEventListener("click", () => {
  inputText.value = "";
  outputBox.textContent = "Translation will appear here.";
  outputBox.className = "output-box";
  outputMeta.textContent = "";
  copyBtn.style.display = "none";
});

// ── Copy Output ─────────────────────────────────────────────
copyBtn.addEventListener("click", () => {
  navigator.clipboard.writeText(outputBox.textContent).then(() => {
    copyBtn.textContent = "Copied!";
    setTimeout(() => { copyBtn.textContent = "Copy Translation"; }, 1500);
  });
});

// ── Translate Entire Page ───────────────────────────────────
translatePageBtn.addEventListener("click", async () => {
  let apiKey;
  try {
    apiKey = await getApiKeyFromBackground();
  } catch (err) {
    pageStatus.textContent = `Error: ${err}`;
    pageStatus.style.color = "var(--error)";
    return;
  }

  const src = srcLangSel.value;
  const tgt = tgtLangSel.value;

  if (src === tgt) {
    pageStatus.textContent = "Source and target languages cannot be the same.";
    pageStatus.style.color = "var(--error)";
    return;
  }

  translatePageBtn.disabled = true;
  translatePageBtn.textContent = "⏳ Translating page…";
  pageStatus.textContent = "Sending to content script…";
  pageStatus.style.color = "var(--muted)";

  // Send message to content.js
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    chrome.tabs.sendMessage(tabs[0].id, {
      action: "translatePage",
      apiKey,
      srcLang: src,
      tgtLang: tgt
    }, (response) => {
      if (chrome.runtime.lastError) {
        pageStatus.textContent = "Could not reach page. Try refreshing.";
        pageStatus.style.color = "var(--error)";
      } else if (response && response.status === "started") {
        pageStatus.textContent = `Translating ${response.count} text nodes…`;
        pageStatus.style.color = "var(--muted)";
      }
      translatePageBtn.disabled = false;
      translatePageBtn.textContent = "🌐 Translate Page";
    });
  });
});

// ── Copy Selected Output ────────────────────────────────────
copySelectedBtn.addEventListener("click", () => {
  navigator.clipboard.writeText(selectedOutputBox.textContent).then(() => {
    copySelectedBtn.textContent = "Copied!";
    setTimeout(() => { copySelectedBtn.textContent = "Copy Translation"; }, 1500);
  });
});

// ── Translate Selected Text ─────────────────────────────────
translateSelectedBtn.addEventListener("click", async () => {
  selectedStatus.textContent = "Getting selected text from page…";
  selectedStatus.style.color = "var(--muted)";
  selectedOutputBox.textContent = "";
  selectedOutputMeta.textContent = "";
  copySelectedBtn.style.display = "none";

  // Get the currently active tab
  chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
    try {
      // Execute script to get selected text
      const results = await chrome.scripting.executeScript({
        target: { tabId: tabs[0].id },
        func: () => window.getSelection().toString()
      });
      
      const selectedText = results && results[0] && results[0].result ? results[0].result.trim() : "";
      
      if (!selectedText) {
        selectedStatus.textContent = "No text selected on the page. Please select text first.";
        selectedStatus.style.color = "var(--error)";
        return;
      }

      let apiKey;
      try {
        apiKey = await getApiKeyFromBackground();
      } catch (err) {
        selectedStatus.textContent = `Error: ${err}`;
        selectedStatus.style.color = "var(--error)";
        return;
      }

      const src = srcLangSel.value;
      const tgt = tgtLangSel.value;

      if (src === tgt) {
        selectedStatus.textContent = "Source and target languages cannot be the same.";
        selectedStatus.style.color = "var(--error)";
        return;
      }

      selectedStatus.textContent = "Translating…";
      
      try {
        const result = await translateText(selectedText, src, tgt, apiKey);
        selectedOutputBox.textContent = result.output;
        selectedOutputBox.className = "output-box";
        selectedOutputMeta.innerHTML = `
          <span>${LANG_NAMES[src]} → ${LANG_NAMES[tgt]}</span>
          <span>${new Date(result.timestamp).toLocaleTimeString()}</span>
        `;
        copySelectedBtn.style.display = "block";
        selectedStatus.textContent = "✓ Translation complete";
        selectedStatus.style.color = "var(--success)";
      } catch (err) {
        selectedStatus.textContent = `Error: ${err.message}`;
        selectedStatus.style.color = "var(--error)";
      }
    } catch (err) {
      selectedStatus.textContent = "Could not access selected text. Try refreshing the page.";
      selectedStatus.style.color = "var(--error)";
    }
  });
});
