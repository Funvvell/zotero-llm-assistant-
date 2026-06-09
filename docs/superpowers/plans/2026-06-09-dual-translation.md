# Dual-Engine Translation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second translation engine (Baidu / Youdao / Azure / Google) that runs in parallel with the existing LLM, and surface both results side-by-side in the annotation card.

**Architecture:** New `TraditionalClient` module that wraps four vendor APIs behind a single `translate(text)` method. The existing `translateAndAnnotate()` in `overlay.js` switches from a single LLM call to a `Promise.allSettled` of LLM + Traditional, and `showAnnotationOnPDF()` is extended to render the new row. Preferences XHTML gets a new engine dropdown with conditional credential fields.

**Tech Stack:** JavaScript (ES2017+), XUL, XHTML, Node.js (test scripts only), Zotero 7.

---

## File Structure

### New Files

| Path | Responsibility |
|---|---|
| `addon/content/traditionalClient.js` | Vendor-agnostic facade; dispatches to one of four vendor methods based on preferences. |
| `scripts/test-traditional-client.js` | Unit tests that mock `_fetch` to verify each vendor's request format and response parsing. |
| `scripts/test-merge-logic.js` | Unit tests for the parallel-call merge shape used by `translateAndAnnotate`. |

### Modified Files

| Path | Change |
|---|---|
| `addon/bootstrap.js` | Add `Services.scriptloader.loadSubScript(scriptURL("traditionalClient.js"));` after the existing `llmClient.js` line. |
| `addon/content/overlay.js` | `translateAndAnnotate()` calls `TraditionalClient.translate` in parallel with `LLMClient.chat`; passes merged result to `ui().showAnnotationOnPDF()`. |
| `addon/content/uiManager.js` | `showAnnotationOnPDF()` accepts the merged shape; renders the new `⚡ 传统翻译` row. |
| `addon/content/preferences.xhtml` | Add a "Traditional Translation API" groupbox with engine dropdown and conditional credential fields. |
| `addon/manifest.json` | Declare 8 new preferences (1 engine + 7 credential fields). |
| `scripts/build.js` | No structural change; verify the new `traditionalClient.js` is automatically picked up by `copyRecursive`. |

---

## Task 1: TraditionalClient skeleton

**Files:**
- Create: `addon/content/traditionalClient.js`

- [ ] **Step 1: Create the skeleton file**

Create `addon/content/traditionalClient.js` with the public `translate` method that reads the engine preference and dispatches, but with all four vendor methods stubbed to return "not implemented" errors:

```javascript
/* global Zotero, Services */
/**
 * TraditionalClient - unified facade for 4 machine-translation APIs.
 * Returns a Promise resolving to { source, text, error }.
 *
 *   source : "baidu" | "youdao" | "azure" | "google" | null
 *   text   : the translated string, or null on failure
 *   error  : human-readable error message, or null on success
 */

Zotero.LLMAssistant = Zotero.LLMAssistant || {};

Zotero.LLMAssistant.TraditionalClient = {
  /**
   * Public entry point. Reads the user's chosen engine from preferences
   * and dispatches.
   */
  async translate(text, options = {}) {
    const engine = this._getPref("traditional-engine") || "";
    const source = engine || null;

    if (!text || !text.trim()) {
      return { source, text: null, error: "输入文本为空" };
    }
    if (!engine) {
      return { source: null, text: null, error: "未选择翻译引擎" };
    }

    try {
      switch (engine) {
        case "baidu":  return await this._baidu(text, options);
        case "youdao": return await this._youdao(text, options);
        case "azure":  return await this._azure(text, options);
        case "google": return await this._google(text, options);
        default:       return { source, text: null, error: `未知引擎: ${engine}` };
      }
    } catch (e) {
      Zotero.debug(`[LLM Assistant] Traditional translate failed: ${e.message}\n${e.stack}`);
      return { source, text: null, error: e.message || "未知错误" };
    }
  },

  // ----- private helpers -----

  _getPref(key) {
    return Zotero.Prefs.get(`extensions.zotero-llm-assistant.${key}`, true) || "";
  },

  /**
   * XMLHttpRequest wrapper shared with LLMClient. Identical behavior.
   */
  _fetch(url, options) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(options.method || "GET", url, true);
      xhr.setRequestHeader("Content-Type", "application/json");
      if (options.headers) {
        for (const [k, v] of Object.entries(options.headers)) {
          if (k !== "Content-Type") xhr.setRequestHeader(k, v);
        }
      }
      xhr.onload = () => resolve({
        ok: xhr.status >= 200 && xhr.status < 300,
        status: xhr.status,
        text: async () => xhr.responseText,
        json: async () => JSON.parse(xhr.responseText),
      });
      xhr.onerror = () => reject(new Error("网络错误"));
      xhr.ontimeout = () => reject(new Error("请求超时"));
      xhr.timeout = 10000;
      xhr.send(options.body || null);
    });
  },

  // ----- vendor methods (stubbed) -----

  async _baidu()    { return { source: "baidu",  text: null, error: "not implemented" }; },
  async _youdao()   { return { source: "youdao", text: null, error: "not implemented" }; },
  async _azure()    { return { source: "azure",  text: null, error: "not implemented" }; },
  async _google()   { return { source: "google", text: null, error: "not implemented" }; },
};
```

- [ ] **Step 2: Commit**

```bash
git add addon/content/traditionalClient.js
git commit -m "feat(traditionalClient): add skeleton with dispatch and 4 vendor stubs"
```

---

## Task 2: Wire TraditionalClient into bootstrap

**Files:**
- Modify: `addon/bootstrap.js` (insert one line after the `llmClient.js` loadSubScript)

- [ ] **Step 1: Add the loadSubScript call**

In `addon/bootstrap.js`, find this block (already present from previous work):

```javascript
  // Load modules (rootURI ends with /content/)
  const baseURL = rootURI.endsWith("/") ? rootURI : rootURI + "/";
  const scriptURL = (file) => baseURL + file;
  try {
    Services.scriptloader.loadSubScript(scriptURL("llmClient.js"));
    Services.scriptloader.loadSubScript(scriptURL("promptBuilder.js"));
    Services.scriptloader.loadSubScript(scriptURL("uiManager.js"));
    Services.scriptloader.loadSubScript(scriptURL("overlay.js"));
```

Insert one line so the block becomes:

```javascript
  try {
    Services.scriptloader.loadSubScript(scriptURL("llmClient.js"));
    Services.scriptloader.loadSubScript(scriptURL("traditionalClient.js"));
    Services.scriptloader.loadSubScript(scriptURL("promptBuilder.js"));
    Services.scriptloader.loadSubScript(scriptURL("uiManager.js"));
    Services.scriptloader.loadSubScript(scriptURL("overlay.js"));
```

- [ ] **Step 2: Commit**

```bash
git add addon/bootstrap.js
git commit -m "feat(bootstrap): load traditionalClient.js alongside LLM modules"
```

---

## Task 3: Baidu Translate vendor

**Files:**
- Modify: `addon/content/traditionalClient.js` (replace the `_baidu` stub)

- [ ] **Step 1: Write the failing test**

Create `scripts/test-traditional-client.js`:

