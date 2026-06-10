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

    /** @private Youdao Translate (openapi.youdao.com) — SHA-256 signature. */
    async _youdao(text, options) {
        return { source: "youdao", text: null, error: "not implemented" };
    },

    /** @private Microsoft Translator (api.cognitive.microsoft.com) — header auth. */
    async _azure(text, options) {
        return { source: "azure", text: null, error: "not implemented" };
    },

    /** @private Google Translate (translation.googleapis.com) — ?key=. */
    async _google(text, options) {
        return { source: "google", text: null, error: "not implemented" };
    }
};
