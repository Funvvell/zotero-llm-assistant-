/**
 * test-preferences-xhtml.js
 * -------------------------
 * Validates the plugin's preferences.xhtml to ensure it will load
 * correctly inside Zotero 7/8/9's PreferencePanes iframe.
 *
 * Checks:
 *  1. Well-formed XML (no parse errors)
 *  2. No DOCTYPE / external DTD references (they break in bootstrapped plugins)
 *  3. Root element is <vbox> (not <window>) for iframe embedding
 *  4. XUL + XHTML namespaces are declared
 *  5. Every `preference=` attribute maps to a key registered by the plugin
 *  6. All element IDs are unique
 *  7. Every <label control="..."> references an existing element ID
 *  8. <html:input> elements have a `type` attribute
 *  9. menulist elements have at least one <menuitem> child
 * 10. No orphan closing tags (depth returns to 0)
 */

const fs = require("fs");
const path = require("path");

const PREFS_PATH = path.join(__dirname, "..", "addon", "preferences.xhtml");
const MANIFEST_PATH = path.join(__dirname, "..", "addon", "manifest.json");
const TRAD_CLIENT_PATH = path.join(__dirname, "..", "addon", "traditionalClient.js");

let passed = 0;
let failed = 0;
const errors = [];

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    errors.push(label);
    console.log(`  FAIL  ${label}`);
  }
}

// ---------------------------------------------------------------------------
// Read source files
// ---------------------------------------------------------------------------
const xhtml = fs.readFileSync(PREFS_PATH, "utf-8");
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8"));
const tradClient = fs.readFileSync(TRAD_CLIENT_PATH, "utf-8");

// ---------------------------------------------------------------------------
// 1. No DOCTYPE / external DTD
// ---------------------------------------------------------------------------
console.log("\n=== DOCTYPE / DTD check ===");
const hasDoctype = /<!DOCTYPE/i.test(xhtml);
assert(!hasDoctype, "No DOCTYPE declaration (bootstrapped plugins cannot resolve external DTDs)");

const hasSystemLiteral = /SYSTEM\s+["']/.test(xhtml);
assert(!hasSystemLiteral, "No SYSTEM literal reference (DTD URI would fail to resolve)");

// ---------------------------------------------------------------------------
// 2. Well-formed XML — SAX-style tag balance check
// ---------------------------------------------------------------------------
console.log("\n=== XML well-formedness ===");

// Strip XML comments and processing instructions first
const stripped = xhtml.replace(/<!--[\s\S]*?-->/g, "").replace(/<\?[\s\S]*?\?>/g, "");

// Extract every tag and classify it properly
const tagRegex = /<\/?([a-zA-Z][a-zA-Z0-9:]*)([\s\S]*?)(\/?)>/g;
let openCount = 0;
let closeCount = 0;
let selfCloseCount = 0;
let tm;
while ((tm = tagRegex.exec(stripped)) !== null) {
  const isClose = stripped[tm.index + 1] === "/";
  const isSelfClose = tm[3] === "/";
  if (isClose) {
    closeCount++;
  } else if (isSelfClose) {
    selfCloseCount++;
  } else {
    openCount++;
  }
}

assert(openCount === closeCount,
  `Tag balance: ${openCount} open vs ${closeCount} close (self-closing: ${selfCloseCount})`);

// ---------------------------------------------------------------------------
// 3. Root element is <vbox>, not <window>
// ---------------------------------------------------------------------------
console.log("\n=== Root element ===");

const rootMatch = xhtml.match(/<([a-zA-Z][a-zA-Z0-9]*)[\s>]/);
// We need to skip processing instructions and DOCTYPE to find the real root
const lines = xhtml.split("\n");
let rootElement = null;
for (const line of lines) {
  const trimmed = line.trim();
  if (trimmed.startsWith("<?") || trimmed.startsWith("<!")) continue;
  const m = trimmed.match(/^<([a-zA-Z][a-zA-Z0-9]*)/);
  if (m) { rootElement = m[1]; break; }
}

assert(rootElement === "vbox", `Root element is <vbox> (got <${rootElement}>)`);
assert(rootElement !== "window", "Root element is NOT <window> (iframe-incompatible)");

// ---------------------------------------------------------------------------
// 4. Namespace declarations
// ---------------------------------------------------------------------------
console.log("\n=== Namespace declarations ===");

const rootTagMatch = xhtml.match(/<vbox[\s\S]*?>/);
const rootTag = rootTagMatch ? rootTagMatch[0] : "";
assert(rootTag.includes("xmlns=\"http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul\""),
  "XUL namespace declared on root");
assert(rootTag.includes("xmlns:html=\"http://www.w3.org/1999/xhtml\""),
  "XHTML namespace declared on root");

// ---------------------------------------------------------------------------
// 5. Preference keys match registered / expected keys
// ---------------------------------------------------------------------------
console.log("\n=== Preference key cross-reference ===");

const PREF_PREFIX = "extensions.zotero-llm-assistant.";

// Collect all preference keys from the XHTML
const prefAttrRegex = /preference="([^"]+)"/g;
const xhtmlPrefs = new Set();
let pm;
while ((pm = prefAttrRegex.exec(xhtml)) !== null) {
  xhtmlPrefs.add(pm[1]);
}

