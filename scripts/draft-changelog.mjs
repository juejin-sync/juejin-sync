// 从 Git 提交记录自动提取并生成带有 Issue ID、PR 编号或 Commit 记录的 Changelog 草稿
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CATEGORY_MAP = [
  { match: /^feat(?:\(.*\))?!?:/i, category: '新增', icon: '✨' },
  { match: /^fix(?:\(.*\))?!?:/i, category: '修复', icon: '🛠️' },
  { match: /^(?:refactor|perf|optimize)(?:\(.*\))?!?:/i, category: '优化', icon: '⚡' },
  { match: /^docs(?:\(.*\))?!?:/i, category: '文档', icon: '📖' },
  { match: /^test(?:\(.*\))?!?:/i, category: '测试', icon: '🧪' },
  { match: /^(?:chore|build|ci)(?:\(.*\))?!?:/i, category: '工程', icon: '📦' }
];

export function getRepoBaseUrl(packageJsonPath = 'package.json') {
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    let url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url || '';
    url = url.replace(/^git\+/, '').replace(/\.git$/, '');
    if (url.startsWith('git@github.com:')) {
      url = url.replace('git@github.com:', 'https://github.com/');
    }
    return url.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

export function parseCommit(rawCommit, options = {}) {
  const { repoUrl = '', alwaysIncludeCommit = false } = options;
  const { hash = '', shortHash = hash.slice(0, 7), subject = '', body = '' } = rawCommit;

  // 忽略常见的无意义或自动化 Merge 提交
  if (/^Merge (?:branch|pull request|remote-tracking branch)/i.test(subject.trim())) {
    return null;
  }

  // 匹配 Conventional Commits 类型
  let category = '其他';
  let matchedIcon = '📌';
  for (const item of CATEGORY_MAP) {
    if (item.match.test(subject.trim())) {
      category = item.category;
      matchedIcon = item.icon;
      break;
    }
  }

  // 提取 scope
  const scopeMatch = subject.trim().match(/^[a-z]+(?:\(([^)]*)\))?!?:/i);
  const scope = scopeMatch?.[1]?.trim() || '';

  // 提取 PR 与 Issue 编号
  const issueSet = new Set();

  // 1. 匹配 subject 末尾或中间的 (#123) 或 #123
  const prMatch = subject.match(/\(#(\d+)\)/g);
  if (prMatch) {
    for (const m of prMatch) {
      const num = m.match(/\d+/)?.[0];
      if (num) issueSet.add(`#${num}`);
    }
  }

  // 2. 匹配 subject 与 body 中的 issue 模式：
  // 例如：closes #12, fixes #34, issue-4, #56
  const combinedText = `${subject}\n${body}`;
  const issueRegex = /(?:(?:closes?|closed|fixes?|fixed|resolves?|resolved|refs?|issue)[-:\s]+#?(\d+))|(?:#(\d+))/gi;
  let match;
  while ((match = issueRegex.exec(combinedText)) !== null) {
    const num = match[1] || match[2];
    if (num) issueSet.add(`#${num}`);
  }

  // 3. 提取主体描述（去除 type(scope): 前缀及末尾 (#123)）
  let cleanSubject = subject
    .replace(/^[a-z]+(?:\([^)]*\))?!?:/i, '')
    .replace(/\s*\(#\d+\)\s*$/g, '')
    .trim();

  if (!cleanSubject) {
    cleanSubject = subject.trim();
  }

  const issues = Array.from(issueSet);
  let refSuffix = '';

  if (issues.length > 0) {
    refSuffix = issues.join(' ');
    if (alwaysIncludeCommit && shortHash && repoUrl) {
      refSuffix += ` ([${shortHash}](${repoUrl}/commit/${hash}))`;
    }
  } else if (shortHash) {
    if (repoUrl) {
      refSuffix = `[\`${shortHash}\`](${repoUrl}/commit/${hash})`;
    } else {
      refSuffix = `[\`${shortHash}\`]`;
    }
  }

  return {
    hash,
    shortHash,
    category,
    icon: matchedIcon,
    scope,
    subject: cleanSubject,
    rawSubject: subject,
    issues,
    refSuffix
  };
}

export function getGitCommits(range, cwd = process.cwd()) {
  const delimiter = '||__COMMIT_RECORD__||';
  const fieldDelimiter = '||__FIELD__||';
  
  try {
    const stdout = execFileSync(
      'git',
      ['log', range, `--pretty=format:%H${fieldDelimiter}%h${fieldDelimiter}%s${fieldDelimiter}%b${delimiter}`],
      { cwd, encoding: 'utf8' }
    );

    const records = stdout.split(delimiter).filter(item => item.trim());
    return records.map(record => {
      const [hash = '', shortHash = '', subject = '', body = ''] = record.trim().split(fieldDelimiter);
      return { hash: hash.trim(), shortHash: shortHash.trim(), subject: subject.trim(), body: body.trim() };
    });
  } catch (error) {
    throw new Error(`获取 Git 提交记录失败 (${range}): ${error.message}`);
  }
}

export function getLatestTag(cwd = process.cwd()) {
  try {
    const tag = execFileSync('git', ['describe', '--tags', '--abbrev=0'], { cwd, encoding: 'utf8' });
    return tag.trim();
  } catch {
    return null;
  }
}

export function generateChangelogDraft(commits, options = {}) {
  const {
    version = 'Unreleased',
    date = new Date().toISOString().slice(0, 10),
    repoUrl = getRepoBaseUrl(),
    alwaysIncludeCommit = false
  } = options;

  const parsed = [];
  for (const c of commits) {
    const item = parseCommit(c, { repoUrl, alwaysIncludeCommit });
    if (item) parsed.push(item);
  }

  const groups = new Map();
  const categoryOrder = ['新增', '修复', '优化', '文档', '测试', '工程', '其他'];

  for (const cat of categoryOrder) {
    groups.set(cat, []);
  }

  for (const item of parsed) {
    if (!groups.has(item.category)) {
      groups.set(item.category, []);
    }
    groups.get(item.category).push(item);
  }

  const lines = [`## [${version}] - ${date}`, ''];

  for (const cat of categoryOrder) {
    const items = groups.get(cat) || [];
    if (items.length === 0) continue;

    lines.push(`### ${cat}`, '');
    for (const item of items) {
      const scopePart = item.scope ? `**${item.scope}**：` : '';
      const text = `${item.icon} ${scopePart}${item.subject}`.trim();
      const line = item.refSuffix ? `- ${text} ${item.refSuffix}` : `- ${text}`;
      lines.push(line);
    }
    lines.push('');
  }

  return {
    markdown: lines.join('\n').trim(),
    parsedCount: parsed.length,
    groups
  };
}

export function prependToChangelog(draftMarkdown, changelogPath = 'CHANGELOG.md') {
  if (!fs.existsSync(changelogPath)) {
    fs.writeFileSync(changelogPath, `# 更新日志\n\n${draftMarkdown}\n`, 'utf8');
    return;
  }

  const content = fs.readFileSync(changelogPath, 'utf8');
  // 匹配第一个二级版本标题 ## [...] 前的位置插入
  const firstSectionIndex = content.search(/\n##\s+\[/);
  if (firstSectionIndex !== -1) {
    const before = content.slice(0, firstSectionIndex + 1);
    const after = content.slice(firstSectionIndex + 1);
    const updated = `${before}${draftMarkdown}\n\n${after}`;
    fs.writeFileSync(changelogPath, updated, 'utf8');
  } else {
    const updated = `${content.trim()}\n\n${draftMarkdown}\n`;
    fs.writeFileSync(changelogPath, updated, 'utf8');
  }
}

// CLI 执行入口
function runCli() {
  const args = process.argv.slice(2);
  let range = '';
  let writeToFile = false;
  let customVersion = '';
  let alwaysIncludeCommit = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--write' || arg === '-w' || arg === '--prepend') {
      writeToFile = true;
    } else if (arg === '--include-commits' || arg === '-c') {
      alwaysIncludeCommit = true;
    } else if (arg === '--version' || arg === '-v') {
      customVersion = args[++i];
    } else if (!arg.startsWith('-') && !range) {
      range = arg;
    }
  }

  if (!range) {
    const latestTag = getLatestTag();
    if (latestTag) {
      range = `${latestTag}..HEAD`;
    } else {
      range = 'HEAD';
    }
  }

  let pkgVersion = '';
  try {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    pkgVersion = pkg.version;
  } catch {}

  const version = customVersion || pkgVersion || 'Draft';
  const repoUrl = getRepoBaseUrl();

  console.log(`\n🔍 正在分析 Git 提交记录: ${range}`);
  const commits = getGitCommits(range);

  if (commits.length === 0) {
    console.log(`ℹ️ 在区间 ${range} 内没有找到任何提交。`);
    return;
  }

  const { markdown, parsedCount, groups } = generateChangelogDraft(commits, {
    version,
    repoUrl,
    alwaysIncludeCommit
  });

  console.log(`✨ 解析到 ${parsedCount} 条有效变更：`);
  for (const [cat, list] of groups.entries()) {
    if (list.length > 0) {
      console.log(`   - ${cat}: ${list.length} 条`);
    }
  }

  console.log('\n-------------------- 变更草稿预览 --------------------\n');
  console.log(markdown);
  console.log('\n------------------------------------------------------\n');

  if (writeToFile) {
    prependToChangelog(markdown);
    console.log(`✅ 已成功将草稿前置写入 CHANGELOG.md！`);
  } else {
    console.log(`💡 提示：你可以直接复制上方内容到 CHANGELOG.md，或者使用:`);
    console.log(`   npm run changelog:draft -- --write`);
    console.log(`   将草稿直接追加到 CHANGELOG.md 中进行润色。\n`);
  }
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMainModule) {
  runCli();
}