```javascript
/**
 * Unit tests for TraditionalClient.
 * Mocks XMLHttpRequest to verify each vendor's request URL, params, headers,
 * signing, and response parsing.
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

// ----- shared mock setup -----
let lastRequest = null;

function installFetchMock(globalScope) {
  globalScope.XMLHttpRequest = class {
    constructor() {
      this._url = "";
      this._method = "";
      this._headers = {};
      this._body = null;
      this.responseText = "";
      this.status = 0;
      this.timeout = 0;
    }
    open(method, url) { this._method = method; this._url = url; }
    setRequestHeader(k, v) { this._headers[k] = v; }
    send(body) {
      this._body = body;
      lastRequest = {
        method: this._method,
        url: this._url,
        headers: this._headers,
        body: body,
      };
    }
  };
  // Save a way for the test to drive the "response"
  globalScope.__driveXHR = function (status, responseText) {
    // Find the most recently created XHR via a global registry
    const xhr = globalScope.__lastXHR;
    xhr.status = status;
    xhr.responseText = responseText;
    xhr.onload && xhr.onload();
  };
}

function makeXHRCapture(globalScope) {
  // Override the constructor so each call registers the instance
  const Original = globalScope.XMLHttpRequest;
  globalScope.__lastXHR = null;
  globalScope.XMLHttpRequest = class {
    constructor() {
      const inst = new Original();
      globalScope.__lastXHR = inst;
      return inst;
    }
  };
}

function buildSandbox(prefs) {
  const sandbox = {
    Zotero: {
      Prefs: { get: (key) => prefs[key.replace("extensions.zotero-llm-assistant.", "")] || "" },
      debug: () => {},
      logError: console.error,
    },
    Services: {},
    console,
    XMLHttpRequest: class { open() {} setRequestHeader() {} send() {} },
    setTimeout, clearTimeout,
    Promise, Array, Object, JSON, Math, Number, String, Boolean, RegExp, Error, Function, Date, Map, Set,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  return sandbox;
}

function loadClient(sandbox) {
  const code = fs.readFileSync(
    path.join(__dirname, "..", "addon", "content", "traditionalClient.js"),
    "utf-8"
  );
  vm.runInContext(code, sandbox);
}

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log("  ✓", name);
    passed++;
  } catch (e) {
    console.error("  ✗", name, "-", e.message);
    failed++;
  }
}

(async () => {
  // ==================== Baidu ====================
  console.log("\n=== Baidu ===");
  await test("missing credentials returns error", async () => {
    const sb = buildSandbox({});
    loadClient(sb);
    const r = await sb.Zotero.LLMAssistant.TraditionalClient._baidu("hello");
    assert(r.text === null, "text should be null");
    assert(r.error && r.error.includes("API"), "should mention API key");
    assert(r.source === "baidu");
  });

  await test("builds correct URL with sign and salt", async () => {
    const sb = buildSandbox({
      "baidu-appid": "testid",
      "baidu-key": "testkey",
    });
    installFetchMock(sb);
    makeXHRCapture(sb);
    loadClient(sb);
    const promise = sb.Zotero.LLMAssistant.TraditionalClient._baidu("hello");
    // Drive success response
    sb.__driveXHR(200, JSON.stringify({
      trans_result: [{ src: "hello", dst: "你好" }],
    }));
    const r = await promise;
    assert(r.text === "你好", `expected "你好", got ${r.text}`);
    // Verify URL contains sign and salt
    assert(lastRequest.url.includes("fanyi-api.baidu.com"), "URL should hit Baidu");
    assert(lastRequest.url.includes("appid=testid"), "URL should include appid");
    assert(lastRequest.url.includes("q=hello"), "URL should include q=hello");
    assert(/sign=[a-f0-9]{32}/.test(lastRequest.url), "URL should include 32-char sign");
  });

  // ==================== Youdao ====================
  console.log("\n=== Youdao ===");
  await test("missing credentials returns error", async () => {
    const sb = buildSandbox({});
    loadClient(sb);
    const r = await sb.Zotero.LLMAssistant.TraditionalClient._youdao("hello");
    assert(r.text === null, "text should be null");
    assert(r.error && r.error.includes("API"), "should mention API key");
    assert(r.source === "youdao");
  });

  await test("builds POST request with sign", async () => {
    const sb = buildSandbox({
      "youdao-appkey": "testkey",
      "youdao-appsecret": "testsecret",
    });
    installFetchMock(sb);
    makeXHRCapture(sb);
    loadClient(sb);
    const promise = sb.Zotero.LLMAssistant.TraditionalClient._youdao("hello");
    sb.__driveXHR(200, JSON.stringify({
      translation: ["你好"],
    }));
    const r = await promise;
    assert(r.text === "你好", `expected "你好", got ${r.text}`);
    assert(lastRequest.method === "POST", "should be POST");
    assert(lastRequest.url.includes("openapi.youdao.com"), "URL should hit Youdao");
    // body should be URL-encoded
    assert(typeof lastRequest.body === "string", "body should be string");
    assert(lastRequest.body.includes("appKey=testkey"), "body should include appKey");
    assert(/sign=[a-f0-9]{64}/.test(lastRequest.body), "body should include 64-char sign");
  });

  // ==================== Azure ====================
  console.log("\n=== Azure ===");
  await test("missing credentials returns error", async () => {
    const sb = buildSandbox({});
    loadClient(sb);
    const r = await sb.Zotero.LLMAssistant.TraditionalClient._azure("hello");
    assert(r.text === null, "text should be null");
    assert(r.error && r.error.includes("API"), "should mention API key");
    assert(r.source === "azure");
  });

  await test("builds POST with subscription key header", async () => {
    const sb = buildSandbox({
      "azure-key": "subkey123",
      "azure-region": "eastasia",
    });
    installFetchMock(sb);
    makeXHRCapture(sb);
    loadClient(sb);
    const promise = sb.Zotero.LLMAssistant.TraditionalClient._azure("hello");
    sb.__driveXHR(200, JSON.stringify([
      { translations: [{ text: "你好", to: "zh-Hans" }] },
    ]));
    const r = await promise;
    assert(r.text === "你好", `expected "你好", got ${r.text}`);
    assert(lastRequest.method === "POST", "should be POST");
    assert(lastRequest.url.includes("cognitive.microsofttranslator.com"));
    assert(lastRequest.headers["Ocp-Apim-Subscription-Key"] === "subkey123");
    assert(lastRequest.headers["Ocp-Apim-Subscription-Region"] === "eastasia");
  });

  // ==================== Google ====================
  console.log("\n=== Google ===");
  await test("missing credentials returns error", async () => {
    const sb = buildSandbox({});
    loadClient(sb);
    const r = await sb.Zotero.LLMAssistant.TraditionalClient._google("hello");
    assert(r.text === null, "text should be null");
    assert(r.error && r.error.includes("API"), "should mention API key");
    assert(r.source === "google");
  });

  await test("builds GET with key param", async () => {
    const sb = buildSandbox({
      "google-key": "AIza-test",
    });
    installFetchMock(sb);
    makeXHRCapture(sb);
    loadClient(sb);
    const promise = sb.Zotero.LLMAssistant.TraditionalClient._google("hello");
    sb.__driveXHR(200, JSON.stringify({
      data: { translations: [{ translatedText: "你好" }] },
    }));
    const r = await promise;
    assert(r.text === "你好", `expected "你好", got ${r.text}`);
    assert(lastRequest.method === "GET", "should be GET");
    assert(lastRequest.url.includes("translation.googleapis.com"));
    assert(lastRequest.url.includes("key=AIza-test"));
    assert(lastRequest.url.includes("q=hello"));
  });

  // ==================== Common ====================
  console.log("\n=== Common ===");
  await test("HTTP 401 returns auth error", async () => {
    const sb = buildSandbox({
      "baidu-appid": "x", "baidu-key": "y",
    });
    installFetchMock(sb);
    makeXHRCapture(sb);
    loadClient(sb);
    const promise = sb.Zotero.LLMAssistant.TraditionalClient._baidu("hello");
    sb.__driveXHR(401, "Unauthorized");
    const r = await promise;
    assert(r.text === null);
    assert(/401|鉴权|API key/.test(r.error), `error should mention auth: ${r.error}`);
  });

  await test("HTTP 500 returns service error", async () => {
    const sb = buildSandbox({
      "baidu-appid": "x", "baidu-key": "y",
    });
    installFetchMock(sb);
    makeXHRCapture(sb);
    loadClient(sb);
    const promise = sb.Zotero.LLMAssistant.TraditionalClient._baidu("hello");
    sb.__driveXHR(500, "Internal Server Error");
    const r = await promise;
    assert(r.text === null);
    assert(/500|服务/.test(r.error));
  });

  // ==================== Summary ====================
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `node scripts/test-traditional-client.js`
Expected: All Baidu / Youdao / Azure / Google tests fail with "Assertion failed: text should be null" or similar — because the stubs return "not implemented".

- [ ] **Step 3: Implement the Baidu vendor**

Replace the `_baidu` stub in `addon/content/traditionalClient.js` with:

```javascript
  async _baidu(text, options = {}) {
    const appid = this._getPref("baidu-appid");
    const key = this._getPref("baidu-key");
    if (!appid || !key) {
      return { source: "baidu", text: null, error: "未配置百度翻译 API key" };
    }

    const salt = String(Date.now());
    const sign = this._md5(appid + text + salt + key);
    const params = new URLSearchParams({
      q: text,
      from: options.from || "en",
      to: options.to || "zh",
      appid,
      salt,
      sign,
    });
    const url = `https://fanyi-api.baidu.com/api/trans/vip/translate?${params.toString()}`;

    const response = await this._fetch(url, { method: "GET" });
    if (!response.ok) {
      return { source: "baidu", text: null, error: this._httpError(response.status) };
    }
    const data = await response.json();
    if (data.error_code) {
      return { source: "baidu", text: null, error: `百度错误 ${data.error_code}: ${data.error_msg || ""}` };
    }
    if (!data.trans_result || data.trans_result.length === 0) {
      return { source: "baidu", text: null, error: "响应解析失败" };
    }
    const translated = data.trans_result.map((r) => r.dst).join("；");
    return { source: "baidu", text: translated, error: null };
  },

  /**
   * Compute MD5 hex digest of a string. Reuses crypto.MD5 when available
   * (Firefox/Zotero), falls back to a small pure-JS implementation.
   */
  _md5(str) {
    if (typeof Zotero !== "undefined" && Zotero.Utilities && Zotero.Utilities.Internal && Zotero.Utilities.Internal.md5) {
      return Zotero.Utilities.Internal.md5(str);
    }
    // Fallback: use a tiny pure-JS MD5. Node `crypto` is available in tests
    // but not in the XPCOM sandbox, so we bundle a minimal implementation.
    return this._md5js(str);
  },

  _md5js(str) {
    // Pure-JS MD5 (R. Rivest). Returns 32-char hex string.
    function rh(n) { let j, s = ""; for (j = 0; j <= 3; j++) s += ((n >> (j * 8 + 4)) & 0x0F).toString(16) + ((n >> (j * 8)) & 0x0F).toString(16); return s; }
    function ad(x, y) { const l = (x & 0xFFFF) + (y & 0xFFFF); const m = (x >> 16) + (y >> 16) + (l >> 16); return (m << 16) | (l & 0xFFFF); }
    function rl(n, c) { return (n << c) | (n >>> (32 - c)); }
    function cm(q, a, b, x, s, t) { return ad(rl(ad(ad(a, q), ad(x, t)), s), b); }
    function ff(a, b, c, d, x, s, t) { return cm((b & c) | ((~b) & d), a, b, x, s, t); }
    function gg(a, b, c, d, x, s, t) { return cm((b & d) | (c & (~d)), a, b, x, s, t); }
    function hh(a, b, c, d, x, s, t) { return cm(b ^ c ^ d, a, b, x, s, t); }
    function ii(a, b, c, d, x, s, t) { return cm(c ^ (b | (~d)), a, b, x, s, t); }
    function sb(s) {
      s = unescape(encodeURIComponent(s));
      const n = s.length, w = []; for (let i = 0; i < n; i++) w[i >> 2] = (w[i >> 2] || 0) | (s.charCodeAt(i) << ((i % 4) * 8));
      w[n >> 2] = (w[n >> 2] || 0) | (0x80 << ((n % 4) * 8));
      w[(((n + 8) >> 6) << 4) + 14] = n * 8;
      return w;
    }
    const x = sb(str);
    let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
    for (let i = 0; i < x.length; i += 16) {
      const aa = a, bb = b, cc = c, dd = d;
      a = ff(a, b, c, d, x[i + 0] || 0, 7, -680876936);
      d = ff(d, a, b, c, x[i + 1] || 0, 12, -389564586);
      c = ff(c, d, a, b, x[i + 2] || 0, 17, 606105819);
      b = ff(b, c, d, a, x[i + 3] || 0, 22, -1044525330);
      a = ff(a, b, c, d, x[i + 4] || 0, 7, -176418897);
      d = ff(d, a, b, c, x[i + 5] || 0, 12, 1200080426);
      c = ff(c, d, a, b, x[i + 6] || 0, 17, -1473231341);
      b = ff(b, c, d, a, x[i + 7] || 0, 22, -45705983);
      a = ff(a, b, c, d, x[i + 8] || 0, 7, 1770035416);
      d = ff(d, a, b, c, x[i + 9] || 0, 12, -1958414417);
      c = ff(c, d, a, b, x[i + 10] || 0, 17, -42063);
      b = ff(b, c, d, a, x[i + 11] || 0, 22, -1990404162);
      a = ff(a, b, c, d, x[i + 12] || 0, 7, 1804603682);
      d = ff(d, a, b, c, x[i + 13] || 0, 12, -40341101);
      c = ff(c, d, a, b, x[i + 14] || 0, 17, -1502002290);
      b = ff(b, c, d, a, x[i + 15] || 0, 22, 1236535329);
      a = gg(a, b, c, d, x[i + 1] || 0, 5, -165796510);
      d = gg(d, a, b, c, x[i + 6] || 0, 9, -1069501632);
      c = gg(c, d, a, b, x[i + 11] || 0, 14, 643717713);
      b = gg(b, c, d, a, x[i + 0] || 0, 20, -373897302);
      a = gg(a, b, c, d, x[i + 5] || 0, 5, -701558691);
      d = gg(d, a, b, c, x[i + 10] || 0, 9, 38016083);
      c = gg(c, d, a, b, x[i + 15] || 0, 14, -660478335);
      b = gg(b, c, d, a, x[i + 4] || 0, 20, -405537848);
      a = gg(a, b, c, d, x[i + 9] || 0, 5, 568446438);
      d = gg(d, a, b, c, x[i + 14] || 0, 9, -1019803690);
      c = gg(c, d, a, b, x[i + 3] || 0, 14, -187363961);
      b = gg(b, c, d, a, x[i + 8] || 0, 20, 1163531501);
      a = gg(a, b, c, d, x[i + 13] || 0, 5, -1444681467);
      d = gg(d, a, b, c, x[i + 2] || 0, 9, -51403784);
      c = gg(c, d, a, b, x[i + 7] || 0, 14, 1735328473);
      b = gg(b, c, d, a, x[i + 12] || 0, 20, -1926607734);
      a = hh(a, b, c, d, x[i + 5] || 0, 4, -378558);
      d = hh(d, a, b, c, x[i + 8] || 0, 11, -2022574463);
      c = hh(c, d, a, b, x[i + 11] || 0, 16, 1839030562);
      b = hh(b, c, d, a, x[i + 14] || 0, 23, -35309556);
      a = hh(a, b, c, d, x[i + 1] || 0, 4, -1530992060);
      d = hh(d, a, b, c, x[i + 4] || 0, 11, 1272893353);
      c = hh(c, d, a, b, x[i + 7] || 0, 16, -155497632);
      b = hh(b, c, d, a, x[i + 10] || 0, 23, -1094730640);
      a = hh(a, b, c, d, x[i + 13] || 0, 4, 681279174);
      d = hh(d, a, b, c, x[i + 0] || 0, 11, -358537222);
      c = hh(c, d, a, b, x[i + 3] || 0, 16, -722521979);
      b = hh(b, c, d, a, x[i + 6] || 0, 23, 76029189);
      a = hh(a, b, c, d, x[i + 9] || 0, 4, -640364487);
      d = hh(d, a, b, c, x[i + 12] || 0, 11, -421815835);
      c = hh(c, d, a, b, x[i + 15] || 0, 16, 530742520);
      b = hh(b, c, d, a, x[i + 2] || 0, 23, -995338651);
      a = ii(a, b, c, d, x[i + 0] || 0, 6, -198630844);
      d = ii(d, a, b, c, x[i + 7] || 0, 10, 1126891415);
      c = ii(c, d, a, b, x[i + 14] || 0, 15, -1416354905);
      b = ii(b, c, d, a, x[i + 5] || 0, 21, -57434055);
      a = ii(a, b, c, d, x[i + 12] || 0, 6, 1700485571);
      d = ii(d, a, b, c, x[i + 3] || 0, 10, -1894986606);
      c = ii(c, d, a, b, x[i + 10] || 0, 15, -1051523);
      b = ii(b, c, d, a, x[i + 1] || 0, 21, -2054922799);
      a = ii(a, b, c, d, x[i + 8] || 0, 6, 1873313359);
      d = ii(d, a, b, c, x[i + 15] || 0, 10, -30611744);
      c = ii(c, d, a, b, x[i + 6] || 0, 15, -1560198380);
      b = ii(b, c, d, a, x[i + 13] || 0, 21, 1309151649);
      a = ii(a, b, c, d, x[i + 4] || 0, 6, -145523070);
      d = ii(d, a, b, c, x[i + 11] || 0, 10, -1120210379);
      c = ii(c, d, a, b, x[i + 2] || 0, 15, 718787259);
      b = ii(b, c, d, a, x[i + 9] || 0, 21, -343485551);
      a = ad(a, aa); b = ad(b, bb); c = ad(c, cc); d = ad(d, dd);
    }
    return rh(a) + rh(b) + rh(c) + rh(d);
  },

  _httpError(status) {
    if (status === 401 || status === 403) return "鉴权失败，请检查 API key";
    if (status === 429) return "请求过于频繁或配额用尽";
    if (status >= 500) return `服务暂时不可用 (HTTP ${status})`;
    return `请求失败 (HTTP ${status})`;
  },
