#!/usr/bin/env node
/**
 * gen-data-name-lookup.cjs —— 自动生成 data-name 属性值对照表
 *
 * 扫描 src 目录下所有 .tsx 文件与 src/index.html，提取所有 data-name 属性，
 * 生成 docs/data-name-lookup.md。
 *
 * 用法：node scripts/gen-data-name-lookup.cjs
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'src');
const OUT_FILE = path.join(ROOT, 'docs', 'data-name-lookup.md');

// UI 原语透传豁免：这些文件仅通过 {...rest} 透传 data-name，本身无硬编码 data-name
const EXEMPTED_PRIMITIVES = new Set([
  'src/components/ui/Badge.tsx',
  'src/components/ui/Button.tsx',
  'src/components/ui/Card.tsx',
  'src/components/ui/Chip.tsx',
  'src/components/ui/IconButton.tsx',
  'src/components/ui/Toggle.tsx',
  'src/components/ui/ListItem.tsx',
]);

// 静态 data-name 属性正则：data-name="..."
const STATIC_RE = /data-name="([a-z0-9.\-]+)"/g;
// 模板字面量 data-name 属性正则：data-name={`...`}
const TEMPLATE_RE = /data-name=\{`([^`]+)`\}/g;

// DOM 元素标签列表（用于回溯查找 data-name 所属标签）
const DOM_TAGS = [
  'html', 'body',
  'div', 'span', 'svg', 'button', 'input', 'option', 'select',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'li', 'p', 'label', 'textarea', 'webview', 'img', 'a',
  'nav', 'header', 'footer', 'main', 'section', 'article',
  'table', 'tr', 'td', 'th', 'thead', 'tbody',
];
const DOM_TAG_RE = new RegExp('<(' + DOM_TAGS.join('|') + ')\\b', 'g');

// 描述规则（按优先级排序，长后缀优先匹配）
// 对每个规则 -X，同时匹配 -X 与 .X（点号与连字符等价）
const DESC_RULES = [
  ['-icon-button', '图标按钮'],
  ['-modal-header', '模态头部'],
  ['-modal-body', '模态主体'],
  ['-menu-item', '菜单项'],
  ['-error-message', '错误提示'],
  ['-button', '按钮'],
  ['-icon', '图标'],
  ['-container', '容器'],
  ['-wrapper', '包装容器'],
  ['-overlay', '遮罩层'],
  ['-input', '输入框'],
  ['-textarea', '文本域'],
  ['-select', '下拉选择'],
  ['-option', '选项'],
  ['-label', '标签文本'],
  ['-title', '标题'],
  ['-list', '列表'],
  ['-item', '列表项'],
  ['-menu', '菜单'],
  ['-tab', '标签页'],
  ['-modal', '模态框'],
  ['-header', '页头'],
  ['-footer', '页脚'],
  ['-error', '错误状态'],
  ['-badge', '徽标'],
  ['-chip', '芯片标签'],
  ['-toggle', '开关'],
  ['-divider', '分隔线'],
  ['-skeleton', '加载占位'],
];

/**
 * 生成 data-name 的功能说明
 * @param {string} name - data-name 值（模板字面量保留 ${...} 原样）
 * @returns {string}
 */
function describe(name) {
  const isDynamic = name.includes('${');
  let desc = '元素';

  // 动态属性：取 ${ 之前的静态部分做后缀匹配
  let baseName = name;
  if (isDynamic) {
    baseName = name.split('${')[0].replace(/[-.]+$/, '');
  }

  for (const [suffix, label] of DESC_RULES) {
    const dotSuffix = '.' + suffix.slice(1);
    if (baseName.endsWith(suffix) || baseName.endsWith(dotSuffix)) {
      desc = label;
      break;
    }
  }

  if (isDynamic) {
    desc = '动态' + desc;
  }

  return desc;
}

