/**
 * Build script for Zotero LLM Assistant plugin
 * Zotero 7 format: only manifest.json + bootstrap.js, no install.rdf or chrome.manifest
 * Creates a .xpi file that can be installed in Zotero 7
 */

const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.join(__dirname, "..");
const ADDON_DIR = path.join(ROOT_DIR, "addon");
const BUILD_DIR = path.join(ROOT_DIR, "build");
const DIST_DIR = path.join(ROOT_DIR, "dist");

// Read metadata from the authoritative Zotero 7 source: addon/manifest.json
const MANIFEST = JSON.parse(
  fs.readFileSync(path.join(ADDON_DIR, "manifest.json"), "utf-8")
);

const ADDON_ID = MANIFEST.applications.zotero.id;        // llm-assistant@example.com
const ADDON_NAME = "zotero-llm-assistant";              // used as .xpi filename prefix
const VERSION = MANIFEST.version;

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
  // If the addon ships real icons, copyAddonFiles() already copied them
  // into BUILD_DIR/content/icons/, so there is nothing to do.
  const realIcons = path.join(ADDON_DIR, "content", "icons");
  if (fs.existsSync(realIcons)) {
    const files = fs.readdirSync(realIcons).filter((f) => f.startsWith("icon@") && f.endsWith(".png"));
    if (files.length > 0) {
      console.log(`  using real icons from ${realIcons} (${files.join(", ")})`);
      return;
    }
  }

  // Fallback: write a 1x1 transparent PNG so the .xpi still has an icons/
  // entry — Zotero's plugin manager will at least not complain on install.
  console.log("  no real icons in addon/content/icons/, writing 1x1 placeholder");
  ensureDir(path.join(BUILD_DIR, "content", "icons"));
  const placeholderPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64"
  );
  fs.writeFileSync(path.join(BUILD_DIR, "content", "icons", "icon@48.png"), placeholderPng);
  fs.writeFileSync(path.join(BUILD_DIR, "content", "icons", "icon@96.png"), placeholderPng);
}

function copyAddonFiles() {
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
}

function build() {
  console.log(`Building ${ADDON_NAME} v${VERSION} (${ADDON_ID})...`);

  copyAddonFiles();

  // Try to use archiver if available
  let archiver;
  try {
    archiver = require("archiver");
  } catch {
    archiver = null;
  }

  if (!archiver) {
    console.log("archiver not found, build directory left at:", BUILD_DIR);
    console.log(`To create .xpi, run: cd build && zip -r ../dist/${ADDON_NAME}-${VERSION}.xpi .`);
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

try {
  require("archiver");
  build();
} catch {
  // No archiver installed locally - just produce the build directory;
  // the CI workflow installs zip and packs it itself.
  console.log("Building without archiver (CI will zip build/ into the .xpi)...");
  copyAddonFiles();
  console.log(`Build directory created: ${BUILD_DIR}`);
  console.log(`To create .xpi file, run: cd build && zip -r ../dist/${ADDON_NAME}-${VERSION}.xpi .`);
}