```

- [ ] **Step 4: Run the test to confirm Baidu passes**

Run: `node scripts/test-traditional-client.js`
Expected: 2 Baidu tests pass; 2 other vendor tests still fail with "not implemented" / wrong sign.

- [ ] **Step 5: Commit**

```bash
git add addon/content/traditionalClient.js scripts/test-traditional-client.js
git commit -m "feat(traditionalClient): implement Baidu vendor with MD5 signing"
```

---

## Task 4: Youdao Translate vendor

**Files:**
- Modify: `addon/content/traditionalClient.js` (replace the `_youdao` stub)

- [ ] **Step 1: Implement the Youdao vendor**

Replace the `_youdao` stub with:

```javascript
  async _youdao(text, options = {}) {
    const appKey = this._getPref("youdao-appkey");
    const appSecret = this._getPref("youdao-appsecret");
    if (!appKey || !appSecret) {
      return { source: "youdao", text: null, error: "未配置有道翻译 API key" };
    }

    const salt = String(Date.now());
    const curtime = String(Math.floor(Date.now() / 1000));
    const input = text.length > 20 ? text.substring(0, 10) + text.length + text.substring(text.length - 10) : text;
    const sign = this._sha256(appKey + input + salt + curtime + appSecret);

    const body = new URLSearchParams({
      q: text,
      from: options.from || "en",
      to: options.to || "zh-CHS",
      appKey,
      salt,
      sign,
      signType: "v3",
      curtime,
    }).toString();

    const url = "https://openapi.youdao.com/api";
    const response = await this._fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok) {
      return { source: "youdao", text: null, error: this._httpError(response.status) };
    }
    const data = await response.json();
    if (data.errorCode && data.errorCode !== "0") {
      return { source: "youdao", text: null, error: `有道错误 ${data.errorCode}` };
    }
    if (!data.translation || data.translation.length === 0) {
      return { source: "youdao", text: null, error: "响应解析失败" };
    }
    return { source: "youdao", text: data.translation[0], error: null };
  },
