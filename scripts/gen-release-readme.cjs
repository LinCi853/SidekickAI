// scripts/gen-release-readme.cjs
// 在 release/ 目录生成 README.txt（版本说明 + 快捷键速查）
// 用法：node scripts/gen-release-readme.cjs

const fs = require('fs');
const path = require('path');
const pkg = require('../package.json');

const ver = pkg.version;
const date = new Date().toLocaleString('zh-CN', {
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit'
});

const releaseDir = path.join(__dirname, '..', 'release');
if (!fs.existsSync(releaseDir)) {
  console.error('release/ directory not found. Build first.');
  process.exit(1);
}

const files = fs.readdirSync(releaseDir);
const exes = files.filter(f => /\.exe$/i.test(f) && !/elevate|uninstall/i.test(f));
const zips = files.filter(f => /\.zip$/i.test(f));

const exeName = exes[0] || '（未找到）';
const zipName = zips[0] || '（未找到）';

const readme = `SidekickAI v${ver}
========================================

发布日期：${date}
系统要求：Windows 10 1903 及以上

--- 安装版 ---
${exeName}
双击运行安装程序，按向导完成安装。
默认关闭行为：最小化到托盘（可通过设置修改）。

--- 便携版 ---
${zipName}
解压后运行 exe，数据存储在同级 data\\ 目录。
默认关闭行为：直接关闭（可通过设置修改）。

--- 快捷键 ---
Alt+Space    主窗口呼出/隐藏
Alt+Q        划词提问
Alt+V        后台语音输入
Alt+Shift+P  置顶切换
Alt+Shift+M  静音切换
F11          最大化
F12          置顶切换
`;

fs.writeFileSync(path.join(releaseDir, 'README.txt'), readme, 'utf8');
console.log(`  README.txt generated for v${ver}`);
