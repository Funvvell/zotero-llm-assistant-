// Simulate Zotero 7 environment to test bootstrap.js and modules
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// Mock globals similar to Zotero
const mockWindow = {
  document: {
    documentElement: "mockDocElement",
    readyState: "complete",
    getElementById: (id) => {
      if (id === "zotero-reader-itemmenu") {
        return null; // Not in DOM initially
      }
      return null;
    },
    createElementNS: (ns, tag) => {
      const elem = {
        namespaceURI: ns,
        tagName: tag,
        attributes: {},
        children: [],
        _llmAssistantInjected: false,
        setAttribute(k, v) { this.attributes[k] = v; },
        getAttribute(k) { return this.attributes[k]; },
        appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
        addEventListener() {},
        addEventListener() {},
      };
      return elem;
    },
    addEventListener() {},
    removeStyleSheet() {},
    createProcessingInstruction() {},
  },
  MutationObserver: class {
    constructor(cb) { this.cb = cb; }
    observe() {}
    disconnect() {}
  },
  addEventListener() {},
  innerWidth: 1920,
  innerHeight: 1080,
  Zotero_Tabs: { selectedID: "test-tab" },
  documentURI: "chrome://zotero/content/zoteroPane.xhtml",
};

const mockZotero = {
  debug: (msg) => console.log("[Zotero.debug]", msg),
  logError: (msg) => console.log("[Zotero.logError]", msg),
  getMainWindows: () => [mockWindow],
  getMainWindow: () => mockWindow,
  getActiveZoteroPane: () => ({
    getSelectedItems: () => [],
  }),
  Promise: {
    all: async (promises) => Promise.all(promises),
    resolve: (v) => Promise.resolve(v),
  },
  mainWindow: {
    io: { filePickerDeferred: Promise.resolve() },
  },
  uiReadyPromise: Promise.resolve(),
  PdfWorker: {
    getFullText: async () => "test content",
  },
  Prefs: {
    get: (key, useScope) => {
      const config = {
        "api-endpoint": "https://api.openai.com/v1",
        "api-key": "test-key",
        "model": "gpt-4o",
        "max-tokens": 2048,
        "temperature": 0.7,
        "language": "Chinese",
      };
      const k = key.replace("extensions.zotero-llm-assistant.", "");
      return config[k];
    },
  },
  Reader: {
    getByTabID: () => ({
      getSelectedText: () => "test",
    }),
  },
};

// Base directory for resolving script files at plugin root
const ADDON_DIR = path.join(__dirname, "..", "addon");

const mockServices = {
  scriptloader: {
    loadSubScript: (scriptPath) => {
      // scriptPath is something like "chrome://zotero-llm-assistant/llmClient.js"
      // Extract the last segment and look in ADDON_DIR
      const match = scriptPath.match(/[^/]+$/);
      if (!match) {
        console.error("[Services.scriptloader] invalid path:", scriptPath);
        return;
      }
      const filePath = path.join(ADDON_DIR, match[0]);
      if (!fs.existsSync(filePath)) {
        console.error("[Services.scriptloader] file not found:", filePath);
        return;
      }
      const code = fs.readFileSync(filePath, "utf-8");
      try {
        vm.runInContext(code, sandbox);
        console.log("[Services.scriptloader] loaded:", scriptPath);
      } catch (e) {
        console.error("[Services.scriptloader] load failed:", scriptPath, e.message);
        console.error(e.stack);
      }
    },
  },
  io: {
    newURI: (path) => path,
  },
  ww: {
    registerNotification: (obs) => { mockZotero._wwObserver = obs; console.log("[Services.ww] observer registered"); },
    unregisterNotification: () => { console.log("[Services.ww] observer unregistered"); },
  },
};

// Build a sandbox
const sandbox = {
  Zotero: mockZotero,
  Services: mockServices,
  window: mockWindow,
  console,
  setTimeout,
  clearTimeout,
  Components: {
    classes: {
      "@mozilla.org/embedcomp/prompt-service;1": {
        getService: () => ({
          prompt: () => false,
          confirm: () => false,
        }),
      },
      "@mozilla.org/widget/clipboardhelper;1": {
        getService: () => ({
          copyString: (s) => console.log("[clipboard] copied:", s.substring(0, 50)),
        }),
      },
    },
    interfaces: {
      nsIPromptService: {},
      nsIClipboardHelper: {},
    },
  },
  XMLHttpRequest: class {
    open() {}
    setRequestHeader() {}
    send() {}
  },
  APP_SHUTDOWN: 2,
  XPCOMUtils: { generateQI: () => {} },
  Promise,
  Array,
  Object,
  Math,
  Date,
  JSON,
  Number,
  String,
  Boolean,
  RegExp,
  Error,
  Function,
};
sandbox.global = sandbox;
sandbox.globalThis = sandbox;

vm.createContext(sandbox);

// Load and execute bootstrap.js
console.log("=== Loading bootstrap.js ===");
// Resolve bootstrap.js relative to this script (works regardless of checkout dir)
const bootstrapPath = path.join(__dirname, "..", "addon", "bootstrap.js");
if (!fs.existsSync(bootstrapPath)) {
  console.error("✗ bootstrap.js not found at:", bootstrapPath);
  process.exit(1);
}
const bootstrapCode = fs.readFileSync(bootstrapPath, "utf-8");
try {
  vm.runInContext(bootstrapCode, sandbox);
  console.log("✓ bootstrap.js loaded");
} catch (e) {
  console.error("✗ bootstrap.js load failed:", e.message);
  process.exit(1);
}

// Run startup
console.log("\n=== Running startup() ===");
const data = {
  id: "llm-assistant@example.com",
  version: "1.0.0",
  resourceURI: { spec: "resource://llm-assistant/" },
  rootURI: "chrome://zotero-llm-assistant/",
};

(async () => {
  try {
    await sandbox.startup(data, 1);
    console.log("✓ startup() completed");

    // Verify Zotero.LLMAssistant was created
    if (sandbox.Zotero.LLMAssistant) {
      console.log("\n=== Verifying Zotero.LLMAssistant ===");
      const expectedMethods = [
        "init", "destroy", "summarizeSelected", "translateSelected",
        "askAboutSelected", "extractKeywords", "generateTags",
        "explainSelection", "translateSelection", "translateAndAnnotate"
      ];
      for (const m of expectedMethods) {
        if (typeof sandbox.Zotero.LLMAssistant[m] === "function") {
          console.log(`  ✓ ${m}()`);
        } else {
          console.log(`  ✗ ${m}() missing`);
        }
      }
    } else {
      console.error("✗ Zotero.LLMAssistant is not defined");
    }

    // Verify submodules
    console.log("\n=== Verifying submodules ===");
    for (const m of ["LLMClient", "PromptBuilder", "UIManager"]) {
      if (sandbox.Zotero.LLMAssistant[m]) {
        console.log(`  ✓ Zotero.LLMAssistant.${m}`);
      } else {
        console.log(`  ✗ Zotero.LLMAssistant.${m} missing`);
      }
    }

    // Test translateAndAnnotate with mock data
    console.log("\n=== Testing translateAndAnnotate() (without LLM) ===");
    // We can't actually call LLM, but check the function exists and is callable
    if (typeof sandbox.Zotero.LLMAssistant.translateAndAnnotate === "function") {
      console.log("  ✓ translateAndAnnotate is callable");
    }

    // Cleanup
    console.log("\n=== Running shutdown() ===");
    sandbox.shutdown(data, 1);
    console.log("✓ shutdown() completed");
  } catch (e) {
    console.error("✗ Error:", e.message, "\n", e.stack);
    process.exit(1);
  }
})();
