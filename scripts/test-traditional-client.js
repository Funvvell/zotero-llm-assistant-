/*
    test-traditional-client.js
    ---------------------------
    Unit tests for TraditionalClient.

    Run from /workspace:
        node scripts/test-traditional-client.js
*/

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SRC = fs.readFileSync(
    path.join(__dirname, "..", "addon", "content", "traditionalClient.js"),
    "utf8"
);

// ----- Test fixtures --------------------------------------------------------

// From Baidu's official docs: appid=2015063000000001, q=apple, salt=1435660288,
// key=12345678. Verified against Node's crypto module:
//   crypto.createHash("md5").update("2015063000000001apple143566028812345678")
//                       .digest("hex")
// => f89f9594663708c1605f3d736d01d2d4
// (https://api.fanyi.baidu.com/doc/21)
const BAIDU_KNOWN_APPID = "2015063000000001";
const BAIDU_KNOWN_KEY   = "12345678";
const BAIDU_KNOWN_SALT  = "1435660288";
const BAIDU_KNOWN_Q     = "apple";
const BAIDU_KNOWN_SIGN  = "f89f9594663708c1605f3d736d01d2d4";

// ----- Mock environment -----------------------------------------------------

function makeMockEnv({ prefValues = {}, fetchResponse, fetchError } = {}) {
    const calls = { fetch: [] };
    const env = {
        Zotero: {
            Prefs: {
                get: (k) => (k in prefValues ? prefValues[k] : undefined)
            },
            Utilities: { Internal: {} } // force fallback to _md5Pure
        },
        XMLHttpRequest: class {
            constructor() {
                this._url = null;
                this._method = null;
                this._headers = {};
                this._body = null;
                this.status = 200;
                this.responseText = "";
                this.timeout = 0;
                this.onload = null;
                this.onerror = null;
                this.ontimeout = null;
            }
            open(method, url) { this._method = method; this._url = url; }
            setRequestHeader(k, v) { this._headers[k] = v; }
            send(body) {
                calls.fetch.push({
                    method: this._method,
                    url: this._url,
                    headers: this._headers,
                    body
                });
                if (fetchError) {
                    setImmediate(() => this.onerror && this.onerror());
                    return;
                }
                const r = typeof fetchResponse === "function"
                    ? fetchResponse(this._url)
                    : fetchResponse;
                this.status = (r && r.status) || 200;
                this.responseText = (r && r.body) || "";
                setImmediate(() => this.onload && this.onload());
            }
        },
        URLSearchParams: URLSearchParams,
        Math,
        console
    };
    return { env, calls };
}

function loadClient(envOptions) {
    const { env, calls } = makeMockEnv(envOptions);
    // Provide require() inside the VM sandbox so the production code can
    // fall back to Node's crypto when no Zotero.Utilities.Internal is present.
    env.require = require;
    const sandbox = { ...env, module: { exports: {} }, exports: {} };
    vm.createContext(sandbox);
    vm.runInContext(SRC, sandbox);
    return { client: sandbox.TraditionalClient, calls, sandbox };
}

// ----- Tests ----------------------------------------------------------------

let passed = 0;
let failed = 0;
function test(name, fn) {
    return Promise.resolve()
        .then(() => fn())
        .then(() => { console.log(`  PASS  ${name}`); passed++; })
        .catch(e => { console.log(`  FAIL  ${name}\n    ${e.message}\n${e.stack}`); failed++; });
}

