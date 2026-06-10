/*
    test-merge-logic.js
    --------------------
    Integration tests for the dual-engine merge logic in overlay.js's
    `translateAndAnnotate`. We don't need the real Zotero runtime — we
    reproduce the relevant merge + parse logic and exercise its branches.

    Run from /workspace:
        node scripts/test-merge-logic.js
*/

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

// ----- Load the source files we need ---------------------------------------

const TRAD = fs.readFileSync(
    path.join(__dirname, "..", "addon", "content", "traditionalClient.js"), "utf8"
);
const PB = fs.readFileSync(
    path.join(__dirname, "..", "addon", "content", "promptBuilder.js"), "utf8"
);

// ----- Mock environment -----------------------------------------------------

function makeEnv() {
    const env = {
        Zotero: {
            Prefs: { get: () => undefined },
            Utilities: { Internal: {} },
            LLMAssistant: {
                LLMClient: { getConfig: () => ({ language: "Chinese" }) }
            }
        },
        XMLHttpRequest: class { /* not used in these tests */ },
        URLSearchParams: URLSearchParams,
        Math,
        console
    };
    env.require = require;
    return env;
}

function loadSources(env) {
    const sandbox = { ...env, module: { exports: {} }, exports: {}, Promise };
    vm.createContext(sandbox);
    vm.runInContext(TRAD, sandbox);
    vm.runInContext(PB, sandbox);
    return sandbox;
}

// ----- Reproduced merge logic (mirrors overlay.js) --------------------------

/**
 * Replicates the body of overlay.js's `translateAndAnnotate` after both
 * promises have settled, and returns { annotationData, settled, traditionalData }.
 *
 * @param {Promise<any>} llmPromise
 * @param {Promise<{source,text,error}>} traditionalPromise
 * @param {string} trimmed
 * @param {object} sandbox  for accessing _parseLlmResponse if needed
 */
async function mergeResults(llmPromise, traditionalPromise, trimmed, sandbox) {
    const settled = await Promise.allSettled([llmPromise, traditionalPromise]);
    const llmResult = settled[0];
    const tradResult = settled[1];

    let annotationData = null;
    let traditionalData = null;

    if (llmResult.status === "fulfilled" && llmResult.value) {
        annotationData = sandbox._parseLlmResponse(llmResult.value, trimmed);
    }
    if (tradResult.status === "fulfilled" && tradResult.value && tradResult.value.text) {
        traditionalData = tradResult.value;
    }

    if (!annotationData && !traditionalData) {
        const err = (llmResult.status === "rejected" && llmResult.reason) || "translation failed";
        const e = new Error(typeof err === "string" ? err : (err.message || "translation failed"));
        e._settled = settled;
        throw e;
    }
    if (!annotationData) {
        annotationData = {
            type: trimmed.includes(" ") ? "phrase" : "word",
            original: trimmed,
            phonetic: "",
            partOfSpeech: "",
            translation: (traditionalData && traditionalData.text) || "",
            reasoning: "",
            examples: [],
        };
    }
    if (traditionalData) annotationData.traditional = traditionalData;
    return { annotationData, settled, traditionalData };
}

function _parseLlmResponse(result, fallbackOriginal) {
    let annotationData;
    try {
        const jsonMatch = String(result).match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            annotationData = JSON.parse(jsonMatch[0]);
        } else {
            annotationData = JSON.parse(result);
        }
    } catch {
        annotationData = {
            type: fallbackOriginal.includes(" ") ? "phrase" : "word",
            original: fallbackOriginal,
            phonetic: "",
            partOfSpeech: "",
            translation: String(result).trim(),
            reasoning: "",
            examples: [],
        };
    }
    annotationData.type        = annotationData.type        || (fallbackOriginal.includes(" ") ? "phrase" : "word");
    annotationData.original    = annotationData.original    || fallbackOriginal;
    annotationData.phonetic    = annotationData.phonetic    || "";
    annotationData.partOfSpeech = annotationData.partOfSpeech || "";
    annotationData.translation = annotationData.translation || "";
    annotationData.reasoning   = annotationData.reasoning   || "";
    annotationData.examples    = annotationData.examples    || [];
    return annotationData;
}

// Inject _parseLlmResponse into sandbox so mergeResults can call it.
function withParse(sandbox) {
    sandbox._parseLlmResponse = _parseLlmResponse;
    return sandbox;
}

// ----- Tests ----------------------------------------------------------------

let passed = 0, failed = 0;
function test(name, fn) {
    return Promise.resolve().then(() => fn()).then(() => {
        console.log(`  PASS  ${name}`); passed++;
    }).catch(e => {
        console.log(`  FAIL  ${name}\n    ${e.message}\n${e.stack}`); failed++;
    });
}