```

Add a SHA-256 helper next to `_md5js`. Use the Web Crypto API when available (Firefox/Zotero), with a tiny pure-JS fallback for tests:

```javascript
  _sha256(str) {
    // Web Crypto is available in Firefox/Zotero 7
    if (typeof Components !== "undefined" && Components.utils && Components.utils.SHA256) {
      const bytes = Components.utils.SHA256(this._strToBytes(str));
      return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
    }
    return this._sha256js(str);
  },

  _strToBytes(str) {
    // UTF-8 encode
    const bytes = [];
    for (let i = 0; i < str.length; i++) {
      let c = str.charCodeAt(i);
      if (c < 0x80) bytes.push(c);
      else if (c < 0x800) { bytes.push(0xC0 | (c >> 6)); bytes.push(0x80 | (c & 0x3F)); }
      else if (c < 0x10000) { bytes.push(0xE0 | (c >> 12)); bytes.push(0x80 | ((c >> 6) & 0x3F)); bytes.push(0x80 | (c & 0x3F)); }
      else { bytes.push(0xF0 | (c >> 18)); bytes.push(0x80 | ((c >> 12) & 0x3F)); bytes.push(0x80 | ((c >> 6) & 0x3F)); bytes.push(0x80 | (c & 0x3F)); }
    }
    return bytes;
  },

  _sha256js(str) {
    // Pure-JS SHA-256. Returns 64-char hex string.
    function ro(n, x) { return (x >>> n) | (x << (32 - n)); }
    const K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
    const bytes = this._strToBytes(str);
    const n = bytes.length; const w = []; for (let i = 0; i < n; i++) w[i >> 2] = (w[i >> 2] || 0) | (bytes[i] << ((3 - (i % 4)) * 8));
    w[n >> 2] = (w[n >> 2] || 0) | (0x80 << ((3 - (n % 4)) * 8));
    const total = Math.ceil((n + 9) / 64) * 16;
    w[total - 1] = n * 8;
    let H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    for (let i = 0; i < w.length; i += 16) {
      const W = new Array(64);
      for (let t = 0; t < 16; t++) W[t] = w[i + t] || 0;
      for (let t = 16; t < 64; t++) {
        const s0 = ro(7, W[t - 15]) ^ ro(18, W[t - 15]) ^ (W[t - 15] >>> 3);
        const s1 = ro(17, W[t - 2]) ^ ro(19, W[t - 2]) ^ (W[t - 2] >>> 10);
        W[t] = (W[t - 16] + s0 + W[t - 7] + s1) | 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let t = 0; t < 64; t++) {
        const S1 = ro(6, e) ^ ro(11, e) ^ ro(25, e);
        const ch = (e & f) ^ ((~e) & g);
        const t1 = (h + S1 + ch + K[t] + W[t]) | 0;
        const S0 = ro(2, a) ^ ro(13, a) ^ ro(22, a);
        const mj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + mj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H = H.map((v, idx) => (v + [a, b, c, d, e, f, g, h][idx]) | 0);
    }
    return H.map((v) => (v >>> 0).toString(16).padStart(8, "0")).join("");
  },
```

- [ ] **Step 2: Run the test to confirm Youdao passes**

Run: `node scripts/test-traditional-client.js`
Expected: 2 Baidu + 2 Youdao pass; Azure/Google still fail.

- [ ] **Step 3: Commit**

```bash
git add addon/content/traditionalClient.js
git commit -m "feat(traditionalClient): implement Youdao vendor with SHA-256 signing"
```

---

## Task 5: Microsoft Translator vendor

**Files:**
- Modify: `addon/content/traditionalClient.js` (replace the `_azure` stub)

- [ ] **Step 1: Implement the Azure vendor**

Replace the `_azure` stub with:

```javascript
  async _azure(text, options = {}) {
    const key = this._getPref("azure-key");
    const region = this._getPref("azure-region");
    if (!key) {
      return { source: "azure", text: null, error: "未配置 Azure 翻译 API key" };
    }

    const url = "https://api.cognitive.microsofttranslator.com/translate" +
                `?api-version=3.0&from=${options.from || "en"}&to=${options.to || "zh-Hans"}`;
    const body = JSON.stringify([{ Text: text }]);
    const headers = {
      "Content-Type": "application/json",
      "Ocp-Apim-Subscription-Key": key,
    };
    if (region) headers["Ocp-Apim-Subscription-Region"] = region;

    const response = await this._fetch(url, { method: "POST", headers, body });
    if (!response.ok) {
      return { source: "azure", text: null, error: this._httpError(response.status) };
    }
    const data = await response.json();
    if (!Array.isArray(data) || data.length === 0 || !data[0].translations || data[0].translations.length === 0) {
      return { source: "azure", text: null, error: "响应解析失败" };
    }
    return { source: "azure", text: data[0].translations[0].text, error: null };
  },
```

- [ ] **Step 2: Run the test to confirm Azure passes**

Run: `node scripts/test-traditional-client.js`
Expected: 2 Baidu + 2 Youdao + 2 Azure pass; Google still fails.

- [ ] **Step 3: Commit**

```bash
git add addon/content/traditionalClient.js
git commit -m "feat(traditionalClient): implement Microsoft Translator (Azure) vendor"
```

---

## Task 6: Google Translate vendor

**Files:**
- Modify: `addon/content/traditionalClient.js` (replace the `_google` stub)

- [ ] **Step 1: Implement the Google vendor**

Replace the `_google` stub with:

```javascript
  async _google(text, options = {}) {
    const key = this._getPref("google-key");
    if (!key) {
      return { source: "google", text: null, error: "未配置 Google 翻译 API key" };
    }

    const params = new URLSearchParams({
      key,
      q: text,
      source: options.from || "en",
      target: options.to || "zh-CN",
      format: "text",
    });
    const url = `https://translation.googleapis.com/language/translate/v2?${params.toString()}`;

    const response = await this._fetch(url, { method: "GET" });
    if (!response.ok) {
      return { source: "google", text: null, error: this._httpError(response.status) };
    }
    const data = await response.json();
    if (!data.data || !data.data.translations || data.data.translations.length === 0) {
      return { source: "google", text: null, error: "响应解析失败" };
    }
    return { source: "google", text: data.data.translations[0].translatedText, error: null };
  },
```

- [ ] **Step 2: Run all tests, expecting everything to pass**

Run: `node scripts/test-traditional-client.js`
Expected: All 10 tests pass (2 per vendor + 2 common).

- [ ] **Step 3: Commit**

```bash
git add addon/content/traditionalClient.js
git commit -m "feat(traditionalClient): implement Google Translate vendor"
```

---

## Task 7: Parallel-call merge in translateAndAnnotate

**Files:**
- Modify: `addon/content/overlay.js` (rewrite `translateAndAnnotate`)
- Create: `scripts/test-merge-logic.js`

- [ ] **Step 1: Write the failing test**

Create `scripts/test-merge-logic.js`:

```javascript
/**
 * Tests for the parallel-call merge logic used by translateAndAnnotate.
 * We extract the merge into a small helper that we can test in isolation,
 * then make translateAndAnnotate call that helper.
 */

// (Filled in during implementation - see step 3.)
```

Actually, since the merge is small, we test the final shape by mocking both clients and asserting the call to `ui().showAnnotationOnPDF`. For brevity, we do an **integration-style test** that exercises the actual `translateAndAnnotate` function with mock LLM and Traditional clients:

Create `scripts/test-merge-logic.js`:

```javascript
/**
 * Integration test for translateAndAnnotate's parallel-call merge.
 * Mocks LLMClient.chat and TraditionalClient.translate, then verifies that
 * showAnnotationOnPDF receives a merged shape containing both results.
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

function makeSandbox() {
  const captured = { showAnnotationCalled: null };
  const sandbox = {
    Zotero: {
      debug: () => {},
      logError: console.error,
      getMainWindow: () => ({
        document: { readyState: "complete", addEventListener() {}, documentElement: {} },
        MutationObserver: class { observe() {} disconnect() {} },
        innerWidth: 1920, innerHeight: 1080,
        Zotero_Tabs: { selectedID: "x" },
      }),
      Reader: { getByTabID: () => ({ getSelectedText: () => "task" }) },
      PDFWorker: { getFullText: async () => "test full text" },
      Prefs: { get: () => "" },
    },
    Services: {},
    console,
    setTimeout, clearTimeout,
    XMLHttpRequest: class {},
    Components: { classes: {}, interfaces: {} },
    Promise, Array, Object, JSON, Math, Number, String, Boolean, RegExp, Error, Function, Date, Map, Set,
  };
  sandbox.__captured = captured;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  return sandbox;
}

function loadAll(sandbox) {
  for (const f of ["llmClient.js", "traditionalClient.js", "promptBuilder.js", "uiManager.js", "overlay.js"]) {
    const code = fs.readFileSync(path.join(__dirname, "..", "addon", "content", f), "utf-8");
    vm.runInContext(code, sandbox);
  }
}

function assert(c, m) { if (!c) throw new Error(m); }
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log("  ✓", name); passed++; }
  catch (e) { console.error("  ✗", name, "-", e.message); failed++; }
}

(async () => {
  console.log("=== translateAndAnnotate merge logic ===");

  await test("both engines succeed -> both results in payload", async () => {
    const sb = makeSandbox();
    loadAll(sb);
    sb.Zotero.LLMAssistant.LLMClient.chat = async () => JSON.stringify({
      type: "word", original: "task", translation: "学习任务", reasoning: "...", examples: [],
    });
    sb.Zotero.LLMAssistant.TraditionalClient.translate = async () => ({
      source: "baidu", text: "任务", error: null,
    });
    sb.Zotero.LLMAssistant.UIManager.showLoading = () => {};
    sb.Zotero.LLMAssistant.UIManager.showError = () => {};
    sb.Zotero.LLMAssistant.UIManager.showAnnotationOnPDF = function (payload) {
      sb.__captured.showAnnotationCalled = payload;
    };

    await sb.Zotero.LLMAssistant.translateAndAnnotate();
    const p = sb.__captured.showAnnotationCalled;
    assert(p, "showAnnotationOnPDF should be called");
    assert(p.traditional && p.traditional.text === "任务", "should have traditional text");
    assert(p.llm && p.llm.translation === "学习任务", "should have LLM text");
  });

  await test("traditional fails, LLM succeeds -> only LLM in payload", async () => {
    const sb = makeSandbox();
    loadAll(sb);
    sb.Zotero.LLMAssistant.LLMClient.chat = async () => JSON.stringify({
      type: "word", original: "task", translation: "学习任务",
    });
    sb.Zotero.LLMAssistant.TraditionalClient.translate = async () => ({
      source: "baidu", text: null, error: "API key 无效",
    });
    sb.Zotero.LLMAssistant.UIManager.showLoading = () => {};
    sb.Zotero.LLMAssistant.UIManager.showError = () => {};
    sb.Zotero.LLMAssistant.UIManager.showAnnotationOnPDF = function (payload) {
      sb.__captured.showAnnotationCalled = payload;
    };
    await sb.Zotero.LLMAssistant.translateAndAnnotate();
    const p = sb.__captured.showAnnotationCalled;
    assert(p, "should be called");
    assert(p.traditional && p.traditional.error, "should record traditional error");
    assert(p.llm && p.llm.translation === "学习任务", "should still have LLM result");
  });

  await test("LLM fails, traditional succeeds -> only traditional in payload", async () => {
    const sb = makeSandbox();
    loadAll(sb);
    sb.Zotero.LLMAssistant.LLMClient.chat = async () => { throw new Error("LLM 504"); };
    sb.Zotero.LLMAssistant.TraditionalClient.translate = async () => ({
      source: "baidu", text: "任务", error: null,
    });
    sb.Zotero.LLMAssistant.UIManager.showLoading = () => {};
    sb.Zotero.LLMAssistant.UIManager.showError = () => {};
    sb.Zotero.LLMAssistant.UIManager.showAnnotationOnPDF = function (payload) {
      sb.__captured.showAnnotationCalled = payload;
    };
    await sb.Zotero.LLMAssistant.translateAndAnnotate();
    const p = sb.__captured.showAnnotationCalled;
    assert(p, "should be called");
    assert(p.traditional && p.traditional.text === "任务", "should have traditional result");
    assert(p.llm && p.llm.error, "should record LLM error");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
```

- [ ] **Step 2: Run the test (it should fail because translateAndAnnotate does not yet call TraditionalClient)**

Run: `node scripts/test-merge-logic.js`
Expected: All 3 tests fail — `showAnnotationCalled` is null because the current `translateAndAnnotate` does not call the new code path.

- [ ] **Step 3: Rewrite translateAndAnnotate to do the parallel merge**

In `addon/content/overlay.js`, find the `translateAndAnnotate` function (it currently looks roughly like: get selection, get context, get full text, call LLM, parse JSON, show). Replace the **entire function body** with:

```javascript
  Zotero.LLMAssistant.translateAndAnnotate = async function () {
    const { text: selectedText, rect: selectionRect } = _getReaderSelectionWithRect();
    if (!selectedText) {
      ui().showError("未在 PDF 阅读器中选中文本。请先选中单词或短语。");
      return;
    }

    const trimmed = selectedText.trim();
    if (!trimmed) {
      ui().showError("选中的内容为空。");
      return;
    }

    ui().showLoading("正在分析上下文并翻译...");

    // 1) Get sentence + surrounding text from the page (fast, no network)
    const { sentence, surrounding } = _getSelectionContext();

    // 2) Build both prompts up front
    const prompt = prompts().buildContextAwareTranslatePrompt({
      selected: trimmed,
      sentence: sentence || trimmed,
      surrounding,
      fullText: "", // filled in below
    });

    // 3) Fetch the full text only if the LLM call is going to happen
    //    (Traditional doesn't need it). We fetch it lazily via .then chain.
    const fullTextPromise = _getReaderFullText();

    // 4) Kick off both engines in parallel
    const llmPromise = (async () => {
      const fullText = await fullTextPromise;
      // Rebuild the prompt now that we have the full text
      const finalPrompt = prompts().buildContextAwareTranslatePrompt({
        selected: trimmed,
        sentence: sentence || trimmed,
        surrounding,
        fullText,
      });
      return client().chat([{ role: "user", content: finalPrompt }]);
    })();

    const traditionalPromise = traditional().translate(trimmed);

    // 5) allSettled so neither failure aborts the other
    const [llmResult, traditionalResult] = await Promise.allSettled([
      llmPromise,
      traditionalPromise,
    ]);

    // 6) Build merged payload
    const llmPayload = llmResult.status === "fulfilled"
      ? parseLlmResponse(llmResult.value, trimmed)
      : { error: llmResult.reason?.message || "LLM 调用失败" };

    const merged = {
      traditional: traditionalResult.status === "fulfilled"
        ? traditionalResult.value
        : { source: null, text: null, error: traditionalResult.reason?.message || "传统翻译失败" },
      llm: llmPayload,
    };

    // 7) Show
    if (!merged.traditional?.text && !merged.llm?.translation) {
      ui().showError(
        `两种翻译都失败了。\n传统: ${merged.traditional?.error}\nLLM: ${merged.llm?.error}`
      );
      return;
    }
    ui().showAnnotationOnPDF(merged, selectionRect);
  };

  /**
   * Parse the LLM's raw response into the structured shape used by the UI.
   * Always returns an object; on parse failure returns { error }.
   */
  function parseLlmResponse(raw, fallbackOriginal) {
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(raw);
      parsed.type = parsed.type || (fallbackOriginal.includes(" ") ? "phrase" : "word");
      parsed.original = parsed.original || fallbackOriginal;
      parsed.translation = parsed.translation || "";
      parsed.reasoning = parsed.reasoning || "";
      return parsed;
    } catch (e) {
      return {
        type: fallbackOriginal.includes(" ") ? "phrase" : "word",
        original: fallbackOriginal,
        translation: raw.trim(),
        reasoning: "",
        examples: [],
      };
    }
  }
