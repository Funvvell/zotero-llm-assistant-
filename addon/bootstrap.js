/* global Zotero, Services, Components, APP_SHUTDOWN */
/**
 * Bootstrap file for LLM Assistant plugin.
 * Zotero 7/8/9 bootstrapped extension.
 *
 * Architecture learned from zotero-pdf-translate (windingwind):
 *   - Chrome registration via amIAddonManagerStartup.registerChrome()
 *     so that chrome://llm-assistant/content/... resolves to our chrome/content/ dir
 *   - onMainWindowLoad / onMainWindowUnload top-level lifecycle hooks
 *     (Zotero calls these automatically for each main window)
 *   - Triple-promise wait (initializationPromise + unlockPromise + uiReadyPromise)
 *   - Clean shutdown with APP_SHUTDOWN early-return
 *
 * Directory layout (flat, no chrome.manifest):
 *   addon/
 *     manifest.json
 *     bootstrap.js
 *     prefs.js
 *     preferences.xhtml
 *     preferences.js
 *     llmClient.js, promptBuilder.js, uiManager.js, traditionalClient.js, overlay.js
 *     chrome/content/icons/icon@48.png, icon@96.png, ...
 */

var chromeHandle;

const ADDON_ID = "llm-assistant@example.com";
const ADDON_REF = "llm-assistant";
const PREF_PREFIX = "extensions.zotero-llm-assistant.";

let rootURI;
let _prefsPaneID = null;
let _readerTabObserver = null;
let _windowObserver = null;

// ── Lifecycle ─────────────────────────────────────────────────────────

function install(data, reason) {}

async function startup({ id, version, resourceURI, rootURI: rURI }, reason) {
  rootURI = rURI;
  if (!rootURI) {
    rootURI = resourceURI.spec;
  }
  const base = rootURI.endsWith("/") ? rootURI : rootURI + "/";

  Zotero.debug(`[LLM Assistant] Starting up (id=${id}, v${version})`);
  Zotero.debug(`[LLM Assistant] rootURI=${rootURI}`);

  // Wait for Zotero core to be ready
  await Zotero.initializationPromise;

  // ── Chrome registration ──
  // This maps chrome://llm-assistant/content/... → rootURI/chrome/content/...
  // Critical for icon display in the Add-on Manager and for XUL/XHTML loading.
  try {
    const aomStartup = Components.classes[
      "@mozilla.org/addons/addon-manager-startup;1"
    ].getService(Components.interfaces.amIAddonManagerStartup);
    const manifestURI = Services.io.newURI(rootURI + "manifest.json");
    chromeHandle = aomStartup.registerChrome(manifestURI, [
      ["content", ADDON_REF, rootURI + "chrome/content/"],
    ]);
    Zotero.debug(`[LLM Assistant] Chrome registered: chrome://${ADDON_REF}/content/`);
  } catch (e) {
    Zotero.logError(`[LLM Assistant] Chrome registration failed: ${e.message}`);
  }

  // ── Load modules into global scope ──
  const modules = [
    "llmClient.js",
    "promptBuilder.js",
    "uiManager.js",
    "traditionalClient.js",
    "overlay.js",
    "preferences.js",
  ];
  for (const m of modules) {
    try {
      Services.scriptloader.loadSubScript(base + m);
    } catch (e) {
      Zotero.logError(`[LLM Assistant] Failed to load ${m}: ${e.message}\n${e.stack}`);
    }
  }

  // ── Register preferences pane ──
  if (Zotero.PreferencePanes && typeof Zotero.PreferencePanes.register === "function") {
    try {
      _prefsPaneID = await Zotero.PreferencePanes.register({
        pluginID: ADDON_ID,
        src: base + "preferences.xhtml",
        label: "LLM Assistant",
      });
      Zotero.debug(`[LLM Assistant] Preferences pane registered (id=${_prefsPaneID})`);
    } catch (e) {
      Zotero.logError(`[LLM Assistant] PreferencePanes.register failed: ${e.message}\n${e.stack}`);
    }
  } else {
    Zotero.logError("[LLM Assistant] PreferencePanes not available; Settings will be missing");
  }

  // ── Wait for full UI readiness (triple-promise pattern) ──
  try {
    await Promise.all([
      Zotero.initializationPromise,
      Zotero.unlockPromise,
      Zotero.uiReadyPromise,
    ]);
  } catch (e) {
    Zotero.logError(`[LLM Assistant] Startup promises failed: ${e.message}`);
  }

  // ── Register PDF reader text-selection popup ──
  if (Zotero.Reader && typeof Zotero.Reader.registerEventListener === "function") {
    try {
      Zotero.Reader.registerEventListener(
        "renderTextSelectionPopup",
        onRenderTextSelectionPopup,
        ADDON_ID
      );
      Zotero.debug("[LLM Assistant] renderTextSelectionPopup listener registered");
    } catch (e) {
      Zotero.logError(`[LLM Assistant] registerEventListener failed: ${e.message}`);
    }
  }

  // ── Set up reader tab observer for auto-read ──
  _setupReaderObserver();

  // ── Non-blocking LLM connection health check ──
  _checkLLMConnection();
}

