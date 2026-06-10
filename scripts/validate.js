// Manifest validation
const fs = require("fs");
const path = require("path");

const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "addon", "manifest.json"), "utf-8")
);

const errors = [];
const warnings = [];

// Required fields
if (manifest.manifest_version !== 2) errors.push("manifest_version must be 2");
if (!manifest.name) errors.push("name is required");
if (!manifest.version) errors.push("version is required");
if (!manifest.applications) errors.push("applications is required");
if (!manifest.applications?.zotero) errors.push("applications.zotero is required (CRITICAL for Zotero 7)");
if (!manifest.applications?.zotero?.id) errors.push("applications.zotero.id is required");
if (!manifest.applications?.zotero?.strict_min_version) warnings.push("strict_min_version is recommended");
if (!manifest.applications?.zotero?.strict_max_version) warnings.push("strict_max_version is recommended");

// ID format check
if (manifest.applications?.zotero?.id && !manifest.applications.zotero.id.includes("@")) {
  errors.push("id should be in email format (e.g. plugin@domain.com)");
}

// Version format
if (manifest.version && !/^\d+\.\d+(\.\d+)?$/.test(manifest.version)) {
  errors.push(`version format invalid: ${manifest.version}`);
}

console.log("=== manifest.json validation ===");
console.log("manifest_version:", manifest.manifest_version, manifest.manifest_version === 2 ? "✓" : "✗");
console.log("name:", manifest.name, manifest.name ? "✓" : "✗");
console.log("version:", manifest.version, manifest.version ? "✓" : "✗");
console.log("applications.zotero.id:", manifest.applications?.zotero?.id, manifest.applications?.zotero?.id ? "✓" : "✗");
console.log("strict_min_version:", manifest.applications?.zotero?.strict_min_version, manifest.applications?.zotero?.strict_min_version ? "✓" : "⚠");
console.log("strict_max_version:", manifest.applications?.zotero?.strict_max_version, manifest.applications?.zotero?.strict_max_version ? "✓" : "⚠");
console.log("update_url:", manifest.applications?.zotero?.update_url || "(none)");

console.log("\n=== Errors ===");
if (errors.length === 0) console.log("NONE ✓");
else errors.forEach(e => console.log("  ✗", e));

console.log("\n=== Warnings ===");
if (warnings.length === 0) console.log("NONE");
else warnings.forEach(w => console.log("  ⚠", w));

process.exit(errors.length > 0 ? 1 : 0);
