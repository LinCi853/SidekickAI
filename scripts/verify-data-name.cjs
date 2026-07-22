#!/usr/bin/env node
/**
 * verify-data-name.cjs —— data-name 一致性校验脚本
 *
 * 校验项：
 *   1. 覆盖率：每文件视觉 JSX 元素数 vs data-name 数（应 1:1）
 *   2. 唯一性：全局静态 data-name 值不得重复（模板字面量豁免，按字面值检查）
 *   3. 命名规范：所有 data-name 值须匹配
 *      ^[a-z0-9]+(\-[a-z0-9]+)*(\.[a-z0-9]+(\-[a-z0-9]+)*)*$
 *
 * 用法：node scripts/verify-data-name.cjs
 * 退出码：0 通过 / 1 失败
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'src');

// 命名规范正则
const NAME_REGEX = /^[a-z0-9]+(\-[a-z0-9]+)*(\.[a-z0-9]+(\-[a-z0-9]+)*)*$/;

// 需要校验覆盖率的视觉元素标签（HTML/SVG/webview 等可被自动化测试定位的元素）
// 排除：head/meta/link/title/script 等不可见元素；SVG 内部装饰元素 path/circle 等
const VISUAL_TAGS = new Set([
  // 根/文档
  'html', 'body',
  // 容器
  'div', 'span', 'main', 'section', 'article', 'aside', 'header', 'footer', 'nav',
  // 标题与文本
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'pre', 'blockquote', 'q', 'cite',
  'figcaption', 'caption',
  // 表单
  'form', 'fieldset', 'legend', 'label', 'input', 'textarea', 'select', 'option',
  'optgroup', 'button', 'datalist', 'output', 'progress', 'meter',
  // 列表与表格
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'col', 'colgroup',
  // 媒体与嵌入
  'img', 'video', 'audio', 'canvas', 'iframe', 'embed', 'object', 'picture', 'source',
  // 交互
  'a', 'details', 'summary', 'dialog', 'menu',
  // 代码
  'code', 'kbd', 'samp', 'var',
  // SVG 根（不含内部装饰元素）
  'svg',
  // Electron
  'webview',
]);

// 匹配 JSX/HTML 开标签：<[a-z][a-zA-Z0-9]*\b
const JSX_OPEN_REGEX = new RegExp(
  `<(${Array.from(VISUAL_TAGS).join('|')})\\b`,
  'g'
);

// 匹配 data-name 出现（任意形式：字符串/模板字面量/JSX 表达式）
const DATA_NAME_REGEX = /data-name=/g;

// 提取 data-name 值（静态字符串、模板字面量）
const VALUE_REGEX = /data-name=(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\})/g;

/**
 * 剥离 JS/TS 注释（用于 JSX 计数前清理，避免误算注释中的 `<tag>` 文本）
 * 策略：
 *   1. 剥离块注释 /* ... *\/（保守：替换为等长空格，保留行结构）
 *   2. 剥离行注释 //...
 * 不剥离字符串字面量——JSX 属性值字符串内的 `<tag>` 不会触发误匹配（regex 要求 `<` 前缀）
 * 不剥离模板字面量——避免反引号未配对或跨多行的情况导致整文件被吞
 */
function stripCommentsAndStrings(content) {
  let result = content;
  // 1. 块注释 /* ... */
  result = result.replace(/\/\*[\s\S]*?\*\//g, (match) => ' '.repeat(match.length));
  // 2. 行注释 //...
  result = result.replace(/\/\/[^\n]*/g, (match) => ' '.repeat(match.length));
  return result;
}

/**
 * 递归遍历目录，收集指定后缀的文件
 */
function walk(dir, exts, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, exts, acc);
    } else if (exts.some((ext) => entry.name.endsWith(ext))) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * 分析单个文件
 */
function analyzeFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const rel = path.relative(ROOT, filePath).replace(/\\/g, '/');

  // 剥离注释与字符串字面量后再计数 JSX，避免注释中的 `<tag>` 被误算
  const stripped = stripCommentsAndStrings(content);

  // 1. 视觉 JSX 标签数（基于剥离后的内容）
  const jsxMatches = stripped.match(JSX_OPEN_REGEX) || [];
  const jsxCount = jsxMatches.length;

  // 2. data-name 出现次数（基于原始内容，因为属性值在字符串内不需剥离）
  const dnMatches = content.match(DATA_NAME_REGEX) || [];
  const dnCount = dnMatches.length;

  // 3. 提取 data-name 值（静态与模板字面量）
  const values = [];
  let m;
  VALUE_REGEX.lastIndex = 0;
  while ((m = VALUE_REGEX.exec(content)) !== null) {
    const v = m[1] ?? m[2] ?? m[3];
    if (v !== undefined && v !== null) values.push(v);
  }

  // 4. UI 原语透传豁免：以下 7 个简单原语通过 {...rest} 接收调用方传入的 data-name，
  //    文件本身无硬编码 data-name（也无其他视觉子元素需要单独标注），覆盖率校验对它们豁免。
  //    Modal/HotkeyRecorder/SegmentedControl/WindowControls 虽在 ui/ 下，但内部含硬编码
  //    视觉元素（如 modal-overlay、modal-header、hotkey-recorder-wrapper 等），不豁免。
  const EXEMPTED_PRIMITIVES = new Set([
    'src/components/ui/Badge.tsx',
    'src/components/ui/Button.tsx',
    'src/components/ui/Card.tsx',
    'src/components/ui/Chip.tsx',
    'src/components/ui/IconButton.tsx',
    'src/components/ui/Toggle.tsx',
    'src/components/ui/ListItem.tsx',
  ]);
  const spreadsRest = EXEMPTED_PRIMITIVES.has(rel);

  return { file: rel, jsxCount, dnCount, values, spreadsRest };
}