async function onMainWindowLoad({ window: win }, reason) {
  if (!win || !win.document) return;

  // Wait for document to be fully loaded
  if (win.document.readyState !== "complete") {
    await new Promise((resolve) => {
      win.addEventListener("load", resolve, { once: true });
    });
  }

  // Wait for Zotero to be fully ready
  try {
    await Promise.all([
      Zotero.initializationPromise,
      Zotero.unlockPromise,
      Zotero.uiReadyPromise,
    ]);
  } catch { /* ignore */ }

  // Add context menu items
  _addMainWindowMenuItems(win);

  // Initialize the plugin (singleton guard)
  if (typeof Zotero.LLMAssistant !== "undefined" && Zotero.LLMAssistant.init) {
    if (!Zotero.LLMAssistant._initialized) {
      Zotero.LLMAssistant._initialized = true;
      try {
        Zotero.LLMAssistant.init();
      } catch (e) {
        Zotero.logError(`[LLM Assistant] init failed: ${e.message}`);
      }
    }
  }
}

async function onMainWindowUnload({ window: win }, reason) {
  if (!win || !win.document) return;
  _removeMainWindowMenuItems(win);
}

function shutdown({ id, version, resourceURI, rootURI: rURI }, reason) {
  Zotero.debug(`[LLM Assistant] Shutting down (reason=${reason})`);

  if (reason === APP_SHUTDOWN) return;

  // Unregister preferences pane
  if (_prefsPaneID && Zotero.PreferencePanes && typeof Zotero.PreferencePanes.unregister === "function") {
    try { Zotero.PreferencePanes.unregister(_prefsPaneID); }
    catch (e) { Zotero.debug(`[LLM Assistant] prefs unregister failed: ${e.message}`); }
    _prefsPaneID = null;
  }

  // Disconnect reader tab observer
  if (_readerTabObserver) {
    try { _readerTabObserver.disconnect(); }
    catch (e) { /* ignore */ }
    _readerTabObserver = null;
  }

  // Remove menu items from all windows
  try {
    const mainWindows = Zotero.getMainWindows();
    for (const win of mainWindows) {
      _removeMainWindowMenuItems(win);
    }
  } catch (e) {
    Zotero.logError(`[LLM Assistant] Window unload failed: ${e.message}`);
  }

  // Clean up plugin state
  if (typeof Zotero.LLMAssistant !== "undefined") {
    try { Zotero.LLMAssistant.destroy(); }
    catch (e) { Zotero.logError(`[LLM Assistant] Destroy failed: ${e.message}`); }
    delete Zotero.LLMAssistant;
  }

  // Flush locale caches
  try {
    Components.classes["@mozilla.org/intl/stringbundle;1"]
      .getService(Components.interfaces.nsIStringBundleService)
      .flushBundles();
  } catch { /* ignore */ }

  // Destruct chrome registration
  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}

function uninstall(data, reason) {}

// ── Private helpers ───────────────────────────────────────────────────

/**
 * Watch for new reader tabs so we can auto-summarize each PDF on first open.
 */
