// Unit test for _wrapTranslationAsClickableWords
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// Set up minimal sandbox
const sandbox = {
  Zotero: { debug: () => {}, logError: console.error },
  Services: {},
  console,
  String, Object, Array, JSON, RegExp, Math, Number, Boolean, Error,
  Function, Date, Map, Set, Promise,
  XMLHttpRequest: function () {},
  Components: { classes: {}, interfaces: {} },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

// Load uiManager.js
const code = fs.readFileSync(
  path.join(__dirname, "..", "addon", "uiManager.js"),
  "utf-8"
);
vm.runInContext(code, sandbox);

const UIM = sandbox.Zotero.LLMAssistant.UIManager;
const wrap = UIM._wrapTranslationAsClickableWords.bind(UIM);

function countWords(html) {
  return (html.match(/class="zotero-llm-translation-word"/g) || []).length;
}

function check(name, fn) {
  try {
    fn();
    console.log("  ✓", name);
  } catch (e) {
    console.error("  ✗", name, "-", e.message);
    process.exitCode = 1;
  }
}

console.log("=== _wrapTranslationAsClickableWords tests ===");

check("Chinese: each character is a separate word", () => {
  const out = wrap("学习任务");
  if (countWords(out) !== 4) throw new Error(`expected 4 words, got ${countWords(out)}: ${out}`);
  if (!out.includes('data-word="学"')) throw new Error("missing 学");
});

check("English: each whitespace-separated token is a word", () => {
  const out = wrap("machine learning model");
  if (countWords(out) !== 3) throw new Error(`expected 3 words, got ${countWords(out)}`);
  if (!out.includes('data-word="machine"')) throw new Error("missing machine");
});

check("Empty string returns empty", () => {
  const out = wrap("");
  if (out !== "") throw new Error(`expected empty, got "${out}"`);
});

check("HTML escape is applied", () => {
  const out = wrap("<script>");
  if (out.includes("<script>")) throw new Error("HTML not escaped!");
  if (!out.includes("&lt;script&gt;")) throw new Error("missing escape");
});

check("Mixed: Chinese with English keeps CJK as chars and English as words", () => {
  const out = wrap("使用 GPT 模型");
  // 2 Chinese chars (使,用) + 1 English word (GPT) + 2 Chinese chars (模,型) = 5
  if (countWords(out) !== 5) throw new Error(`expected 5, got ${countWords(out)}: ${out}`);
});

check("Punctuation is not wrapped", () => {
  const out = wrap("hello, world");
  if (countWords(out) !== 2) throw new Error(`expected 2 words, got ${countWords(out)}`);
});

if (process.exitCode) {
  console.log("\nFAILED");
  process.exit(1);
}
console.log("\nAll unit tests passed.");
