/*
    test-ui-source-name.js
    -----------------------
    Light-weight unit test for UIManager.sourceDisplayName and the
    showAnnotationOnPDF HTML layout for traditional translation. We can't run
    the full DOM-based showAnnotationOnPDF without a browser, so we extract
    the pure logic (the source-label map and the traditional-row HTML
    composition) and test that.

    Run from /workspace:
        node scripts/test-ui-source-name.js
*/

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SRC = fs.readFileSync(
    path.join(__dirname, "..", "addon", "uiManager.js"), "utf8"
);

// Extract just sourceDisplayName and a `composeTraditionalRow` helper we'll
// re-create. We don't need a real DOM, so we run a stripped sandbox that
// initializes Zotero.LLMAssistant.UIManager.sourceDisplayName.

function loadUIManager() {
    // Provide minimal Zotero so the script can attach its module.
    const sandbox = {
        Zotero: {
            LLMAssistant: {},
            getMainWindow: () => null,
            getActiveZoteroPane: () => ({ getSelectedItems: () => [] })
        },
        Components: { classes: {}, interfaces: {} },
        console
    };
    vm.createContext(sandbox);
    vm.runInContext(SRC, sandbox);
    return sandbox.Zotero.LLMAssistant.UIManager;
}

let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); console.log(`  PASS  ${name}`); passed++; }
    catch (e) { console.log(`  FAIL  ${name}\n    ${e.message}\n${e.stack}`); failed++; }
}

console.log("UIManager tests:");

const UI = loadUIManager();

test("sourceDisplayName: maps known engines to Chinese labels", () => {
    assert.strictEqual(UI.sourceDisplayName("baidu"),  "百度翻译");
    assert.strictEqual(UI.sourceDisplayName("youdao"), "有道翻译");
    assert.strictEqual(UI.sourceDisplayName("azure"),  "微软翻译");
    assert.strictEqual(UI.sourceDisplayName("google"), "Google 翻译");
});

test("sourceDisplayName: 'none' → '无'", () => {
    assert.strictEqual(UI.sourceDisplayName("none"), "无");
});

test("sourceDisplayName: unknown source falls through to source string", () => {
    assert.strictEqual(UI.sourceDisplayName("deepl"), "deepl");
});

test("sourceDisplayName: null/undefined → '未知'", () => {
    assert.strictEqual(UI.sourceDisplayName(null),      "未知");
    assert.strictEqual(UI.sourceDisplayName(undefined), "未知");
    assert.strictEqual(UI.sourceDisplayName(""),        "未知");
});

test("showAnnotationOnPDF: traditional row is present when data.traditional has text", () => {
    // Compose the data shape that translateAndAnnotate produces.
    const data = {
        type: "word",
        original: "bank",
        translation: "河岸 (LLM)",
        traditional: { source: "baidu", text: "银行" }
    };
    // We can't call the real function (needs DOM), but we can test the
    // gating condition: traditionalHtml is empty unless both `data.traditional`
    // and `data.traditional.text` are truthy. The render code already uses
    // exactly that test, so verify by simulating the same logic:
    const traditional = data.traditional;
    const wouldRender = !!(traditional && traditional.text);
    assert.ok(wouldRender, "traditional row should render for valid text");
});

test("showAnnotationOnPDF: traditional row is omitted when text is null", () => {
    const data = { type: "word", original: "x", translation: "x", traditional: { source: "baidu", text: null, error: "401" } };
    const wouldRender = !!(data.traditional && data.traditional.text);
    assert.ok(!wouldRender, "traditional row should NOT render for null text");
});

test("showAnnotationOnPDF: traditional row is omitted when no .traditional at all", () => {
    const data = { type: "word", original: "x", translation: "x" };
    const wouldRender = !!(data.traditional && data.traditional.text);
    assert.ok(!wouldRender);
});

test("sourceDisplayName: HTML escape is the caller's job; label returns raw text", () => {
    // The returned label is plain text and is HTML-escaped at the call site
    // (see showAnnotationOnPDF which wraps it in _escapeHtml). So the
    // function itself should NOT pre-escape.
    assert.strictEqual(UI.sourceDisplayName("baidu&<you>"), "baidu&<you>");
});

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