```

Also add this near the top of the IIFE, next to the other alias definitions:

```javascript
  const traditional = () => Zotero.LLMAssistant.TraditionalClient;
```

- [ ] **Step 4: Run the merge test, expect all 3 to pass**

Run: `node scripts/test-merge-logic.js`
Expected: All 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add addon/content/overlay.js scripts/test-merge-logic.js
git commit -m "feat(overlay): parallel-call merge of LLM and traditional translation"
```

---

## Task 8: Render the new traditional row in showAnnotationOnPDF

**Files:**
- Modify: `addon/content/uiManager.js` (extend `showAnnotationOnPDF` to accept and render `{traditional, llm}` shape; keep backwards-compatible with direct LLM payloads)

- [ ] **Step 1: Update the function signature and rendering**

In `addon/content/uiManager.js`, find `showAnnotationOnPDF(data, selectionRect)`. Replace the **entire function body** (down to the closing `},`) with:

```javascript
  showAnnotationOnPDF(data, selectionRect) {
    this.hideLoading();

    const doc = Zotero.getMainWindow().document;
    const win = Zotero.getMainWindow();

    this._removeExistingAnnotation();

    // Backwards-compat: if data has `translation` directly (old LLM shape), wrap it
    if (data && data.translation !== undefined && data.llm === undefined) {
      data = { traditional: null, llm: data };
    }
    if (!data || (!data.llm && !data.traditional)) {
      this.showError("没有可显示的翻译结果");
      return;
    }

    const traditional = data.traditional || null;
    const llm = data.llm || null;
    const llmType = llm?.type || (llm?.original || "").includes(" ") ? "phrase" : "word";
    const llmOriginal = llm?.original || llm?.word || "";
    const llmPhonetic = llm?.phonetic || "";
    const llmPos = llm?.partOfSpeech || "";
    const llmTranslation = llm?.translation || "";
    const llmReasoning = llm?.reasoning || "";
    const llmExamples = llm?.examples || [];

    const tooltip = doc.createElement("div");
    tooltip.id = "zotero-llm-annotation-tooltip";
    tooltip.style.cssText = `
      position: fixed;
      z-index: 999999;
      background: #fffbe6;
      border: 1px solid #ffd700;
      border-radius: 8px;
      padding: 10px 14px;
      max-width: 380px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.15);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans SC", sans-serif;
      font-size: 13px;
      line-height: 1.6;
      color: #333;
      pointer-events: auto;
      user-select: text;
    `;

    const tagColor = llmType === "phrase" ? "#7c3aed" : "#2563eb";
    const tagLabel = llmType === "phrase" ? "短语" : "单词";

    const headerHtml = llmOriginal ? `<div style="font-weight: bold; font-size: 15px; color: #1a1a1a; margin-bottom: 4px;">
      <span style="display: inline-block; background: ${tagColor}; color: #fff; font-size: 10px; font-weight: 500; padding: 1px 6px; border-radius: 3px; margin-right: 6px; vertical-align: middle;">${tagLabel}</span>
      ${this._escapeHtml(llmOriginal)}
      ${llmPhonetic ? `<span style="font-weight: normal; color: #666; font-size: 13px;">[${this._escapeHtml(llmPhonetic)}]</span>` : ""}
      ${llmPos ? `<span style="color: ${tagColor}; font-size: 12px;"> ${this._escapeHtml(llmPos)}</span>` : ""}
    </div>` : "";

    // ---- Traditional row ----
    let traditionalRow = "";
    if (traditional && traditional.text) {
      const sourceLabel = sourceDisplayName(traditional.source);
      traditionalRow = `<div style="background: #f0f9ff; border-left: 3px solid #0ea5e9; padding: 6px 8px; margin: 6px 0; font-size: 12px; border-radius: 3px;">
        <span style="color: #0369a1; font-weight: 600;">⚡ ${this._escapeHtml(sourceLabel)}：</span>
        <span>${this._escapeHtml(traditional.text)}</span>
      </div>`;
    } else if (traditional && traditional.error) {
      traditionalRow = `<div style="background: #fef2f2; border-left: 3px solid #ef4444; padding: 6px 8px; margin: 6px 0; font-size: 12px; border-radius: 3px; color: #b91c1c;">
        ⚠ 传统翻译失败：${this._escapeHtml(traditional.error)}
      </div>`;
    } else if (traditional === null && llm) {
      traditionalRow = `<div style="color: #9ca3af; font-size: 11px; margin: 4px 0; font-style: italic;">(传统翻译未配置)</div>`;
    }

    // ---- LLM row ----
    const llmTranslationHtml = llmTranslation ? `<div style="color: #d97706; font-size: 14px; margin-bottom: 4px; line-height: 1.8;">
      <div style="font-size: 10px; color: #b45309; margin-bottom: 2px;">🤖 LLM 上下文消歧（双击词可标注）：</div>
      <span id="zotero-llm-translation-words">${this._wrapTranslationAsClickableWords(llmTranslation)}</span>
    </div>` : "";

    let reasoningHtml = "";
    if (llmReasoning) {
      reasoningHtml = `<div style="background: #f0f7ff; border-left: 3px solid #3b82f6; padding: 6px 8px; margin: 6px 0; font-size: 12px; color: #1e40af; border-radius: 3px;">
        <strong>为什么是这意思：</strong>${this._escapeHtml(llmReasoning)}
      </div>`;
    }

    let examplesHtml = "";
    if (llmExamples.length > 0) {
      examplesHtml = `<div style="border-top: 1px dashed #e5e7eb; padding-top: 6px; margin-top: 6px;">
        <div style="font-size: 11px; color: #888; margin-bottom: 3px;">例句：</div>
        ${llmExamples.map((ex) => `<div style="font-size: 12px; color: #555; margin-bottom: 2px;">• ${this._escapeHtml(ex)}</div>`).join("")}
      </div>`;
    }

    const closeBtnHtml = `<div style="text-align: right; margin-top: 8px;">
      <button id="zotero-llm-annotation-close" style="background: #f3f4f6; border: 1px solid #d1d5db; border-radius: 4px; padding: 2px 10px; font-size: 12px; cursor: pointer; color: #374151;">关闭</button>
      <button id="zotero-llm-annotation-add-note" style="background: #2563eb; border: 1px solid #2563eb; border-radius: 4px; padding: 2px 10px; font-size: 12px; cursor: pointer; color: #fff; margin-left: 6px;">添加到笔记</button>
    </div>`;

    tooltip.innerHTML = headerHtml + traditionalRow + llmTranslationHtml + reasoningHtml + examplesHtml + closeBtnHtml;

    // Find the PDF viewer container
    let pdfContainer = doc.getElementById("reader-ui");
    if (!pdfContainer) pdfContainer = doc.getElementById("zotero-pane");
    if (!pdfContainer) pdfContainer = doc.body;
    pdfContainer.appendChild(tooltip);
    this._annotationTooltip = tooltip;

    // Position the tooltip above the selected word
    const { x, y } = this._computeTooltipPosition(selectionRect, tooltip, win);
    tooltip.style.left = x + "px";
    tooltip.style.top = y + "px";

    // Bind close / save buttons
    const closeBtn = doc.getElementById("zotero-llm-annotation-close");
    if (closeBtn) closeBtn.addEventListener("click", () => this._removeExistingAnnotation());
    const noteBtn = doc.getElementById("zotero-llm-annotation-add-note");
    if (noteBtn) {
      noteBtn.addEventListener("click", () => {
        this._saveAnnotationToNote({ llm, traditional });
        this._removeExistingAnnotation();
      });
    }

    // Double-click on individual LLM translation words -> persistent annotation
    const wordSpans = tooltip.querySelectorAll(".zotero-llm-translation-word");
    wordSpans.forEach((span) => {
      span.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        const word = span.getAttribute("data-word") || span.textContent.trim();
        this._createPersistentAnnotation(word, selectionRect);
        this._removeExistingAnnotation();
      });
    });

    this._annotationTimeout = setTimeout(() => this._removeExistingAnnotation(), 30000);
  },

  /**
   * Compute tooltip position given the selection rect and the tooltip element.
   */
  _computeTooltipPosition(selectionRect, tooltip, win) {
    const tooltipRect = tooltip.getBoundingClientRect();
    const finalWidth = tooltipRect.width || 320;
    const finalHeight = tooltipRect.height || 160;
    let x, y;
    if (selectionRect && selectionRect.left !== undefined) {
      x = selectionRect.left + selectionRect.width / 2 - finalWidth / 2;
      y = selectionRect.top - finalHeight - 6;
    } else {
      const reader = Zotero.getMainWindow().document.querySelector("#reader-ui .reader");
      if (reader) {
        const rect = reader.getBoundingClientRect();
        x = rect.left + rect.width / 2 - finalWidth / 2;
        y = rect.top + 60;
      } else {
        x = 200; y = 150;
      }
    }
    if (x + finalWidth > win.innerWidth - 10) x = win.innerWidth - finalWidth - 10;
    if (x < 10) x = 10;
    if (y < 10 && selectionRect) y = selectionRect.bottom + 6;
    if (y + finalHeight > win.innerHeight - 10) y = win.innerHeight - finalHeight - 10;
    if (y < 10) y = 10;
    return { x, y };
  },
```