/**
 * 查找 data-name 所在位置对应的 DOM 元素标签
 * 在同一行向上扫描最多 5 行，寻找最近的 <tagname 开标签
 * @param {string[]} lines - 文件按行拆分的数组
 * @param {number} lineIdx - data-name 所在行号（0 基）
 * @param {number} colIdx - data-name 在该行的列号（0 基）
 * @returns {string|null}
 */
function findDomTag(lines, lineIdx, colIdx) {
  // 同一行：寻找 colIdx 之前最后一个 <tagname
  const sameLine = lines[lineIdx] || '';
  DOM_TAG_RE.lastIndex = 0;
  let m;
  let sameLineMatch = null;
  while ((m = DOM_TAG_RE.exec(sameLine)) !== null) {
    if (m.index < colIdx) {
      sameLineMatch = m[1];
    }
  }
  if (sameLineMatch) return sameLineMatch;

  // 向上扫描 1-5 行
  for (let offset = 1; offset <= 5; offset++) {
    const idx = lineIdx - offset;
    if (idx < 0) break;
    const line = lines[idx] || '';
    DOM_TAG_RE.lastIndex = 0;
    const matches = [];
    while ((m = DOM_TAG_RE.exec(line)) !== null) {
      matches.push(m[1]);
    }
    if (matches.length > 0) {
      // 返回该行最后一个匹配（最靠近 data-name 行的标签）
      return matches[matches.length - 1];
    }
  }
  return null;
}

/**
 * 递归遍历目录，收集指定后缀的文件
 * @param {string} dir
 * @param {string} ext - 含点的后缀，如 '.tsx'
 * @param {string[]} acc
 * @returns {string[]}
 */
function walk(dir, ext, acc) {
  acc = acc || [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return acc;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, ext, acc);
    } else if (entry.name.endsWith(ext)) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * 将 content 中的字符索引转换为 {lineIdx, colInLine}
 * @param {string} content
 * @param {number} index
 * @returns {{lineIdx: number, colInLine: number}}
 */
function indexToLineCol(content, index) {
  const prefix = content.slice(0, index);
  const lineIdx = prefix.split(/\r?\n/).length - 1;
  const lineStart = prefix.lastIndexOf('\n') + 1;
  const colInLine = index - lineStart;
  return { lineIdx, colInLine };
}

/**
 * 分析单个文件，提取所有 data-name 属性
 * @param {string} filePath - 绝对路径
 * @returns {Array<{value: string, file: string, isDynamic: boolean, tag: string|null, lineIdx: number}>}
 */
function analyzeFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const rel = path.relative(ROOT, filePath).replace(/\\/g, '/');
  const lines = content.split(/\r?\n/);
  const entries = [];

  // 静态属性
  STATIC_RE.lastIndex = 0;
  let m;
  while ((m = STATIC_RE.exec(content)) !== null) {
    const value = m[1];
    const { lineIdx, colInLine } = indexToLineCol(content, m.index);
    const tag = findDomTag(lines, lineIdx, colInLine);
    entries.push({
      value,
      file: rel,
      isDynamic: false,
      tag,
      lineIdx,
    });
  }

  // 模板字面量属性
  TEMPLATE_RE.lastIndex = 0;
  while ((m = TEMPLATE_RE.exec(content)) !== null) {
    const value = m[1];
    const { lineIdx, colInLine } = indexToLineCol(content, m.index);
    const tag = findDomTag(lines, lineIdx, colInLine);
    entries.push({
      value,
      file: rel,
      isDynamic: true,
      tag,
      lineIdx,
    });
  }

  // 按行号排序，保证输出顺序与源码顺序一致
  entries.sort((a, b) => a.lineIdx - b.lineIdx);

  return entries;
}

/**
 * 主流程
 */
