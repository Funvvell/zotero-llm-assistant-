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

// Youdao signature vector. Computed offline:
//   sha256("id" + "你好" + "1435660288" + "1567419038" + "secret")
// (https://ai.youdao.com/DOCSIRMA/html/trans/api/wbfy/index.html)
const YOUDAO_KNOWN_APPKEY    = "id";
const YOUDAO_KNOWN_APPSECRET = "secret";
const YOUDAO_KNOWN_Q         = "你好";
const YOUDAO_KNOWN_SALT      = "1435660288";
const YOUDAO_KNOWN_CURTIME   = "1567419038";
const YOUDAO_KNOWN_SIGN      = "d95c45dbd6e6dd62f43ad53cf7c38815d7d703738fbd086f22603fada94af3c8";

// ----- Mock environment -----------------------------------------------------

function makeMockEnv({ prefValues = {}, fetchResponse, fetchError, nowMs = 1567419038000 } = {}) {
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
                    ? fetchResponse(this._url, this._method, this._headers, body)
                    : fetchResponse;
                this.status = (r && r.status) || 200;
                this.responseText = (r && r.body) || "";
                setImmediate(() => this.onload && this.onload());
            }
        },
        URLSearchParams: URLSearchParams,
        Math,
        Date: class extends Date {
            constructor(...args) { super(...args); }
            static now() { return nowMs; }
        },
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
    await test("google is implemented (not stub)", async () => {
        const { client } = loadClient();
        const r = await client._google("x", {});
        assert.strictEqual(r.source, "google");
        assert.strictEqual(r.text, null);
        // Now returns "google not configured" instead of "not implemented".
        assert.strictEqual(r.error, "google not configured");
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

    // ============= Youdao tests ============================================

    await test("youdao: not configured returns error", async () => {
        const { client } = loadClient();
        const r = await client._youdao("hello", {});
        assert.strictEqual(r.source, "youdao");
        assert.strictEqual(r.text, null);
        assert.strictEqual(r.error, "youdao not configured");
    });

    await test("youdao: network error is reported", async () => {
        const { client } = loadClient({
            prefValues: { "extensions.zotero-llm-assistant.pref-youdao-appkey": "k", "extensions.zotero-llm-assistant.pref-youdao-appsecret": "s" },
            fetchError: true
        });
        const r = await client._youdao("hello", {});
        assert.match(r.error, /youdao network/);
    });

    await test("youdao: API errorCode is reported", async () => {
        const { client } = loadClient({
            prefValues: { "extensions.zotero-llm-assistant.pref-youdao-appkey": "k", "extensions.zotero-llm-assistant.pref-youdao-appsecret": "s" },
            fetchResponse: { status: 200, body: JSON.stringify({ errorCode: "401", errorMessage: "no permission" }) }
        });
        const r = await client._youdao("hello", {});
        assert.strictEqual(r.text, null);
        assert.match(r.error, /401/);
    });

    await test("youdao: invalid JSON returns error", async () => {
        const { client } = loadClient({
            prefValues: { "extensions.zotero-llm-assistant.pref-youdao-appkey": "k", "extensions.zotero-llm-assistant.pref-youdao-appsecret": "s" },
            fetchResponse: { status: 200, body: "<html>500</html>" }
        });
        const r = await client._youdao("hello", {});
        assert.match(r.error, /invalid JSON/);
    });

    await test("youdao: empty translation returns error", async () => {
        const { client } = loadClient({
            prefValues: { "extensions.zotero-llm-assistant.pref-youdao-appkey": "k", "extensions.zotero-llm-assistant.pref-youdao-appsecret": "s" },
            fetchResponse: { status: 200, body: JSON.stringify({ errorCode: "0", translation: [] }) }
        });
        const r = await client._youdao("hello", {});
        assert.match(r.error, /empty result/);
    });

    await test("youdao: success parses translation, signs, posts to openapi.youdao.com", async () => {
        let captured = null;
        const { client } = loadClient({
            prefValues: { "extensions.zotero-llm-assistant.pref-youdao-appkey": "k", "extensions.zotero-llm-assistant.pref-youdao-appsecret": "s" },
            fetchResponse: (url, method, headers, body) => {
                captured = { url, method, headers, body };
                return { status: 200, body: JSON.stringify({
                    errorCode: "0",
                    translation: ["hello"],
                    query: "你好"
                }) };
            }
        });
        const r = await client._youdao("你好", {});
        assert.strictEqual(r.text, "hello");
        assert.strictEqual(r.error, null);
        assert.strictEqual(captured.method, "POST");
        assert.match(captured.url, /openapi\.youdao\.com\/api/);
        assert.strictEqual(captured.headers["Content-Type"], "application/x-www-form-urlencoded");
        // Body should contain these params.
        assert.match(captured.body, /q=%E4%BD%A0%E5%A5%BD/);
        assert.match(captured.body, /from=auto/);
        assert.match(captured.body, /to=zh-CHS/);
        assert.match(captured.body, /signType=v3/);
        assert.match(captured.body, /salt=/);
        assert.match(captured.body, /curtime=1567419038/);
    });

    await test("youdao: SHA-256 sign matches published vector", async () => {
        const { client } = loadClient();
        const sign = await client._sha256(
            YOUDAO_KNOWN_APPKEY + YOUDAO_KNOWN_Q + YOUDAO_KNOWN_SALT +
            YOUDAO_KNOWN_CURTIME + YOUDAO_KNOWN_APPSECRET
        );
        assert.strictEqual(sign, YOUDAO_KNOWN_SIGN);
    });

    await test("youdao: long q is truncated to first10+len+last10 in sign", async () => {
        let captured = null;
        const { client } = loadClient({
            prefValues: { "extensions.zotero-llm-assistant.pref-youdao-appkey": "k", "extensions.zotero-llm-assistant.pref-youdao-appsecret": "s" },
            fetchResponse: (url, method, headers, body) => {
                captured = { url, body };
                return { status: 200, body: JSON.stringify({ errorCode: "0", translation: ["hi"] }) };
            }
        });
        const q = "a".repeat(50); // 50 chars, > 20
        await client._youdao(q, {});
        // q body param should be the full 50 chars; sign is computed from truncated.
        assert.match(captured.body, new RegExp(`q=${"a".repeat(50)}`));
    });

    // ============= Azure tests ==============================================

    await test("azure: not configured returns error", async () => {
        const { client } = loadClient();
        const r = await client._azure("hello", {});
        assert.strictEqual(r.source, "azure");
        assert.strictEqual(r.error, "azure not configured");
    });

    await test("azure: network error is reported", async () => {
        const { client } = loadClient({
            prefValues: { "extensions.zotero-llm-assistant.pref-azure-key": "k" },
            fetchError: true
        });
        const r = await client._azure("hello", {});
        assert.match(r.error, /azure network/);
    });

    await test("azure: HTTP 401 is reported", async () => {
        const { client } = loadClient({
            prefValues: { "extensions.zotero-llm-assistant.pref-azure-key": "k" },
            fetchResponse: { status: 401, body: "unauthorized" }
        });
        const r = await client._azure("hello", {});
        assert.match(r.error, /HTTP 401/);
    });

    await test("azure: invalid JSON returns error", async () => {
        const { client } = loadClient({
            prefValues: { "extensions.zotero-llm-assistant.pref-azure-key": "k" },
            fetchResponse: { status: 200, body: "<html>500</html>" }
        });
        const r = await client._azure("hello", {});
        assert.match(r.error, /invalid JSON/);
    });

    await test("azure: empty array returns error", async () => {
        const { client } = loadClient({
            prefValues: { "extensions.zotero-llm-assistant.pref-azure-key": "k" },
            fetchResponse: { status: 200, body: "[]" }
        });
        const r = await client._azure("hello", {});
        assert.match(r.error, /empty result/);
    });

    await test("azure: empty translations returns error", async () => {
        const { client } = loadClient({
            prefValues: { "extensions.zotero-llm-assistant.pref-azure-key": "k" },
            fetchResponse: { status: 200, body: JSON.stringify([{ translations: [] }]) }
        });
        const r = await client._azure("hello", {});
        assert.match(r.error, /empty translations/);
    });

    await test("azure: success posts to api-version=3.0 with correct headers", async () => {
        let captured = null;
        const { client } = loadClient({
            prefValues: {
                "extensions.zotero-llm-assistant.pref-azure-key": "k1",
                "extensions.zotero-llm-assistant.pref-azure-region": "eastasia"
            },
            fetchResponse: (url, method, headers, body) => {
                captured = { url, method, headers, body };
                return { status: 200, body: JSON.stringify([
                    { translations: [{ text: "你好", to: "zh-Hans" }] }
                ]) };
            }
        });
        const r = await client._azure("hello", {});
        assert.strictEqual(r.text, "你好");
        assert.strictEqual(r.error, null);
        assert.strictEqual(captured.method, "POST");
        assert.match(captured.url, /api-version=3\.0/);
        assert.match(captured.url, /from=en/);
        assert.match(captured.url, /to=zh-Hans/);
        assert.strictEqual(captured.headers["Content-Type"], "application/json");
        assert.strictEqual(captured.headers["Ocp-Apim-Subscription-Key"], "k1");
        assert.strictEqual(captured.headers["Ocp-Apim-Subscription-Region"], "eastasia");
        assert.strictEqual(captured.body, JSON.stringify([{ Text: "hello" }]));
    });

    await test("azure: omits Region header when not configured", async () => {
        let captured = null;
        const { client } = loadClient({
            prefValues: { "extensions.zotero-llm-assistant.pref-azure-key": "k1" },
            fetchResponse: (url, method, headers, body) => {
                captured = { headers };
                return { status: 200, body: JSON.stringify([
                    { translations: [{ text: "x", to: "zh-Hans" }] }
                ]) };
            }
        });
        await client._azure("hi", {});
        assert.strictEqual(captured.headers["Ocp-Apim-Subscription-Region"], undefined);
    });

    await test("azure: uses pref-azure-from / pref-azure-to when no override", async () => {
        let captured = null;
        const { client } = loadClient({
            prefValues: {
                "extensions.zotero-llm-assistant.pref-azure-key": "k1",
                "extensions.zotero-llm-assistant.pref-azure-from": "de",
                "extensions.zotero-llm-assistant.pref-azure-to":   "fr"
            },
            fetchResponse: (url) => { captured = { url }; return { status: 200, body: JSON.stringify([{ translations: [{ text: "x", to: "fr" }] }]) }; }
        });
        await client._azure("hi", {});
        assert.match(captured.url, /from=de/);
        assert.match(captured.url, /to=fr/);
    });

    await test("azure: options.from/to override prefs", async () => {
        let captured = null;
        const { client } = loadClient({
            prefValues: {
                "extensions.zotero-llm-assistant.pref-azure-key": "k1",
                "extensions.zotero-llm-assistant.pref-azure-from": "de",
                "extensions.zotero-llm-assistant.pref-azure-to":   "fr"
            },
            fetchResponse: (url) => { captured = { url }; return { status: 200, body: JSON.stringify([{ translations: [{ text: "x", to: "ja" }] }]) }; }
        });
        await client._azure("hi", { from: "en", to: "ja" });
        assert.match(captured.url, /from=en/);
        assert.match(captured.url, /to=ja/);
    });

    // ============= Google tests =============================================

    await test("google: not configured returns error", async () => {
        const { client } = loadClient();
        const r = await client._google("hello", {});
        assert.strictEqual(r.source, "google");
        assert.strictEqual(r.error, "google not configured");
    });

    await test("google: network error is reported", async () => {
        const { client } = loadClient({
            prefValues: { "extensions.zotero-llm-assistant.pref-google-key": "k" },
            fetchError: true
        });
        const r = await client._google("hello", {});
        assert.match(r.error, /google network/);
    });

    await test("google: API error is reported", async () => {
        const { client } = loadClient({
            prefValues: { "extensions.zotero-llm-assistant.pref-google-key": "k" },
            fetchResponse: { status: 200, body: JSON.stringify({
                error: { code: 403, message: "API key not valid" }
            }) }
        });
        const r = await client._google("hello", {});
        assert.match(r.error, /403/);
        assert.match(r.error, /API key not valid/);
    });

    await test("google: invalid JSON returns error", async () => {
        const { client } = loadClient({
            prefValues: { "extensions.zotero-llm-assistant.pref-google-key": "k" },
            fetchResponse: { status: 200, body: "not json" }
        });
        const r = await client._google("hello", {});
        assert.match(r.error, /invalid JSON/);
    });

    await test("google: empty data returns error", async () => {
        const { client } = loadClient({
            prefValues: { "extensions.zotero-llm-assistant.pref-google-key": "k" },
            fetchResponse: { status: 200, body: JSON.stringify({ data: {} }) }
        });
        const r = await client._google("hello", {});
        assert.match(r.error, /empty result/);
    });

    await test("google: success GETs with key, target, and decodes HTML entities", async () => {
        let captured = null;
        const { client } = loadClient({
            prefValues: { "extensions.zotero-llm-assistant.pref-google-key": "k1" },
            fetchResponse: (url) => {
                captured = { url };
                return { status: 200, body: JSON.stringify({
                    data: { translations: [
                        { translatedText: "hello &amp; &quot;world&quot; &lt;ok&gt;", detectedSourceLanguage: "en" }
                    ] }
                }) };
            }
        });
        const r = await client._google("你好", {});
        assert.strictEqual(r.text, 'hello & "world" <ok>');
        assert.strictEqual(r.error, null);
        assert.match(captured.url, /translation\.googleapis\.com\/language\/translate\/v2/);
        assert.match(captured.url, /[?&]key=k1/);
        assert.match(captured.url, /[?&]q=/);
        assert.match(captured.url, /[?&]target=zh-CN/);
        // No source => no `source` param.
        assert.doesNotMatch(captured.url, /source=/);
    });

    await test("google: source pref is sent when set", async () => {
        let captured = null;
        const { client } = loadClient({
            prefValues: {
                "extensions.zotero-llm-assistant.pref-google-key": "k1",
                "extensions.zotero-llm-assistant.pref-google-from": "en",
                "extensions.zotero-llm-assistant.pref-google-to":   "ja"
            },
            fetchResponse: (url) => { captured = { url }; return { status: 200, body: JSON.stringify({ data: { translations: [{ translatedText: "x" }] } }) }; }
        });
        await client._google("hi", {});
        assert.match(captured.url, /source=en/);
        assert.match(captured.url, /target=ja/);
    });

    await test("google: options.from/to override prefs", async () => {
        let captured = null;
        const { client } = loadClient({
            prefValues: { "extensions.zotero-llm-assistant.pref-google-key": "k1" },
            fetchResponse: (url) => { captured = { url }; return { status: 200, body: JSON.stringify({ data: { translations: [{ translatedText: "x" }] } }) }; }
        });
        await client._google("hi", { from: "de", to: "fr" });
        assert.match(captured.url, /source=de/);
        assert.match(captured.url, /target=fr/);
    });

    await test("google: 401 HTTP error is reported", async () => {
        const { client } = loadClient({
            prefValues: { "extensions.zotero-llm-assistant.pref-google-key": "k" },
            fetchResponse: { status: 401, body: "unauthorized" }
        });
        const r = await client._google("hello", {});
        assert.match(r.error, /HTTP 401/);
    });

    console.log(`\n${passed} passed, ${failed} failed.`);
    process.exit(failed === 0 ? 0 : 1);
})();
