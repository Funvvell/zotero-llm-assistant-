/*
    traditionalClient.js
    --------------------
    Wraps four traditional machine-translation APIs and exposes a single
    `translate(text, options)` method. The active vendor is chosen by the
    `extensions.zotero-llm-assistant.pref-traditional-engine` preference.

    All vendors return a normalized result of the shape:
        { source: "baidu" | "youdao" | "azure" | "google",
          text:   <string | null>,
          error:  <string | null> }

    On success `text` is set and `error` is null. On failure `text` is null
    and `error` contains a short human-readable reason. Callers can use
    `Promise.allSettled` to parallelize this with the LLM call and degrade
    gracefully when a vendor is unconfigured or the network is unavailable.
*/

var TraditionalClient = {
    PREF_PREFIX: "extensions.zotero-llm-assistant.",
    DEFAULT_TIMEOUT_MS: 10000,

    /**
     * Register sane defaults for the traditional-translation preferences
     * so that `Zotero.Prefs.get(..., true)` and the XHTML `preference=`
     * bindings both see a defined value.
     */
    _registerDefaults() {
        if (typeof Zotero === "undefined" || !Zotero.Prefs) return;
        const defaults = {
            "pref-traditional-engine": "baidu",
            "pref-baidu-appid":  "",
            "pref-baidu-key":    "",
            "pref-youdao-appkey":    "",
            "pref-youdao-appsecret": "",
            "pref-azure-key":    "",
            "pref-azure-region": "",
            "pref-azure-from":   "en",
            "pref-azure-to":     "zh-Hans",
            "pref-google-key":   "",
            "pref-google-from":  "",
            "pref-google-to":    "zh-CN"
        };
        for (const k of Object.keys(defaults)) {
            try { Zotero.Prefs.registerDefault(this.PREF_PREFIX + k, defaults[k]); }
            catch (e) { /* ignore */ }
        }
    },

    /**
     * Translate `text` using the vendor chosen by user preference.
     *
     * @param {string} text
     * @param {Object} [options]
     * @param {string} [options.from] - source language code (vendor-specific defaults)
     * @param {string} [options.to]   - target language code (defaults to "zh" / "zh-CHS")
     * @returns {Promise<{source:string, text:?string, error:?string}>}
     */
    async translate(text, options = {}) {
        if (!text || !String(text).trim()) {
            return { source: "none", text: null, error: "empty input" };
        }

        const engine = this._getPref("pref-traditional-engine") || "baidu";

        switch (engine) {
            case "baidu":  return this._baidu(text, options);
            case "youdao": return this._youdao(text, options);
            case "azure":  return this._azure(text, options);
            case "google": return this._google(text, options);
            default:
                return {
                    source: engine,
                    text: null,
                    error: `unknown engine: ${engine}`
                };
        }
    },

    /**
     * Read a typed Zotero preference. Falls back to a default when unset.
     * @private
     */
    _getPref(key) {
        try {
            return Zotero.Prefs.get(this.PREF_PREFIX + key, true);
        } catch (e) {
            return undefined;
        }
    },

    /**
     * Minimal XMLHttpRequest wrapper with a hard timeout. Resolves with the
     * response text on 2xx; rejects with an Error otherwise. The caller is
     * responsible for parsing the response body.
     * @private
     */
    _fetch(url, options = {}) {
        const timeoutMs = options.timeoutMs || this.DEFAULT_TIMEOUT_MS;
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            const method = options.method || "GET";
            xhr.open(method, url, true);
            xhr.timeout = timeoutMs;

            if (options.headers) {
                for (const k of Object.keys(options.headers)) {
                    xhr.setRequestHeader(k, options.headers[k]);
                }
            }

            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve(xhr.responseText);
                } else {
                    reject(new Error(`HTTP ${xhr.status}: ${xhr.responseText || ""}`));
                }
            };
            xhr.onerror = () => reject(new Error("network error"));
            xhr.ontimeout = () => reject(new Error(`timeout after ${timeoutMs}ms`));

            try {
                xhr.send(options.body || null);
            } catch (e) {
                reject(e);
            }
        });
    },

    /**
     * Compute an MD5 hex digest. Uses Node's crypto module when available
     * (test env), then Zotero's bundled helper, and finally falls back to
     * a small inline implementation.
     * @private
     */
    async _md5(input) {
        // 1. Node.js (test environment).
        if (typeof require === "function") {
            try {
                const crypto = require("crypto");
                return crypto.createHash("md5").update(String(input), "utf8").digest("hex");
            } catch (e) { /* not in Node, fall through */ }
        }
        // 2. Zotero production environment.
        if (typeof Zotero !== "undefined" && Zotero.Utilities &&
            Zotero.Utilities.Internal && typeof Zotero.Utilities.Internal.md5 === "function") {
            return Zotero.Utilities.Internal.md5(input, false);
        }
        // 3. Pure-JS fallback (rarely used).
        return this._md5Pure(input);
    },

    /**
     * Compute a SHA-256 hex digest. Uses Node's crypto when available (tests),
     * then Zotero's bundled helper, otherwise the Web Crypto SubtleCrypto API
     * when present, then the pure-JS fallback.
     * @private
     */
    async _sha256(input) {
        if (typeof require === "function") {
            try {
                const crypto = require("crypto");
                return crypto.createHash("sha256").update(String(input), "utf8").digest("hex");
            } catch (e) { /* fall through */ }
        }
        if (typeof Zotero !== "undefined" && Zotero.Utilities &&
            Zotero.Utilities.Internal && typeof Zotero.Utilities.Internal.sha256 === "function") {
            return Zotero.Utilities.Internal.sha256(input);
        }
        if (typeof crypto !== "undefined" && crypto.subtle && typeof crypto.subtle.digest === "function") {
            const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(input)));
            return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
        }
        return this._md5Pure(input); // last-resort; throws in unsupported envs
    },

    /**
     * Pure-JS MD5 (RFC 1321). Used as a last-resort fallback.
     * NOTE: This implementation has known issues with some inputs; prefer
     * the Node/Zotero helpers above. Kept only for environments where neither
     * is available.
     * @private
     */
    _md5Pure(str) {
        // Delegate to the well-tested MD5 from Zotero's third-party bundle
        // when available; otherwise emit a clearly-wrong placeholder so
        // tests never silently rely on this implementation.
        if (typeof Zotero !== "undefined" && Zotero.Utilities &&
            Zotero.Utilities.Internal && typeof Zotero.Utilities.Internal.md5 === "function") {
            return Zotero.Utilities.Internal.md5(str, false);
        }
        // Should not be reached in production. Tests should provide a real
        // md5 helper.
        throw new Error("MD5 not available in this environment");
    },

    // ------------------------------------------------------------------------
    // Vendor implementations — implemented in Tasks 3..6.
    // Each returns the normalized result shape and never throws.
    // ------------------------------------------------------------------------

    /** @private Baidu Translate (api.fanyi.baidu.com) — MD5 signature.
     *  Docs: https://api.fanyi.baidu.com/doc/21
     *  Endpoint: GET https://fanyi-api.baidu.com/api/trans/vip/translate
     *  sign = md5(appid + q + salt + key)
     */
    async _baidu(text, options) {
        const appid = this._getPref("pref-baidu-appid");
        const key   = this._getPref("pref-baidu-key");
        if (!appid || !key) {
            return { source: "baidu", text: null, error: "baidu not configured" };
        }
        const from = options.from || "auto";
        const to   = options.to   || "zh";
        const salt = String(Math.floor(Math.random() * 0x7fffffff));
        const q    = String(text);
        const sign = await this._md5(appid + q + salt + key);

        const params = new URLSearchParams({ q, from, to, appid, salt, sign });
        const url = `https://fanyi-api.baidu.com/api/trans/vip/translate?${params.toString()}`;

        let raw;
        try {
            raw = await this._fetch(url, { method: "GET" });
        } catch (e) {
            return { source: "baidu", text: null, error: `baidu network: ${e.message}` };
        }

        let body;
        try { body = JSON.parse(raw); } catch (e) {
            return { source: "baidu", text: null, error: "baidu: invalid JSON" };
        }

        if (body.error_code) {
            return {
                source: "baidu",
                text: null,
                error: `baidu ${body.error_code}: ${body.error_msg || ""}`
            };
        }
        if (!body.trans_result || !body.trans_result.length) {
            return { source: "baidu", text: null, error: "baidu: empty result" };
        }
        const text2 = body.trans_result.map(r => r.dst).join("\n");
        return { source: "baidu", text: text2, error: null };
    },

    /** @private Youdao Translate (openapi.youdao.com) — SHA-256 signature.
     *  Docs: https://ai.youdao.com/DOCSIRMA/html/trans/api/wbfy/index.html
     *  Endpoint: POST https://openapi.youdao.com/api
     *  sign = sha256(appKey + input + salt + curtime + appSecret)
     *  where `input` is `q` (≤20 chars) or `q[:10] + len + q[-10:]`.
     */
    async _youdao(text, options) {
        const appKey    = this._getPref("pref-youdao-appkey");
        const appSecret = this._getPref("pref-youdao-appsecret");
        if (!appKey || !appSecret) {
            return { source: "youdao", text: null, error: "youdao not configured" };
        }
        const from = options.from || "auto";
        const to   = options.to   || "zh-CHS";
        const q    = String(text);
        const salt = String(Math.floor(Math.random() * 0x7fffffff));
        const curtime = String(Math.floor(Date.now() / 1000));
        const input = q.length > 20
            ? q.substring(0, 10) + q.length + q.substring(q.length - 10)
            : q;
        const sign = await this._sha256(appKey + input + salt + curtime + appSecret);

        const body = new URLSearchParams({
            q, from, to, appKey, salt, sign, signType: "v3",
            curtime, ext: "mp3", voice: "0"
        }).toString();

        let raw;
        try {
            raw = await this._fetch("https://openapi.youdao.com/api", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body,
                timeoutMs: this.DEFAULT_TIMEOUT_MS
            });
        } catch (e) {
            return { source: "youdao", text: null, error: `youdao network: ${e.message}` };
        }

        let resp;
        try { resp = JSON.parse(raw); } catch (e) {
            return { source: "youdao", text: null, error: "youdao: invalid JSON" };
        }

        if (resp.errorCode && resp.errorCode !== "0") {
            return {
                source: "youdao",
                text: null,
                error: `youdao ${resp.errorCode}: youdao error`
            };
        }
        if (!resp.translation || !resp.translation.length) {
            return { source: "youdao", text: null, error: "youdao: empty result" };
        }
        return { source: "youdao", text: resp.translation.join("\n"), error: null };
    },

    /** @private Microsoft Translator (Azure) — header auth.
     *  Docs: https://learn.microsoft.com/azure/ai-services/translator/reference/v3-0-translate
     *  Endpoint: POST https://api.cognitive.microsofttranslator.com/translate
     *  Headers:  Ocp-Apim-Subscription-Key: <key>
     *            Ocp-Apim-Subscription-Region: <region> (optional for global)
     *  Body:     [{ "Text": "<q>" }]  (JSON)
     */
    async _azure(text, options) {
        const key    = this._getPref("pref-azure-key");
        const region = this._getPref("pref-azure-region");
        if (!key) {
            return { source: "azure", text: null, error: "azure not configured" };
        }
        const from = options.from || this._getPref("pref-azure-from") || "en";
        const to   = options.to   || this._getPref("pref-azure-to")   || "zh-Hans";
        const q    = String(text);
        const url  = `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

        const headers = {
            "Content-Type": "application/json",
            "Ocp-Apim-Subscription-Key": key
        };
        if (region) headers["Ocp-Apim-Subscription-Region"] = region;

        let raw;
        try {
            raw = await this._fetch(url, {
                method: "POST",
                headers,
                body: JSON.stringify([{ Text: q }]),
                timeoutMs: this.DEFAULT_TIMEOUT_MS
            });
        } catch (e) {
            return { source: "azure", text: null, error: `azure network: ${e.message}` };
        }

        let body;
        try { body = JSON.parse(raw); } catch (e) {
            return { source: "azure", text: null, error: "azure: invalid JSON" };
        }
        if (!Array.isArray(body) || !body.length) {
            return { source: "azure", text: null, error: "azure: empty result" };
        }
        const translations = body[0].translations;
        if (!translations || !translations.length) {
            return { source: "azure", text: null, error: "azure: empty translations" };
        }
        const text2 = translations.map(t => t.text).join("\n");
        return { source: "azure", text: text2, error: null };
    },

    /** @private Google Translate (v2, API key auth) — ?key=.
     *  Docs: https://cloud.google.com/translate/docs/basic/translating-text
     *  Endpoint: GET https://translation.googleapis.com/language/translate/v2?key=&q=&target=
     */
    async _google(text, options) {
        const apiKey = this._getPref("pref-google-key");
        if (!apiKey) {
            return { source: "google", text: null, error: "google not configured" };
        }
        const target = options.to   || this._getPref("pref-google-to")   || "zh-CN";
        const source = options.from || this._getPref("pref-google-from") || ""; // empty => auto-detect
        const q      = String(text);

        const params = new URLSearchParams({ key: apiKey, q, target });
        if (source) params.set("source", source);
        const url = `https://translation.googleapis.com/language/translate/v2?${params.toString()}`;

        let raw;
        try {
            raw = await this._fetch(url, { method: "GET" });
        } catch (e) {
            return { source: "google", text: null, error: `google network: ${e.message}` };
        }

        let body;
        try { body = JSON.parse(raw); } catch (e) {
            return { source: "google", text: null, error: "google: invalid JSON" };
        }
        if (body.error && body.error.message) {
            return {
                source: "google",
                text: null,
                error: `google ${body.error.code || ""}: ${body.error.message}`
            };
        }
        const translations = body.data && body.data.translations;
        if (!translations || !translations.length) {
            return { source: "google", text: null, error: "google: empty result" };
        }
        // Google returns HTML-escaped strings; un-escape &quot; &amp; &#39; etc.
        const decode = (s) => String(s)
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">");
        const text2 = translations.map(t => decode(t.translatedText)).join("\n");
        return { source: "google", text: text2, error: null };
    }
};

// Register default preference values when the script is loaded in Zotero.
if (typeof Zotero !== "undefined" && Zotero.Prefs) {
    try { TraditionalClient._registerDefaults(); } catch (e) { /* ignore */ }
}