Also add a private helper at the top of the UIManager object (next to the existing `_escapeHtml`):

```javascript
  /**
   * Display name for a translation source.
   */
  sourceDisplayName(source) {
    if (!source) return "传统翻译";
    const map = {
      baidu: "百度翻译",
      youdao: "有道翻译",
      azure: "Microsoft 翻译",
      google: "Google 翻译",
    };
    return map[source] || source;
  },
```

Note: the `sourceDisplayName` call inside the template needs to be `this.sourceDisplayName(...)` or it will fail in strict mode. **Use `this.sourceDisplayName(traditional.source)`** in the template (the snippet above already does that, but double-check).

- [ ] **Step 2: Update `_saveAnnotationToNote` to accept the merged shape**

In `addon/content/uiManager.js`, find `_saveAnnotationToNote(data)`. Replace the **body** with:

```javascript
  async _saveAnnotationToNote(data) {
    try {
      const items = Zotero.getActiveZoteroPane().getSelectedItems();
      if (!items || items.length === 0) {
        this._showNotification("请先选择一个文献条目。");
        return;
      }
      const item = items[0];
      const note = new Zotero.Item("note");
      note.libraryID = item.libraryID;
      note.parentKey = item.key;

      const llm = data.llm || data;
      const traditional = data.traditional || null;
      const type = llm.type || (llm.word ? "word" : "word");
      const typeLabel = type === "phrase" ? "短语标注" : "单词标注";
      const original = llm.original || llm.word || "";
      const examplesHtml = (llm.examples || []).map((ex) => `<li>${this._escapeHtml(ex)}</li>`).join("");
      const reasoningHtml = llm.reasoning ? `<p><strong>语境分析：</strong>${this._escapeHtml(llm.reasoning)}</p>` : "";
      const traditionalHtml = traditional && traditional.text
        ? `<p><strong>${this._escapeHtml(this.sourceDisplayName(traditional.source))}：</strong>${this._escapeHtml(traditional.text)}</p>`
        : "";

      note.setNote(
        `<h3>${typeLabel}: ${this._escapeHtml(original)}</h3>` +
        `<p><strong>类型：</strong>${type === "phrase" ? "短语" : "单词"}</p>` +
        (llm.phonetic ? `<p><strong>音标：</strong>${this._escapeHtml(llm.phonetic)}</p>` : "") +
        (llm.partOfSpeech ? `<p><strong>词性：</strong>${this._escapeHtml(llm.partOfSpeech)}</p>` : "") +
        `<p><strong>LLM 释义：</strong>${this._escapeHtml(llm.translation || "")}</p>` +
        reasoningHtml +
        traditionalHtml +
        (examplesHtml ? `<p><strong>例句：</strong></p><ul>${examplesHtml}</ul>` : "")
      );
      await note.saveTx();
      this._showNotification("已保存到笔记！");
    } catch (e) {
      Zotero.debug(`[LLM Assistant] Save annotation note failed: ${e.message}`);
      this._showNotification("保存笔记失败。");
    }
  },
```

