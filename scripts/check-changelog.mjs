// 校验 CHANGELOG.md 是否符合工业界标准的 Release Notes 格式规范
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ALLOWED_EMOJIS = ['✨', '🛠️', '⚡', '📦', '🔒', '🧪', '📖', '♿', '📌', '🚀'];

/**
 * 校验单行变更记录的格式
 * @param {string} line - 当前行文本
 * @param {number} lineNumber - 行号
 * @returns {string[]} 错误列表
 */
export function validateChangelogItem(line, lineNumber = 0) {
  const errors = [];
  const linePrefix = lineNumber > 0 ? `第 ${lineNumber} 行: ` : '';

  // 1. 检查多级缩进（单层扁平列表规范）
  if (/^\s+[-*]/.test(line)) {
    errors.push(`${linePrefix}检测到多级嵌套缩进（${line.trim()}）。规范要求单层扁平列表，严禁二级/多级缩进。`);
    return errors;
  }

  // 2. 检查列表起始标记
  const bulletMatch = line.match(/^[-*]\s+(.*)/);
  if (!bulletMatch) {
    // 非列表行如果不是空行或小标题，提醒格式
    if (line.trim() && !line.startsWith('#')) {
      errors.push(`${linePrefix}内容必须以列表符号 '- ' 开头: '${line.trim()}'`);
    }
    return errors;
  }

  const content = bulletMatch[1].trim();

  // 3. 检查分类 Emoji
  const hasEmoji = ALLOWED_EMOJIS.some(emoji => content.startsWith(emoji));
  if (!hasEmoji) {
    errors.push(
      `${linePrefix}缺少规范的分类 Emoji。必须以 ${ALLOWED_EMOJIS.slice(0, 4).join(' / ')} 等开头: '${content}'`
    );
  }

  // 4. 检查模块/特性名称加粗
  // 匹配形如: ✨ **模块名称**： 或 🛠️ **模块名称**:
  const hasBoldModule = /\*\*[^*]+?\*\*[:：]/.test(content);
  if (!hasBoldModule) {
    errors.push(
      `${linePrefix}缺少加粗的模块/特性名称（格式规范: '**模块名称**：用户可感知描述'）: '${content}'`
    );
  }

  // 5. 检查可追溯性（Issue / PR / Commit 链接）
  const hasIssueOrPr = /#\d+/.test(content);
  const hasCommitHash = /\[`[0-9a-f]{7,}`\]/i.test(content);
  if (!hasIssueOrPr && !hasCommitHash) {
    errors.push(
      `${linePrefix}行末缺少关联的 #Issue 或 #PR 编号（如 #24），每一项更新必须具备可追溯性: '${content}'`
    );
  }

  return errors;
}

/**
 * 提取指定版本（或最新版本）的条目及行号
 * @param {string} changelogContent
 * @param {string} [targetVersion]
 */
export function extractVersionSection(changelogContent, targetVersion) {
  const lines = changelogContent.split('\n');
  let currentVersion = null;
  let inTargetSection = false;
  const sectionItems = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const lineNumber = i + 1;
    const headerMatch = rawLine.match(/^##\s+\[?v?([0-9]+\.[0-9]+\.[0-9]+[^\]\s]*)\]?/);

    if (headerMatch) {
      const ver = headerMatch[1];
      if (!targetVersion) {
        // 如果未指定版本，默认提取遇到的第一个版本（最新版本）
        if (!currentVersion) {
          currentVersion = ver;
          inTargetSection = true;
          continue;
        } else {
          // 遇到下一个版本，停止
          break;
        }
      } else {
        const cleanTarget = targetVersion.replace(/^v/, '').trim();
        if (ver === cleanTarget) {
          currentVersion = ver;
          inTargetSection = true;
          continue;
        } else if (inTargetSection) {
          // 已经过目标版本，遇到下一个版本停止
          break;
        }
      }
    }

    if (inTargetSection) {
      sectionItems.push({ line: rawLine, lineNumber });
    }
  }

  return {
    version: currentVersion,
    items: sectionItems
  };
}

/**
 * 校验 CHANGELOG 文件中的版本内容
 * @param {string} changelogPath
 * @param {string} [targetVersion]
 */
export function validateChangelogFile(changelogPath = 'CHANGELOG.md', targetVersion) {
  if (!fs.existsSync(changelogPath)) {
    return {
      success: false,
      version: null,
      totalItems: 0,
      errors: [`未找到更新日志文件: ${changelogPath}`]
    };
  }

  const content = fs.readFileSync(changelogPath, 'utf8');
  const { version, items } = extractVersionSection(content, targetVersion);

  if (!version) {
    return {
      success: false,
      version: null,
      totalItems: 0,
      errors: [targetVersion ? `在 ${changelogPath} 中未找到指定版本 [${targetVersion}]` : `在 ${changelogPath} 中未找到任何版本区块`]
    };
  }

  const allErrors = [];
  let bulletCount = 0;

  for (const { line, lineNumber } of items) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('###') || trimmed.startsWith('---')) {
      continue;
    }

    // 检查普通列表条目或缩进条目
    if (/^\s*[-*]/.test(line)) {
      bulletCount++;
      const itemErrors = validateChangelogItem(line, lineNumber);
      allErrors.push(...itemErrors);
    } else {
      // 非空且非列表、非标题的普通文本，提示应格式化为规范条目
      allErrors.push(`第 ${lineNumber} 行: 检测到未列表化的散落段落，请格式化为 '- [Emoji] **[模块]**：描述 #Issue' 规范条目: '${trimmed}'`);
    }
  }

  if (bulletCount === 0) {
    allErrors.push(`版本 [${version}] 未包含任何有效更新条目。`);
  }

  return {
    success: allErrors.length === 0,
    version,
    totalItems: bulletCount,
    errors: allErrors
  };
}

// CLI 命令行直接执行
function runCli() {
  const args = process.argv.slice(2);
  const targetVersion = args[0] && !args[0].startsWith('-') ? args[0] : undefined;
  const changelogPath = 'CHANGELOG.md';

  console.log(`🔍 正在校验 ${changelogPath} 格式规范...`);
  const result = validateChangelogFile(changelogPath, targetVersion);

  if (!result.success) {
    console.error(`\n❌ CHANGELOG 格式校验失败 (版本 [${result.version || '未知'}]):`);
    result.errors.forEach(err => console.error(`  • ${err}`));
    console.error(`\n💡 规范指南: 请保持单层列表，使用 - [Emoji] **[模块名]**：面向用户价值的描述 #Issue 格式。`);
    process.exit(1);
  }

  console.log(`\n✔ CHANGELOG 格式校验完全通过！`);
  console.log(`  • 校验版本: [${result.version}]`);
  console.log(`  • 检查条目: 共 ${result.totalItems} 条更新记录全部符合规范`);
}

const currentFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(currentFilePath)) {
  runCli();
}