function main() {
  // 1. 收集文件：src/**/*.tsx + src/index.html
  const tsxFiles = walk(SRC_DIR, '.tsx');
  const htmlFile = path.join(SRC_DIR, 'index.html');
  const allFiles = tsxFiles.slice();
  if (fs.existsSync(htmlFile)) allFiles.push(htmlFile);

  // 2. 排除豁免文件
  const files = allFiles.filter((f) => {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    return !EXEMPTED_PRIMITIVES.has(rel);
  });

  // 3. 分析每个文件
  const perFile = new Map(); // rel -> entries
  let totalEntries = 0;
  let staticCount = 0;
  let dynamicCount = 0;
  const zeroDataNameFiles = [];

  for (const f of files) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    let entries;
    try {
      entries = analyzeFile(f);
    } catch (err) {
      console.error('分析文件失败: ' + rel + ' - ' + err.message);
      entries = [];
    }
    perFile.set(rel, entries);
    totalEntries += entries.length;
    staticCount += entries.filter((e) => !e.isDynamic).length;
    dynamicCount += entries.filter((e) => e.isDynamic).length;
    if (entries.length === 0) {
      zeroDataNameFiles.push(rel);
    }
  }

  // 4. 生成 Markdown
  const timestamp = new Date().toISOString();
  const out = [];

  out.push('# data-name 属性值对照表');
  out.push('');
  out.push('> 本文件由 `scripts/gen-data-name-lookup.cjs` 自动生成。请勿手动编辑。');
  out.push('> 命名规范见 [data-name-spec.md](./data-name-spec.md)。');
  out.push('> 校验脚本：[scripts/verify-data-name.cjs](../scripts/verify-data-name.cjs)。');
  out.push('');
  out.push('---');
  out.push('');
  out.push('## 状态总览');
  out.push('');
  out.push('- **扫描文件数**：' + files.length);
  out.push('- **data-name 总数**：' + totalEntries);
  out.push('- **静态属性数**：' + staticCount);
  out.push('- **动态属性数**：' + dynamicCount);
  out.push('- **生成时间**：' + timestamp);
  out.push('');
  out.push('---');
  out.push('');
  out.push('## 完整属性对照表');
  out.push('');

  // 按文件路径字母序排序，只输出有 data-name 的文件
  const sortedFiles = Array.from(perFile.keys()).sort();
  for (const rel of sortedFiles) {
    const entries = perFile.get(rel);
    if (entries.length === 0) continue;

    out.push('### ' + rel);
    out.push('');
    out.push('| data-name | 文件 | 功能说明 | DOM 元素 |');
    out.push('|---|---|---|---|');
    for (const e of entries) {
      const dn = '`' + e.value + '`';
      const file = e.file;
      const desc = describe(e.value);
      const dom = e.tag ? ('`<' + e.tag + '>`') : '`-`';
      out.push('| ' + dn + ' | ' + file + ' | ' + desc + ' | ' + dom + ' |');
    }
    out.push('');
  }

  // 5. 写入文件
  fs.writeFileSync(OUT_FILE, out.join('\n'), 'utf8');

  // 6. 控制台报告
  console.log('=== data-name 对照表生成报告 ===');
  console.log('');
  console.log('扫描文件数: ' + files.length);
  console.log('data-name 总数: ' + totalEntries);
  console.log('静态属性数: ' + staticCount);
  console.log('动态属性数: ' + dynamicCount);
  console.log('输出文件: ' + OUT_FILE);
  console.log('');
  console.log('无 data-name 的文件 (' + zeroDataNameFiles.length + '):');
  for (const f of zeroDataNameFiles) {
    console.log('  - ' + f);
  }

  // 7. 打印生成文件的前 5 行与后 5 行
  const generated = fs.readFileSync(OUT_FILE, 'utf8').split(/\r?\n/);
  console.log('');
  console.log('生成文件前 5 行:');
  for (const l of generated.slice(0, 5)) console.log('  ' + l);
  console.log('');
  console.log('生成文件后 5 行:');
  for (const l of generated.slice(-5)) console.log('  ' + l);
}

main();
