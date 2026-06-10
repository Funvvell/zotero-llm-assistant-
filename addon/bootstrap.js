/* global Zotero, Services */
/**
 * Bootstrap file for LLM Assistant plugin
 * Zotero 7 format: uses { rootURI, id, version } object as first argument
 */

let rootURI;
let windowObserver;

function install(data, reason) {}

async function startup({ id, version, resourceURI, rootURI: rURI }, reason) {
  rootURI = rURI;
  Zotero.debug(`[LLM Assistant] Starting up (id=${id}, version=${version})`);

  // Load modules (rootURI ends with /content/)
  const baseURL = rootURI.endsWith("/") ? rootURI : rootURI + "/";
  const scriptURL = (file) => baseURL + file;
  try {
    Services.scriptloader.loadSubScript(scriptURL("llmClient.js"));
    Services.scriptloader.loadSubScript(scriptURL("promptBuilder.js"));
    Services.scriptloader.loadSubScript(scriptURL("uiManager.js"));
    Services.scriptloader.loadSubScript(scriptURL("traditionalClient.js"));
    Services.scriptloader.loadSubScript(scriptURL("overlay.js"));
  } catch (e) {
    Zotero.logError(`[LLM Assistant] Failed to load scripts: ${e.message}\n${e.stack}`);
  }

  // Wait for the main window to be ready
  if (typeof Zotero.uiReadyPromise !== "undefined") {
    await Zotero.uiReadyPromise;
  }

  // Add menu items and UI to all existing main windows
  const mainWindows = Zotero.getMainWindows();
  for (const win of mainWindows) {
    await onMainWindowLoad(win);
  }

  // Observe new windows
  windowObserver = {
    observe: async function (subject, topic) {
      if (topic === "domwindowopened") {
        // Wait for window load
        const win = subject;
        if (win.document && win.document.documentURI?.includes("chrome://zotero")) {
          try {
            await onMainWindowLoad(win);
          } catch (e) {
            Zotero.logError(`[LLM Assistant] Window load failed: ${e.message}`);
          }
        }
      }
    },
  };
  Services.ww.registerNotification(windowObserver);
}

function shutdown({ id, version, resourceURI, rootURI: rURI }, reason) {
  Zotero.debug(`[LLM Assistant] Shutting down (reason=${reason})`);

  if (reason === APP_SHUTDOWN) return;

  // Unregister window observer
  if (windowObserver) {
    Services.ww.unregisterNotification(windowObserver);
    windowObserver = null;
  }

  // Remove menu items from all windows
  const mainWindows = Zotero.getMainWindows();
  for (const win of mainWindows) {
    onMainWindowUnload(win);
  }

  // Clean up plugin state
  if (typeof Zotero.LLMAssistant !== "undefined") {
    try {
      Zotero.LLMAssistant.destroy();
    } catch (e) {
      Zotero.logError(`[LLM Assistant] Destroy failed: ${e.message}`);
    }
    delete Zotero.LLMAssistant;
  }
}

function uninstall(data, reason) {}

/**
 * Called when the main Zotero window is loaded
 * Inject our menu items into the reader's right-click context menu
 */
async function onMainWindowLoad(win) {
  if (!win || !win.document) return;

  // Wait for document to be ready
  if (win.document.readyState !== "complete") {
    await new Promise((resolve) => {
      win.addEventListener("load", resolve, { once: true });
    });
  }

  // Add reader context menu items
  await addReaderMenuItems(win);

  // Initialize the LLM Assistant plugin (after the first main window is loaded)
  if (typeof Zotero.LLMAssistant !== "undefined" && Zotero.LLMAssistant.init) {
    if (!Zotero.LLMAssistant._initialized) {
      Zotero.LLMAssistant._initialized = true;
      Zotero.LLMAssistant.init();
    }
  }
}

/**
 * Called when the main Zotero window is unloaded
 */
function onMainWindowUnload(win) {
  if (!win || !win.document) return;
  removeReaderMenuItems(win);
}

/**
 * Add right-click context menu items to the PDF reader
 */
async function addReaderMenuItems(win) {
  // The reader context menu is added dynamically when a reader opens.
  // We hook into the reader creation to add our items.
  try {
    const origOpenTab = Zotero.Reader?.openTab || Zotero.Reader?.open;
    if (origOpenTab && !origOpenTab._llmAssistantPatched) {
      // Patch is not needed; we hook into the reader after it loads
    }
  } catch (e) {
    // Ignore
  }

  // Use a MutationObserver to detect when the reader context menu is added
  if (win._llmAssistantMenuObserver) return;

  // Patch the existing popup immediately if already in DOM
  const existingPopup = win.document.getElementById("zotero-reader-itemmenu");
  if (existingPopup) {
    injectReaderMenuItems(existingPopup, win);
  }

  // Observe DOM changes to catch dynamically created reader popups
  const observer = new win.MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType === 1 && node.id === "zotero-reader-itemmenu") {
          injectReaderMenuItems(node, win);
        }
      }
    }
  });
  observer.observe(win.document.documentElement, {
    childList: true,
    subtree: true,
  });
  win._llmAssistantMenuObserver = observer;
}

function removeReaderMenuItems(win) {
  if (win._llmAssistantMenuObserver) {
    win._llmAssistantMenuObserver.disconnect();
    delete win._llmAssistantMenuObserver;
  }
  // Menu items will be removed automatically when the window is destroyed
}

/**
 * Inject our menu items into the reader's right-click context menu
 */
function injectReaderMenuItems(popup, win) {
  if (popup._llmAssistantInjected) return;
  popup._llmAssistantInjected = true;

  const doc = win.document;
  const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";

  // Add separator
  const sep = doc.createElementNS(XUL_NS, "menuseparator");
  popup.appendChild(sep);

  // Create menu items
  const items = [
    {
      id: "zotero-llm-translate-annotate",
      label: "翻译并标注",
      command: "Zotero.LLMAssistant.translateAndAnnotate()",
    },
    {
      id: "zotero-llm-explain-selection",
      label: "解释选中文本",
      command: "Zotero.LLMAssistant.explainSelection()",
    },
    {
      id: "zotero-llm-translate-selection",
      label: "翻译选中文本",
      command: "Zotero.LLMAssistant.translateSelection()",
    },
  ];

  for (const itemDef of items) {
    const item = doc.createElementNS(XUL_NS, "menuitem");
    item.setAttribute("id", itemDef.id);
    item.setAttribute("label", itemDef.label);
    item.setAttribute("oncommand", itemDef.command);
    popup.appendChild(item);
  }
}
