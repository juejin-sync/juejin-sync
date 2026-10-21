import { describe, expect, it } from 'vitest';
import {
  generateChangelogDraft,
  getRepoBaseUrl,
  parseCommit,
  prependToChangelog
} from '../scripts/draft-changelog.mjs';

describe('Changelog 草稿生成器', () => {
  const repoUrl = 'https://github.com/juejin-sync/juejin-sync';

  describe('parseCommit', () => {
    it('正确解析 feat 提交并提取 PR 编号', () => {
      const commit = {
        hash: 'de9a8891234567890abcdef',
        shortHash: 'de9a889',
        subject: 'feat(wechat): support mac window decoration (#10)',
        body: ''
      };

      const result = parseCommit(commit, { repoUrl });
      expect(result).not.toBeNull();
      expect(result?.category).toBe('新增');
      expect(result?.subject).toBe('support mac window decoration');
      expect(result?.issues).toEqual(['#10']);
      expect(result?.refSuffix).toBe('#10');
    });

    it('正确解析 fix 提交并提取多个关联 Issue/PR', () => {
      const commit = {
        hash: 'd0c68341234567890abcdef',
        shortHash: 'd0c6834',
        subject: 'fix(batch): prevent csdn rate limit (#26)',
        body: 'Closes #25, fixes #27'
      };

      const result = parseCommit(commit, { repoUrl });
      expect(result).not.toBeNull();
      expect(result?.category).toBe('修复');
      expect(result?.subject).toBe('prevent csdn rate limit');
      expect(result?.issues).toContain('#26');
      expect(result?.issues).toContain('#25');
      expect(result?.issues).toContain('#27');
      expect(result?.refSuffix).toContain('#26');
      expect(result?.refSuffix).toContain('#25');
    });

    it('当没有 PR/Issue 编号时，降级使用 commit 哈希链接', () => {
      const commit = {
        hash: '6f8e0311234567890abcdef',
        shortHash: '6f8e031',
        subject: 'fix: 修复知乎脚本加载和发布图片链接',
        body: ''
      };

      const result = parseCommit(commit, { repoUrl });
      expect(result).not.toBeNull();
      expect(result?.category).toBe('修复');
      expect(result?.subject).toBe('修复知乎脚本加载和发布图片链接');
      expect(result?.issues).toEqual([]);
      expect(result?.refSuffix).toBe('[`6f8e031`](https://github.com/juejin-sync/juejin-sync/commit/6f8e0311234567890abcdef)');
    });

    it('忽略自动化 Merge 提交', () => {
      const commit = {
        hash: '229c9571234567890abcdef',
        shortHash: '229c957',
        subject: 'Merge pull request #5 from juejin-sync/codex/update-logo',
        body: ''
      };

      const result = parseCommit(commit, { repoUrl });
      expect(result).toBeNull();
    });

    it('正确解析 refactor 与 perf 为优化', () => {
      const commit1 = {
        hash: 'b5d90a01234567890abcdef',
        shortHash: 'b5d90a0',
        subject: 'refactor(ui): unify batch modal (#24)',
        body: ''
      };
      const commit2 = {
        hash: '12345671234567890abcdef',
        shortHash: '1234567',
        subject: 'perf: 加快文章解析速度 (#28)',
        body: ''
      };

      expect(parseCommit(commit1, { repoUrl })?.category).toBe('优化');
      expect(parseCommit(commit2, { repoUrl })?.category).toBe('优化');
    });
  });

  describe('generateChangelogDraft', () => {
    it('正确生成带版本与日期的分类 Markdown 草稿', () => {
      const commits = [
        {
          hash: 'de9a889',
          shortHash: 'de9a889',
          subject: 'feat(wechat): support mac window (#10)',
          body: ''
        },
        {
          hash: 'd0c6834',
          shortHash: 'd0c6834',
          subject: 'fix(batch): prevent rate limit (#26)',
          body: ''
        },
        {
          hash: '6f8e031',
          shortHash: '6f8e031',
          subject: 'fix: 修复发布图片链接',
          body: ''
        }
      ];

      const { markdown } = generateChangelogDraft(commits, {
        version: '1.5.0',
        date: '2026-10-21',
        repoUrl
      });

      expect(markdown).toContain('## [1.5.0] - 2026-10-21');
      expect(markdown).toContain('### 新增');
      expect(markdown).toContain('- support mac window #10');
      expect(markdown).toContain('### 修复');
      expect(markdown).toContain('- prevent rate limit #26');
      expect(markdown).toContain('- 修复发布图片链接 [`6f8e031`](https://github.com/juejin-sync/juejin-sync/commit/6f8e031)');
    });
  });

  describe('getRepoBaseUrl', () => {
    it('正确读取 package.json 中的仓库地址', () => {
      const url = getRepoBaseUrl();
      expect(url).toBe('https://github.com/juejin-sync/juejin-sync');
    });
  });
});