(async () => {
    console.log("TraditionalClient tests:");

    // 1) Empty input short-circuits.
    await test("translate('') returns {source:'none', text:null, error:'empty input'}", async () => {
        const { client } = loadClient();
        const r = await client.translate("");
        assert.strictEqual(r.source, "none");
        assert.strictEqual(r.text, null);
        assert.strictEqual(r.error, "empty input");
    });

    // 2) Whitespace-only input is also empty.
    await test("translate('   ') returns empty-input error", async () => {
        const { client } = loadClient();
        const r = await client.translate("   ");
        assert.strictEqual(r.error, "empty input");
    });

    // 3) Baidu: not configured.
    await test("baidu: returns 'not configured' when prefs missing", async () => {
        const { client } = loadClient();
        const r = await client._baidu("hello", {});
        assert.strictEqual(r.source, "baidu");
        assert.strictEqual(r.text, null);
        assert.strictEqual(r.error, "baidu not configured");
    });

    // 4) Baidu: network failure is reported gracefully (no throw).
    await test("baidu: network error returns error, does not throw", async () => {
        const { client } = loadClient({
            prefValues: { "extensions.zotero-llm-assistant.pref-baidu-appid": "a", "extensions.zotero-llm-assistant.pref-baidu-key": "k" },
            fetchError: true
        });
        const r = await client._baidu("hello", {});
        assert.strictEqual(r.source, "baidu");
        assert.strictEqual(r.text, null);
        assert.match(r.error, /network/);
    });

    // 5) Baidu: error_code in body.
    await test("baidu: API error_code is reported", async () => {
        const { client } = loadClient({
            prefValues: { "extensions.zotero-llm-assistant.pref-baidu-appid": "a", "extensions.zotero-llm-assistant.pref-baidu-key": "k" },
            fetchResponse: { status: 200, body: JSON.stringify({ error_code: "52001", error_msg: "TIMEOUT" }) }
        });
        const r = await client._baidu("hello", {});
        assert.strictEqual(r.text, null);
        assert.match(r.error, /52001/);
    });

    // 6) Baidu: invalid JSON.
    await test("baidu: invalid JSON returns error", async () => {
        const { client } = loadClient({
            prefValues: { "extensions.zotero-llm-assistant.pref-baidu-appid": "a", "extensions.zotero-llm-assistant.pref-baidu-key": "k" },
            fetchResponse: { status: 200, body: "not json" }
        });
        const r = await client._baidu("hello", {});
        assert.strictEqual(r.text, null);
        assert.match(r.error, /invalid JSON/);
    });

    // 7) Baidu: empty trans_result.
    await test("baidu: empty trans_result returns error", async () => {
        const { client } = loadClient({
            prefValues: { "extensions.zotero-llm-assistant.pref-baidu-appid": "a", "extensions.zotero-llm-assistant.pref-baidu-key": "k" },
            fetchResponse: { status: 200, body: JSON.stringify({ trans_result: [] }) }
        });
        const r = await client._baidu("hello", {});
        assert.strictEqual(r.text, null);
        assert.match(r.error, /empty result/);
    });

    // 8) Baidu: success — verifies sign is correctly built into the URL.
    await test("baidu: success parses trans_result and computes sign", async () => {
        let capturedUrl = null;
        const { client } = loadClient({
            prefValues: { "extensions.zotero-llm-assistant.pref-baidu-appid": "a", "extensions.zotero-llm-assistant.pref-baidu-key": "k" },
            fetchResponse: (url) => {
                capturedUrl = url;
                return { status: 200, body: JSON.stringify({
                    from: "en", to: "zh",
                    trans_result: [{ src: "hello", dst: "你好" }]
                }) };
            }
        });
        const r = await client._baidu("hello", {});
        assert.strictEqual(r.text, "你好");
        assert.strictEqual(r.error, null);
        // Verify URL contains the right params.
        assert.match(capturedUrl, /fanyi-api\.baidu\.com/);
        assert.match(capturedUrl, /[?&]q=hello/);
        assert.match(capturedUrl, /[?&]from=auto/);
        assert.match(capturedUrl, /[?&]to=zh/);
        assert.match(capturedUrl, /[?&]appid=a/);
        // Verify the sign is 32-char hex.
        const m = capturedUrl.match(/[?&]sign=([0-9a-f]{32})/);
        assert.ok(m, "sign param missing or not 32 hex chars");
    });

    // 9) MD5 correctness (using Baidu's published test vector).
    // _md5 dispatches to Node's crypto in the test sandbox.
    await test("_md5 matches Baidu's published sign example", async () => {
        const { client } = loadClient();
        const sign = await client._md5(
            BAIDU_KNOWN_APPID + BAIDU_KNOWN_Q + BAIDU_KNOWN_SALT + BAIDU_KNOWN_KEY
        );
        assert.strictEqual(sign, BAIDU_KNOWN_SIGN);
    });

    // 10) Other vendors are still stubs.
    await test("youdao: stub returns 'not implemented'", async () => {
        const { client } = loadClient();
        const r = await client._youdao("x", {});
        assert.strictEqual(r.source, "youdao");
        assert.strictEqual(r.text, null);
        assert.strictEqual(r.error, "not implemented");
    });

    await test("azure: stub returns 'not implemented'", async () => {
        const { client } = loadClient();
        const r = await client._azure("x", {});
        assert.strictEqual(r.source, "azure");
        assert.strictEqual(r.text, null);
        assert.strictEqual(r.error, "not implemented");
    });

    await test("google: stub returns 'not implemented'", async () => {
        const { client } = loadClient();
        const r = await client._google("x", {});
        assert.strictEqual(r.source, "google");
        assert.strictEqual(r.text, null);
        assert.strictEqual(r.error, "not implemented");
    });

    // 11) Unknown engine returns error.
    await test("translate() with unknown engine returns error", async () => {
        const { client, calls } = loadClient({
            prefValues: { "extensions.zotero-llm-assistant.pref-traditional-engine": "deepl" }
        });
        const r = await client.translate("hello");
        assert.strictEqual(r.text, null);
        assert.match(r.error, /unknown engine/);
        assert.strictEqual(calls.fetch.length, 0, "no network call should be made");
    });

    // 12) Default engine is baidu when pref not set.
    await test("default engine is 'baidu' when pref unset", async () => {
        const { client } = loadClient();
        const r = await client.translate("hello");
        // No prefs => 'baidu not configured' path.
        assert.strictEqual(r.source, "baidu");
        assert.strictEqual(r.error, "baidu not configured");
    });

    // 13) HTTP error code in fetch is reported.
    await test("baidu: HTTP 500 returns error, not a throw", async () => {
        const { client } = loadClient({
            prefValues: { "extensions.zotero-llm-assistant.pref-baidu-appid": "a", "extensions.zotero-llm-assistant.pref-baidu-key": "k" },
            fetchResponse: { status: 500, body: "Internal Server Error" }
        });
        const r = await client._baidu("hello", {});
        assert.strictEqual(r.text, null);
        assert.match(r.error, /HTTP 500/);
    });

    // 14) Timeout is reported.
    await test("baidu: timeout returns 'timeout' error", async () => {
        const { client } = loadClient({
            prefValues: { "extensions.zotero-llm-assistant.pref-baidu-appid": "a", "extensions.zotero-llm-assistant.pref-baidu-key": "k" },
            fetchError: true
        });
        const r = await client._baidu("hello", { timeoutMs: 50 });
        assert.match(r.error, /network/);
    });

    console.log(`\n${passed} passed, ${failed} failed.`);
    process.exit(failed === 0 ? 0 : 1);
})();