/**
 * 主流程
 */
function main() {
  const files = walk(SRC_DIR, ['.tsx', '.html']);

  const perFile = [];
  const globalValues = new Map(); // value -> [file, ...]
  let totalJsx = 0;
  let totalDn = 0;

  for (const f of files) {
    const r = analyzeFile(f);
    perFile.push(r);
    totalJsx += r.jsxCount;
    totalDn += r.dnCount;
    for (const v of r.values) {
      if (!globalValues.has(v)) globalValues.set(v, []);
      globalValues.get(v).push(r.file);
    }
  }

  // === 报告输出 ===
  console.log('=== data-name 一致性校验报告 ===\n');
  console.log(`扫描目录: ${SRC_DIR}`);
  console.log(`扫描文件数: ${files.length}（.tsx + .html）`);
  console.log(`视觉 JSX 元素总数: ${totalJsx}`);
  console.log(`data-name 出现总数: ${totalDn}`);
  console.log(`全局覆盖率: ${totalJsx > 0 ? ((totalDn / totalJsx) * 100).toFixed(2) : '0.00'}%\n`);

  // 文件级覆盖率
  console.log('文件级覆盖率：');
  let passCoverage = 0;
  let exemptCount = 0;
  const coverageFailures = [];
  for (const r of perFile) {
    // UI 原语透传 {...rest} 豁免：不在本文件硬编码 data-name，由调用方传入
    if (r.spreadsRest) {
      exemptCount++;
      console.log(`  ⊘ ${r.file}: JSX=${r.jsxCount}, data-name=${r.dnCount} (透传豁免)`);
      continue;
    }
    const ok = r.dnCount >= r.jsxCount;
    if (ok) passCoverage++;
    else coverageFailures.push(r);
    const tag = ok ? '✓' : '✗';
    const gap = ok ? '' : ` (缺 ${r.jsxCount - r.dnCount} 个)`;
    console.log(`  ${tag} ${r.file}: JSX=${r.jsxCount}, data-name=${r.dnCount}${gap}`);
  }
  console.log(`\n文件覆盖率: ${passCoverage}/${files.length} 通过（${exemptCount} 个透传豁免）`);

  // 唯一性校验（仅静态字符串；模板字面量按字面值豁免）
  const duplicates = [];
  for (const [value, fs] of globalValues) {
    if (!value.includes('${') && fs.length > 1) {
      duplicates.push({ value, files: fs });
    }
  }
  if (duplicates.length > 0) {
    console.log('\n重复 data-name 值：');
    for (const d of duplicates) {
      console.log(`  ✗ '${d.value}' 出现在 ${d.files.length} 个文件:`);
      for (const f of d.files) console.log(`      - ${f}`);
    }
  }

  // 命名规范校验（仅静态字符串；模板字面量按字面模式豁免）
  const invalid = [];
  for (const [value, fs] of globalValues) {
    // 模板字面量（含 ${...}）按字面模式豁免——校验其静态部分
    // 提取模板字面量的静态骨架（把 ${...} 替换为占位符 n 后再校验，必须小写以匹配 NAME_REGEX）
    const skeleton = value.replace(/\$\{[^}]+\}/g, 'n');
    if (!NAME_REGEX.test(skeleton)) {
      invalid.push({ value, file: fs[0] });
    }
  }
  if (invalid.length > 0) {
    console.log('\n命名规范违规（不符合 kebab-case 点分层级格式）：');
    for (const n of invalid) {
      console.log(`  ✗ '${n.value}' (在 ${n.file})`);
    }
  }

  // 总结
  const hasFailures = coverageFailures.length > 0 || duplicates.length > 0 || invalid.length > 0;
  console.log('\n=== 总结 ===');
  console.log(`覆盖率不足文件: ${coverageFailures.length}`);
  console.log(`重复 data-name 值: ${duplicates.length}`);
  console.log(`命名规范违规: ${invalid.length}`);
  console.log(hasFailures ? '\n❌ 校验未通过' : '\n✅ 校验通过');

  process.exit(hasFailures ? 1 : 0);
}

main();