(async () => {
    console.log("Merge-logic tests:");

    const sandbox = withParse(loadSources(makeEnv()));
    const TC = sandbox.TraditionalClient;
    const PB2 = sandbox.PromptBuilder;

    // ============= _parseLlmResponse =======================================

    await test("parse: clean JSON string is parsed and normalized", () => {
        const out = _parseLlmResponse(JSON.stringify({
            type: "word", original: "bank", translation: "河岸",
            phonetic: "/bæŋk/", partOfSpeech: "n.", reasoning: "上下文是河",
            examples: [{ en: "on the bank", zh: "在河岸上" }]
        }), "bank");
        assert.strictEqual(out.type, "word");
        assert.strictEqual(out.translation, "河岸");
        assert.strictEqual(out.phonetic, "/bæŋk/");
        assert.deepStrictEqual(out.examples, [{ en: "on the bank", zh: "在河岸上" }]);
    });

    await test("parse: JSON embedded in prose is extracted", () => {
        const out = _parseLlmResponse(
            "Here is the answer: " + JSON.stringify({ translation: "你好" }) + " hope that helps.",
            "hello"
        );
        assert.strictEqual(out.translation, "你好");
    });

    await test("parse: non-JSON becomes plain translation fallback", () => {
        const out = _parseLlmResponse("hello means 你好", "hello");
        assert.strictEqual(out.translation, "hello means 你好");
        assert.strictEqual(out.original, "hello");
    });

    await test("parse: missing fields are filled in with sane defaults", () => {
        const out = _parseLlmResponse(JSON.stringify({ translation: "x" }), "word with space");
        assert.strictEqual(out.type, "phrase", "multi-word should default to phrase");
        assert.strictEqual(out.phonetic, "");
        assert.strictEqual(out.partOfSpeech, "");
        assert.strictEqual(out.reasoning, "");
    });

    await test("parse: missing translation field is empty string, not undefined", () => {
        const out = _parseLlmResponse(JSON.stringify({ type: "word" }), "abc");
        assert.strictEqual(out.translation, "");
    });

    // ============= Merge scenarios =========================================

    // 1) Both succeed.
    await test("merge: both LLM and traditional succeed → annotationData.traditional is set", async () => {
        const llmPromise = Promise.resolve(JSON.stringify({
            type: "word", original: "bank", translation: "河岸 (基于上下文)"
        }));
        const traditionalPromise = Promise.resolve({ source: "baidu", text: "银行", error: null });
        const r = await mergeResults(llmPromise, traditionalPromise, "bank", sandbox);
        assert.strictEqual(r.annotationData.translation, "河岸 (基于上下文)");
        assert.strictEqual(r.annotationData.traditional.text, "银行");
        assert.strictEqual(r.annotationData.traditional.source, "baidu");
    });

    // 2) Only LLM succeeds.
    await test("merge: only LLM succeeds → annotationData has no .traditional", async () => {
        const llmPromise = Promise.resolve(JSON.stringify({ translation: "你好" }));
        const traditionalPromise = Promise.resolve({ source: "baidu", text: null, error: "not configured" });
        const r = await mergeResults(llmPromise, traditionalPromise, "hello", sandbox);
        assert.strictEqual(r.annotationData.translation, "你好");
        assert.strictEqual(r.annotationData.traditional, undefined);
    });

    // 3) Only traditional succeeds.
    await test("merge: only traditional succeeds → annotationData synthesized with traditional text", async () => {
        const llmPromise = Promise.reject(new Error("LLM down"));
        const traditionalPromise = Promise.resolve({ source: "baidu", text: "你好", error: null });
        const r = await mergeResults(llmPromise, traditionalPromise, "hello", sandbox);
        assert.strictEqual(r.annotationData.translation, "你好");
        assert.strictEqual(r.annotationData.original, "hello");
        assert.strictEqual(r.annotationData.traditional.text, "你好");
        // Multi-word falls into 'phrase' default.
        assert.strictEqual(r.annotationData.type, "word");
    });

    await test("merge: only traditional for multi-word selects 'phrase' type", async () => {
        const llmPromise = Promise.reject(new Error("LLM down"));
        const traditionalPromise = Promise.resolve({ source: "baidu", text: "x", error: null });
        const r = await mergeResults(llmPromise, traditionalPromise, "kick the bucket", sandbox);
        assert.strictEqual(r.annotationData.type, "phrase");
    });

    // 4) Both fail.
    await test("merge: both fail → throws", async () => {
        const llmPromise = Promise.reject(new Error("LLM down"));
        const traditionalPromise = Promise.resolve({ source: "baidu", text: null, error: "baidu not configured" });
        let threw = false;
        try {
            await mergeResults(llmPromise, traditionalPromise, "x", sandbox);
        } catch (e) {
            threw = true;
            assert.match(e.message, /LLM down/);
        }
        assert.ok(threw, "should have thrown");
    });

    await test("merge: both reject → throws the LLM error message", async () => {
        const llmPromise = Promise.reject(new Error("network"));
        const traditionalPromise = Promise.reject(new Error("baidu down"));
        let threw = false;
        try { await mergeResults(llmPromise, traditionalPromise, "x", sandbox); }
        catch (e) { threw = true; assert.match(e.message, /network/); }
        assert.ok(threw);
    });

    // 5) LLM slow, traditional fast — both eventually merged.
    await test("merge: traditional finishes before LLM; both end up in result", async () => {
        const llmPromise = new Promise(r => setTimeout(() => r(JSON.stringify({ translation: "LLM" })), 30));
        const traditionalPromise = new Promise(r => setTimeout(() => r({ source: "baidu", text: "Trad", error: null }), 5));
        const r = await mergeResults(llmPromise, traditionalPromise, "x", sandbox);
        assert.strictEqual(r.annotationData.translation, "LLM");
        assert.strictEqual(r.annotationData.traditional.text, "Trad");
    });

    // 6) traditional text can be null but LLM success still wins.
    await test("merge: traditional text is null (e.g. not configured) is dropped — only useful text is attached", async () => {
        const llmPromise = Promise.resolve(JSON.stringify({ translation: "A" }));
        const traditionalPromise = Promise.resolve({ source: "baidu", text: null, error: "401" });
        const r = await mergeResults(llmPromise, traditionalPromise, "x", sandbox);
        assert.strictEqual(r.annotationData.translation, "A");
        // Empty/error results are dropped, so .traditional is not attached.
        assert.strictEqual(r.annotationData.traditional, undefined);
    });

    // 7) LLM with structured example array is preserved.
    await test("merge: LLM examples survive merge", async () => {
        const llmPromise = Promise.resolve(JSON.stringify({
            translation: "河岸",
            examples: [{ en: "river bank", zh: "河岸" }]
        }));
        const traditionalPromise = Promise.resolve({ source: "baidu", text: "银行", error: null });
        const r = await mergeResults(llmPromise, traditionalPromise, "bank", sandbox);
        assert.deepStrictEqual(r.annotationData.examples, [{ en: "river bank", zh: "河岸" }]);
    });

    // 8) Traditional is integrated with the actual TraditionalClient stub.
    await test("integration: real TraditionalClient.translate('hello') without prefs returns 'baidu not configured'", async () => {
        const r = await TC.translate("hello");
        assert.strictEqual(r.source, "baidu");
        assert.match(r.error, /not configured/);
    });

    // 9) Real TraditionalClient error path can be wrapped in Promise.allSettled.
    await test("integration: TraditionalClient rejection does not propagate to allSettled", async () => {
        const tradP = TC.translate(""); // empty input → returns {error:'empty input'}, does not reject
        const llmP = Promise.resolve(JSON.stringify({ translation: "x" }));
        const settled = await Promise.allSettled([llmP, tradP]);
        assert.strictEqual(settled[0].status, "fulfilled");
        assert.strictEqual(settled[1].status, "fulfilled");
    });

    // 10) PromptBuilder is usable in the mock sandbox (smoke).
    await test("integration: PromptBuilder.buildContextAwareTranslatePrompt returns non-empty string", () => {
        // PromptBuilder is exposed on Zotero.LLMAssistant.PromptBuilder, not
        // as a top-level var. We just reach in via the sandbox.
        const PB2 = sandbox.Zotero && sandbox.Zotero.LLMAssistant && sandbox.Zotero.LLMAssistant.PromptBuilder;
        assert.ok(PB2, "PromptBuilder should be exposed on Zotero.LLMAssistant");
        const prompt = PB2.buildContextAwareTranslatePrompt({
            selected: "bank",
            sentence: "He sat on the bank.",
            surrounding: "Fishing is a calm activity. He sat on the bank.",
            fullText: "Long paper about rivers..."
        });
        assert.ok(typeof prompt === "string" && prompt.length > 50);
        assert.match(prompt, /bank/);
    });

    console.log(`\n${passed} passed, ${failed} failed.`);
    process.exit(failed === 0 ? 0 : 1);
})();