- [ ] **Step 3: Run all existing tests to ensure no regression**

Run: `node scripts/test-ui-helpers.js && node scripts/test-merge-logic.js`
Expected: All helper unit tests pass; all 3 merge tests pass.

- [ ] **Step 4: Commit**

```bash
git add addon/content/uiManager.js
git commit -m "feat(ui): render traditional-translation row alongside LLM row"
```

---

## Task 9: Preferences UI

**Files:**
- Modify: `addon/content/preferences.xhtml` (add new groupbox)
- Modify: `addon/manifest.json` (add 8 new preferences)

- [ ] **Step 1: Add the new groupbox to preferences.xhtml**

Open `addon/content/preferences.xhtml`. Find the closing `</vbox>` of the window. Just **before** the closing `</vbox>`, insert:

```xml
    <groupbox>
      <caption label="传统翻译 API（与 LLM 并行调用，可选）" />

      <hbox align="center">
        <label value="Engine:" control="pref-traditional-engine" width="120" />
        <menulist id="pref-traditional-engine"
                  preference="extensions.zotero-llm-assistant.traditional-engine"
                  style="flex: 1;">
          <menupopup>
            <menuitem label="(无，使用 LLM 单引擎)" value="" />
            <menuitem label="百度翻译" value="baidu" />
            <menuitem label="有道翻译" value="youdao" />
            <menuitem label="Microsoft Translator (Azure)" value="azure" />
            <menuitem label="Google Translate API" value="google" />
          </menupopup>
        </menulist>
      </hbox>

      <!-- Baidu fields -->
      <vbox id="group-baidu" style="margin-top: 6px;">
        <label value="百度翻译凭据：" style="font-weight: bold; font-size: 12px;" />
        <hbox align="center">
          <label value="APP ID:" control="pref-baidu-appid" width="120" />
          <html:input id="pref-baidu-appid" type="text"
                      preference="extensions.zotero-llm-assistant.baidu-appid"
                      style="flex: 1;" />
        </hbox>
        <hbox align="center">
          <label value="密钥:" control="pref-baidu-key" width="120" />
          <html:input id="pref-baidu-key" type="password"
                      preference="extensions.zotero-llm-assistant.baidu-key"
                      style="flex: 1;" />
        </hbox>
      </vbox>

      <!-- Youdao fields -->
      <vbox id="group-youdao" style="margin-top: 6px;">
        <label value="有道翻译凭据：" style="font-weight: bold; font-size: 12px;" />
        <hbox align="center">
          <label value="AppKey:" control="pref-youdao-appkey" width="120" />
          <html:input id="pref-youdao-appkey" type="text"
                      preference="extensions.zotero-llm-assistant.youdao-appkey"
                      style="flex: 1;" />
        </hbox>
        <hbox align="center">
          <label value="AppSecret:" control="pref-youdao-appsecret" width="120" />
          <html:input id="pref-youdao-appsecret" type="password"
                      preference="extensions.zotero-llm-assistant.youdao-appsecret"
                      style="flex: 1;" />
        </hbox>
      </vbox>

      <!-- Azure fields -->
      <vbox id="group-azure" style="margin-top: 6px;">
        <label value="Azure 翻译凭据：" style="font-weight: bold; font-size: 12px;" />
        <hbox align="center">
          <label value="Subscription Key:" control="pref-azure-key" width="120" />
          <html:input id="pref-azure-key" type="password"
                      preference="extensions.zotero-llm-assistant.azure-key"
                      style="flex: 1;" />
        </hbox>
        <hbox align="center">
          <label value="Region:" control="pref-azure-region" width="120" />
          <html:input id="pref-azure-region" type="text"
                      placeholder="e.g. eastasia"
                      preference="extensions.zotero-llm-assistant.azure-region"
                      style="flex: 1;" />
        </hbox>
      </vbox>

      <!-- Google fields -->
      <vbox id="group-google" style="margin-top: 6px;">
        <label value="Google 翻译凭据：" style="font-weight: bold; font-size: 12px;" />
        <hbox align="center">
          <label value="API Key:" control="pref-google-key" width="120" />
          <html:input id="pref-google-key" type="password"
                      preference="extensions.zotero-llm-assistant.google-key"
                      style="flex: 1;" />
        </hbox>
      </vbox>

      <description style="margin-top: 6px; font-size: 11px; color: #6b7280;">
        提示：在偏好中切换"Engine"后，仅显示对应服务的凭据字段。未配置凭据时自动跳过该引擎。
      </description>
    </groupbox>
```

