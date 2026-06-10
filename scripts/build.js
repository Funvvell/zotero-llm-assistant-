/**
 * Build script for Zotero LLM Assistant plugin
 * Zotero 7 format: only manifest.json + bootstrap.js, no install.rdf or chrome.manifest
 * Creates a .xpi file that can be installed in Zotero 7
 */

const fs = require("fs");
const path = require("path");

const ADDON_DIR = path.join(__dirname, "..", "addon");
const BUILD_DIR = path.join(__dirname, "..", "build");
const DIST_DIR = path.join(__dirname, "..", "dist");

const PACKAGE_JSON = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8")
);

const ADDON_ID = PACKAGE_JSON.config.addonID;
const ADDON_NAME = PACKAGE_JSON.config.addonRef;
const VERSION = PACKAGE_JSON.version;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function copyRecursive(src, dest, exclude = []) {
  const stats = fs.statSync(src);
  if (stats.isDirectory()) {
    ensureDir(dest);
    const entries = fs.readdirSync(src);
    for (const entry of entries) {
      if (exclude.includes(entry)) continue;
      copyRecursive(path.join(src, entry), path.join(dest, entry), exclude);
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

function copyBuildAssets() {
  // Create placeholder icon
  ensureDir(path.join(BUILD_DIR, "content", "icons"));
  const placeholderPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64"
  );
  fs.writeFileSync(path.join(BUILD_DIR, "content", "icons", "icon@48.png"), placeholderPng);
  fs.writeFileSync(path.join(BUILD_DIR, "content", "icons", "icon@96.png"), placeholderPng);
}

function build() {
  console.log(`Building ${ADDON_NAME} v${VERSION}...`);

  // Clean build directory
  if (fs.existsSync(BUILD_DIR)) {
    fs.rmSync(BUILD_DIR, { recursive: true });
  }
  ensureDir(BUILD_DIR);
  ensureDir(DIST_DIR);

  // Copy addon files to build directory
  // Exclude overlay.xul (Zotero 7 doesn't use XUL overlays)
  copyRecursive(ADDON_DIR, BUILD_DIR, ["overlay.xul"]);

  // Copy build assets
  copyBuildAssets();

  // Create XPI (ZIP) file
  let archiver;
  try {
    archiver = require("archiver");
  } catch {
    archiver = null;
  }

  if (!archiver) {
    console.log("archiver not found, creating uncompressed build directory instead.");
    console.log(`Build complete: ${BUILD_DIR}`);
    console.log("To create .xpi, run: cd build && zip -r ../dist/zotero-llm-assistant-1.0.0.xpi .");
    return;
  }

  const xpiPath = path.join(DIST_DIR, `${ADDON_NAME}-${VERSION}.xpi`);
  const output = fs.createWriteStream(xpiPath);
  const archive = archiver("zip", { zlib: { level: 9 } });

  output.on("close", () => {
    console.log(`Build complete: ${xpiPath}`);
    console.log(`Size: ${(archive.pointer() / 1024).toFixed(1)} KB`);
  });

  archive.on("error", (err) => {
    throw err;
  });

  archive.pipe(output);
  archive.directory(BUILD_DIR, false);
  archive.finalize();
}

// Try to use archiver if available, otherwise just copy files
try {
  require("archiver");
  build();
} catch {
  // No archiver - just do the file copy part
  console.log("Building without archiver (no .xpi compression)...");

  if (fs.existsSync(BUILD_DIR)) {
    fs.rmSync(BUILD_DIR, { recursive: true });
  }
  ensureDir(BUILD_DIR);
  ensureDir(DIST_DIR);

  copyRecursive(ADDON_DIR, BUILD_DIR, ["overlay.xul"]);
  copyBuildAssets();

  console.log(`Build directory created: ${BUILD_DIR}`);
  console.log("To create .xpi file, run: cd build && zip -r ../dist/zotero-llm-assistant-1.0.0.xpi .");
}