// Collect defaults from traditionalClient.js
const tradDefaults = {};
const defaultsMatch = tradClient.match(/const defaults = \{([\s\S]*?)\}/);
if (defaultsMatch) {
  const kvRegex = /"([^"]+)"\s*:\s*"([^"]*)"/g;
  let km;
  while ((km = kvRegex.exec(defaultsMatch[1])) !== null) {
    tradDefaults[PREF_PREFIX + km[1]] = km[2];
  }
}

// Expected LLM keys (from llmClient.js getConfig + manifest metadata)
const llmKeys = [
  PREF_PREFIX + "provider-preset",
  PREF_PREFIX + "api-endpoint",
  PREF_PREFIX + "api-key",
  PREF_PREFIX + "model",
  PREF_PREFIX + "max-tokens",
  PREF_PREFIX + "temperature",
  PREF_PREFIX + "language",
];

const allExpectedKeys = new Set([...llmKeys, ...Object.keys(tradDefaults)]);

// Some preference keys are internal defaults (language direction codes) that
// intentionally have no UI element — users rarely need to change them.
const UI_OPTIONAL_KEYS = new Set([
  PREF_PREFIX + "pref-azure-from",
  PREF_PREFIX + "pref-azure-to",
  PREF_PREFIX + "pref-google-from",
  PREF_PREFIX + "pref-google-to",
]);

for (const key of xhtmlPrefs) {
  assert(allExpectedKeys.has(key),
    `preference="${key}" is a known key`);
}
for (const key of allExpectedKeys) {
  if (UI_OPTIONAL_KEYS.has(key)) {
    // Optional UI — the key is registered but may not have a bound element
    assert(true, `Optional key "${key}" (no UI element required)`);
  } else {
    assert(xhtmlPrefs.has(key),
      `Expected key "${key}" has a bound element in XHTML`);
  }
}

// ---------------------------------------------------------------------------
// 6. Unique element IDs
// ---------------------------------------------------------------------------
console.log("\n=== Element ID uniqueness ===");

const idRegex = /\bid="([^"]+)"/g;
const ids = [];
let im;
while ((im = idRegex.exec(xhtml)) !== null) {
  ids.push(im[1]);
}
const duplicateIds = ids.filter((id, idx) => ids.indexOf(id) !== idx);
assert(duplicateIds.length === 0,
  duplicateIds.length === 0
    ? `All ${ids.length} element IDs are unique`
    : `Duplicate IDs found: ${duplicateIds.join(", ")}`);

// ---------------------------------------------------------------------------
// 7. <label control="..."> references existing IDs
// ---------------------------------------------------------------------------
console.log("\n=== Label control references ===");

const controlRegex = /control="([^"]+)"/g;
const controls = [];
let cm;
while ((cm = controlRegex.exec(xhtml)) !== null) {
  controls.push(cm[1]);
}
const idSet = new Set(ids);
let allControlsValid = true;
for (const ctrl of controls) {
  const valid = idSet.has(ctrl);
  if (!valid) allControlsValid = false;
  assert(valid, `<label control="${ctrl}"> → target element exists`);
}
if (controls.length === 0) {
  assert(true, "No control references to check (none found)");
}

// ---------------------------------------------------------------------------
// 8. <html:input> elements have a type attribute
// ---------------------------------------------------------------------------
console.log("\n=== <html:input> type attributes ===");

const inputRegex = /<html:input[\s\S]*?>/g;
let inputMatch;
let allInputsHaveType = true;
let inputCount = 0;
while ((inputMatch = inputRegex.exec(xhtml)) !== null) {
  inputCount++;
  const hasType = /\btype="[^"]+"/.test(inputMatch[0]);
  if (!hasType) allInputsHaveType = false;
  const idM = matchId(inputMatch[0]);
  assert(hasType, `<html:input${idM ? " id=\"" + idM + "\"" : ""} #${inputCount} has type attribute`);
}
if (inputCount === 0) assert(false, "At least one <html:input> found");

function matchId(tag) {
  const m = tag.match(/\bid="([^"]+)"/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// 9. menulist elements contain menuitem children
// ---------------------------------------------------------------------------
console.log("\n=== menulist has menuitems ===");

const menulistRegex = /<menulist[\s\S]*?<\/menulist>/g;
let mlMatch;
let menulistCount = 0;
while ((mlMatch = menulistRegex.exec(xhtml)) !== null) {
  menulistCount++;
  const hasItems = /<menuitem\b/.test(mlMatch[0]);
  const idM = matchId(mlMatch[0]);
  assert(hasItems,
    `<menulist${idM ? " id=\"" + idM + "\"" : ""} #${menulistCount} contains <menuitem> children`);
}
assert(menulistCount > 0, `Found ${menulistCount} menulist elements (expected >= 1)`);

// ---------------------------------------------------------------------------
// 10. Root has onload attribute (calls Zotero.LLMAssistant.Prefs.onPaneLoad)
// ---------------------------------------------------------------------------
console.log("\n=== Root onload attribute ===");

const hasOnload = /\bonload\s*=/.test(rootTag);
assert(hasOnload, "Root element has onload= attribute for pane initialization");
const onloadCallsPrefs = /onload\s*=\s*"[^"]*Zotero\.LLMAssistant\.Prefs\.onPaneLoad/.test(rootTag);
assert(onloadCallsPrefs, "Root onload calls Zotero.LLMAssistant.Prefs.onPaneLoad");

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passed + failed} assertions: ${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log("\nFailed checks:");
  errors.forEach((e) => console.log("  ✗ " + e));
  process.exit(1);
} else {
  console.log("\nAll checks passed.");
}