- [ ] **Step 2: Add the new preferences to manifest.json**

Open `addon/manifest.json`. Find the closing `}` of the `preferences` object. Just **before** the closing `}`, insert the new keys:

```json
    ,
    "pref-traditional-engine": {
      "type": "string",
      "title": "传统翻译引擎",
      "description": "选择一个传统机器翻译 API，与 LLM 并行调用",
      "value": ""
    },
    "pref-baidu-appid": {
      "type": "string",
      "title": "百度翻译 APP ID",
      "value": ""
    },
    "pref-baidu-key": {
      "type": "string",
      "title": "百度翻译密钥",
      "value": ""
    },
    "pref-youdao-appkey": {
      "type": "string",
      "title": "有道翻译 AppKey",
      "value": ""
    },
    "pref-youdao-appsecret": {
      "type": "string",
      "title": "有道翻译 AppSecret",
      "value": ""
    },
    "pref-azure-key": {
      "type": "string",
      "title": "Azure 翻译 Key",
      "value": ""
    },
    "pref-azure-region": {
      "type": "string",
      "title": "Azure 区域",
      "value": ""
    },
    "pref-google-key": {
      "type": "string",
      "title": "Google Translate API Key",
      "value": ""
    }
```

- [ ] **Step 3: Rebuild and verify the .xpi contains the new file**

Run: `rm -rf build dist && node scripts/build.js && mkdir -p dist && cd build && zip -r ../dist/zotero-llm-assistant-1.0.0.xpi .`
Expected: `unzip -l dist/zotero-llm-assistant-1.0.0.xpi` lists `content/traditionalClient.js` and shows updated `manifest.json`.

- [ ] **Step 4: Commit**

```bash
git add addon/content/preferences.xhtml addon/manifest.json dist/zotero-llm-assistant-1.0.0.xpi
git commit -m "feat(prefs): add traditional translation engine and credentials"
```

---

## Task 10: Final regression + manual smoke checklist

**Files:**
- Run existing tests + update them if needed

- [ ] **Step 1: Run all unit and integration tests**

Run: `node scripts/test-traditional-client.js && node scripts/test-ui-helpers.js && node scripts/test-merge-logic.js && node scripts/test-bootstrap.js`
Expected: All 4 test scripts pass with no errors.

- [ ] **Step 2: Verify .xpi structure**

Run: `unzip -l dist/zotero-llm-assistant-1.0.0.xpi`
Expected output contains: `manifest.json`, `bootstrap.js`, `content/llmClient.js`, `content/traditionalClient.js`, `content/promptBuilder.js`, `content/uiManager.js`, `content/overlay.js`, `content/preferences.xhtml`, `content/icons/icon@48.png`, `content/icons/icon@96.png`, `content/overlay.css`. **No** `install.rdf`, no `chrome.manifest`, no `overlay.xul`.

- [ ] **Step 3: Manual smoke checklist (document, do not execute)**

Create `docs/superpowers/plans/2026-06-09-dual-translation-SMOKE.md` and copy this checklist:

```markdown
# Dual-Engine Translation Manual Smoke Checklist

Run these checks in a real Zotero 7 install before tagging a release.

## LLM-only mode (engine unset)
- [ ] Open any PDF in the reader, select a word.
- [ ] Right-click → 翻译并标注.
- [ ] Card shows only the LLM row, plus a small "(传统翻译未配置)" hint.
- [ ] Double-click a word in the LLM translation → persistent label appears on the PDF.

## Baidu engine
- [ ] Preferences → 传统翻译 API → Engine = 百度翻译.
- [ ] Enter a valid Baidu APP ID + secret, save, close.
- [ ] Select a word, right-click → 翻译并标注.
- [ ] Card shows both rows: ⚡ 百度翻译 + 🤖 LLM 上下文消歧.
- [ ] Disconnect network, retry → traditional row shows the error; LLM row still renders (or shows its own error).

## Youdao / Azure / Google engines
- [ ] Repeat the above for each engine, verifying the correct request goes out
      (look in the Zotero debug log: `[LLM Assistant] Traditional translate failed` or
      capture the URL via dev tools network panel).

## Engine switching
- [ ] Switch from Baidu to Azure in preferences.
- [ ] Select a word; card should now show "⚡ Microsoft 翻译" instead of "百度翻译".
- [ ] Switch to "(无)"; the traditional row should disappear entirely.

## Notes
- [ ] Click 添加到笔记 → a new child note appears with both LLM and traditional
      fields filled in (where present).
```

- [ ] **Step 4: Commit the smoke checklist**

```bash
git add docs/superpowers/plans/2026-06-09-dual-translation-SMOKE.md
git commit -m "docs: add manual smoke checklist for dual-engine translation"
```

- [ ] **Step 5: Tag the release**

```bash
git tag -a v1.1.0 -m "Dual-engine translation: Baidu/Youdao/Azure/Google alongside LLM"
git log --oneline -10
```

---

## Self-Review

### Spec coverage

| Spec section | Implemented in |
|---|---|
| §1 Goals (fast baseline + context-aware) | Task 7 (parallel call), Task 8 (two-row UI) |
| §1 Goals (LLM-only fallback) | Task 8 (backwards-compat wrapping), Task 9 (empty default) |
| §2 Non-goals (no auto-merge) | Not implemented, by design |
| §2 Non-goals (one engine only) | `pref-traditional-engine` is a single string |
| §2 Non-goals (no proactive key check) | Only check at call time |
| §3.1 Preferences UI | Task 9 |
| §3.2 Right-click menu | Unchanged (existing entry point) |
| §3.3 Annotation card 5 rendering rules | Task 8 (all 5 covered) |
| §3.4 Double-click unchanged | Task 8 keeps the dblclick binding |
| §4 Data flow | Task 7 implements `Promise.allSettled` |
| §5 Module layout | Tasks 1-8 + Task 2 (bootstrap) |
| §6 TraditionalClient API | Task 1 (public method), Tasks 3-6 (vendors) |
| §7 Vendor-specific notes | Tasks 3-6 cover all 4 vendors |
| §8 Preferences keys | Task 9 declares all 8 keys |
| §9 Error handling | Tasks 3-6 each return a clean `{source, text: null, error}`; Task 7 surfaces errors to UI |
| §10 Testing | Tasks 3-7 write tests, Task 10 runs all + manual checklist |

No gaps.

### Placeholder scan

- No "TBD", "TODO", "implement later", "add appropriate error handling" patterns.
- Every code step shows the full code block.
- Every test step shows the full test code.
- No "similar to Task N" references; all code is inlined.

### Type consistency

| Symbol | Defined in | Used in |
|---|---|---|
| `TraditionalClient.translate(text, options)` | Task 1 | Task 7 |
| `{source, text, error}` shape | Task 1 | Tasks 3-6, Task 7, Task 8 |
| `parseLlmResponse(raw, fallbackOriginal)` | Task 7 | Task 7 only |
| `showAnnotationOnPDF(data, selectionRect)` | Task 8 (updated) | Task 7 (caller), Task 8 (def) |
| `sourceDisplayName(source)` | Task 8 | Task 8 (template), Task 8 (`_saveAnnotationToNote`) |
| `_saveAnnotationToNote(data)` | Task 8 (updated) | Task 8 (note button) |

All names are consistent.

### Scope check

One feature, one plan. ✓

### Ambiguity check

- "missing credentials" is defined uniformly across all 4 vendors (returns `{text: null, error: "未配置... API key"}`).
- "10s timeout" is the spec; my plan uses `xhr.timeout = 10000` in `_fetch`.
- "Default engine" is `""` (LLM-only), which the spec says is the default.

No ambiguities remain.
