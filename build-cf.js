const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const PUBLIC_ASSETS_DIR = path.join(PUBLIC_DIR, "assets");

if (!fs.existsSync(PUBLIC_DIR)) {
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });
}
if (!fs.existsSync(PUBLIC_ASSETS_DIR)) {
  fs.mkdirSync(PUBLIC_ASSETS_DIR, { recursive: true });
}

const staticFiles = ["index.html", "styles.css", "app.js"];
for (const file of staticFiles) {
  const src = path.join(ROOT, file);
  const dest = path.join(PUBLIC_DIR, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
  }
}

const assetsSrcDir = path.join(ROOT, "assets");
if (fs.existsSync(assetsSrcDir)) {
  for (const item of fs.readdirSync(assetsSrcDir)) {
    const srcPath = path.join(assetsSrcDir, item);
    const destPath = path.join(PUBLIC_ASSETS_DIR, item);
    if (fs.statSync(srcPath).isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

console.log("Static files prepared in ./public for Cloudflare deployment.");