function _setupReaderObserver() {
  const win = Zotero.getMainWindow();
  if (!win || !win.document) return;

  const tabBar = win.document.getElementById("zotero-tab-bar");
  if (!tabBar) {
    Zotero.debug("[LLM Assistant] tab bar not found; auto-read disabled");
    return;
  }

  _readerTabObserver = new win.MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue;
        const tabEl = node.classList?.contains("zotero-tab")
          ? node
          : node.querySelector?.(".zotero-tab");
        if (!tabEl) continue;

        const tabID = tabEl.getAttribute("data-tab-id") || tabEl.dataset?.tabId;
        if (!tabID) continue;

        try {
          const reader = Zotero.Reader.getByTabID(tabID);
          if (reader && Zotero.LLMAssistant?.autoReadPDF) {
            Zotero.debug(`[LLM Assistant] New reader tab: tabID=${tabID}`);
            // Use requestIdleCallback to avoid blocking during tab creation
            const idleCb = win.requestIdleCallback || ((fn) => setTimeout(fn, 1000));
            idleCb(() => Zotero.LLMAssistant.autoReadPDF(reader));
          }
        } catch (e) {
          Zotero.debug(`[LLM Assistant] reader tab check failed: ${e.message}`);
        }
      }
    }
  });

  _readerTabObserver.observe(tabBar, { childList: true, subtree: true });
  Zotero.debug("[LLM Assistant] Reader tab observer installed");
}

/**
 * Non-blocking health check: verify the LLM API is reachable.
 */
async function _checkLLMConnection() {
  try {
    await new Promise((r) => setTimeout(r, 3000));

    if (!Zotero.LLMAssistant?.LLMClient) {
      Zotero.debug("[LLM Assistant] Connection check: LLMClient not available");
      return;
    }

    const apiKey = Zotero.Prefs.get(PREF_PREFIX + "api-key", true);
    if (!apiKey) {
      Zotero.debug("[LLM Assistant] No API key configured, skipping connection check");
      return;
    }

    Zotero.debug("[LLM Assistant] Checking LLM API connection...");
    const result = await Zotero.LLMAssistant.LLMClient.testConnection();
    if (result.success) {
      Zotero.debug(`[LLM Assistant] LLM API OK: ${result.message}`);
    } else {
      Zotero.logError(`[LLM Assistant] LLM API FAILED: ${result.message}`);
    }
  } catch (e) {
    Zotero.debug(`[LLM Assistant] Connection check error: ${e.message}`);
  }
}

/**
 * Add library-item right-click menu items to the main Zotero window.
 */
function _addMainWindowMenuItems(win) {
  if (!win || !win.document || win._llmAssistantMenuObserver) return;

  const inject = () => {
    const popup = win.document.getElementById("zotero-itemmenu");
    if (popup && !popup._llmAssistantInjected) {
      popup._llmAssistantInjected = true;
      const doc = win.document;

      const sep = doc.createXULElement("menuseparator");
      popup.appendChild(sep);

      const items = [
        { id: "zotero-llm-summarize",         label: "总结条目",     cmd: "Zotero.LLMAssistant.summarizeSelected()" },
        { id: "zotero-llm-translate",          label: "翻译选中文本", cmd: "Zotero.LLMAssistant.translateSelection()" },
        { id: "zotero-llm-translate-annotate", label: "翻译并标注",   cmd: "Zotero.LLMAssistant.translateAndAnnotate()" },
        { id: "zotero-llm-explain",            label: "解释选中文本", cmd: "Zotero.LLMAssistant.explainSelection()" },
      ];

      for (const def of items) {
        const item = doc.createXULElement("menuitem");
        item.setAttribute("id", def.id);
        item.setAttribute("label", def.label);
        item.setAttribute("oncommand", def.cmd);
        popup.appendChild(item);
      }
    }
  };

  inject();

  const observer = new win.MutationObserver(() => inject());
  observer.observe(win.document.documentElement, { childList: true, subtree: true });
  win._llmAssistantMenuObserver = observer;
}

function _removeMainWindowMenuItems(win) {
  if (win._llmAssistantMenuObserver) {
    try { win._llmAssistantMenuObserver.disconnect(); }
    catch (e) { /* ignore */ }
    delete win._llmAssistantMenuObserver;
  }
}

/**
 * Reader popup: invoked by Zotero.Reader when text is selected in a PDF.
 * Delegates to overlay.js which handles caching + auto-translation.
 */
function onRenderTextSelectionPopup(event) {
  if (Zotero.LLMAssistant?.onTextSelected) {
    Zotero.LLMAssistant.onTextSelected(event);
  }
}
