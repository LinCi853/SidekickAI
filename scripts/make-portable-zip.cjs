// scripts/make-portable-zip.cjs
// 将 dist-portable/win-unpacked 重命名为 SidekickAI 后压缩为 zip
// 解压后文件夹名即为 SidekickAI，数据存 exe 同级 data/ 目录

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const pkg = require('../package.json');
const ver = pkg.version;

const srcDir = path.join(__dirname, '..', 'dist-portable', 'win-unpacked');
const dstDir = path.join(__dirname, '..', 'dist-portable', 'SidekickAI');
const zipName = `SidekickAI-Portable-v${ver}-win-x64.zip`;
const zipPath = path.join(__dirname, '..', 'dist-portable', zipName);

if (!fs.existsSync(srcDir)) {
  console.error(`[zip] Source not found: ${srcDir}`);
  process.exit(1);
}

// 清理旧的临时目录和 zip
if (fs.existsSync(dstDir)) {
  fs.rmSync(dstDir, { recursive: true, force: true });
}
if (fs.existsSync(zipPath)) {
  fs.unlinkSync(zipPath);
}

// 复制 win-unpacked → SidekickAI（这样解压后文件夹名是 SidekickAI）
console.log(`[zip] Copying ${srcDir} → ${dstDir} ...`);
fs.cpSync(srcDir, dstDir, { recursive: true });

// 压缩
console.log(`[zip] Compressing → ${zipName} ...`);
if (process.platform === 'win32') {
  execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${dstDir}' -DestinationPath '${zipPath}'"`, { stdio: 'inherit' });
} else {
  // macOS/Linux 用 zip 命令
  const parent = path.dirname(dstDir);
  const baseName = path.basename(dstDir);
  execSync(`cd "${parent}" && zip -r "${zipName}" "${baseName}"`, { stdio: 'inherit' });
}

// 清理临时目录
fs.rmSync(dstDir, { recursive: true, force: true });

const sizeMB = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1);
console.log(`[zip] Done: ${zipName} (${sizeMB} MB)`);
