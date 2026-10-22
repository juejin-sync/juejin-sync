// 从 CHANGELOG.md 提取指定版本的变更记录，并格式化为带精美 Emoji 的 GitHub Release Notes
import fs from 'node:fs';
import path from 'node:path';

const categoryIcons = [
  { match: /新增|新功能|feat/i, icon: '✨' },
  { match: /修复|fix/i, icon: '🛠️' },
  { match: /改进|优化|perf|enhance|refactor/i, icon: '⚡' },
  { match: /工程|发布|构建|ci|infra|workflow/i, icon: '📦' },
  { match: /安全|security/i, icon: '🔒' },
  { match: /测试|test/i, icon: '🧪' },
  { match: /无障碍|a11y|accessibility/i, icon: '♿' },
  { match: /文档|docs/i, icon: '📖' }
];

export function extractReleaseNotes(targetVersion, changelogPath = 'CHANGELOG.md') {
  const cleanVersion = targetVersion.replace(/^v/, '').trim();
  let changelog = '';
  try {
    changelog = fs.readFileSync(changelogPath, 'utf8');
  } catch {
    return defaultNotes(cleanVersion);
  }

  // 匹配形如 ## [0.4.1] - 2026-09-01 或 ## 0.4.1 的版本区块，遇下一个 ## 标题或文末停止
  const escapedVersion = cleanVersion.replace(/\./g, '\\.');
  const regex = new RegExp(`##\\s+\\[?v?${escapedVersion}\\]?[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`);
  const match = changelog.match(regex);

  if (!match || !match[1].trim()) {
    return defaultNotes(cleanVersion);
  }

  return formatNotes(match[1].trim(), cleanVersion);
}

function formatNotes(rawNotes, version) {
  const lines = rawNotes.split('\n');
  let currentIcon = '✨';
  const resultLines = ['## 🚀 本次更新', ''];

  for (const line of lines) {
    const headerMatch = line.match(/^###\s+(.*)/);
    if (headerMatch) {
      const rawTitle = headerMatch[1].trim();
      // 移除原标题可能带有的 emoji 与空白，防止出现形如 ### ✨ ✨ 新增
      const cleanTitle = rawTitle.replace(/^[\p{Extended_Pictographic}\u2000-\u3300\ufe0f\s]+/u, '').trim();
      const found = categoryIcons.find(c => c.match.test(cleanTitle || rawTitle));
      const icon = found ? found.icon : '📌';
      currentIcon = icon;
      resultLines.push(`### ${icon} ${cleanTitle || rawTitle}`);
      continue;
    }

    const bulletMatch = line.match(/^(\s*[-*]\s+)(.*)/);
    if (bulletMatch) {
      const indent = bulletMatch[1];
      let text = bulletMatch[2].trim();

      // 剔除历史混入的 🎨
      text = text.replace(/^🎨\s*/, '');

      // 保持条目干净清晰，不重复添加 emoji
      resultLines.push(`${indent}${text}`);
      continue;
    }

    resultLines.push(line);
  }

  resultLines.push(
    '',
    '---',
    '### 📦 安装与使用',
    `1. 下载下方 Assets 中的 \`juejin-sync-v${version}.zip\` 压缩包并解压；`,
    '2. 打开 Chrome 浏览器，访问 \`chrome://extensions\`；',
    '3. 开启右上角“开发者模式”，点击“加载已解压的扩展程序”，选择解压目录即可；',
    '4. 更多详情请查阅 [README.md](https://github.com/juejin-sync/juejin-sync#readme)。'
  );

  return resultLines.join('\n');
}

function defaultNotes(version) {
  return [
    '## 🚀 本次更新',
    '',
    `### ✨ 版本发布`,
    `- ✨ 掘金同步助手 v${version} 发布。`,
    '',
    '---',
    '### 📦 安装与使用',
    `1. 下载下方 Assets 中的 \`juejin-sync-v${version}.zip\` 压缩包并解压；`,
    '2. 打开 Chrome 浏览器，访问 \`chrome://extensions\`；',
    '3. 开启右上角“开发者模式”，点击“加载已解压的扩展程序”，选择解压目录即可；',
    '4. 更多详情请查阅 [README.md](https://github.com/juejin-sync/juejin-sync#readme)。'
  ].join('\n');
}

// 命令行执行模式：node scripts/extract-release-notes.mjs [version] [outputPath]
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const version = process.argv[2] || pkg.version;
  const outputPath = process.argv[3];
  const notes = extractReleaseNotes(version);

  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, notes, 'utf8');
    console.log(`Release notes written to ${outputPath}`);
  } else {
    console.log(notes);
  }
}
