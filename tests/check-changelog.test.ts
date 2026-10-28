import { describe, expect, it } from 'vitest';
import {
  ALLOWED_EMOJIS,
  extractVersionSection,
  validateChangelogFile,
  validateChangelogItem
} from '../scripts/check-changelog.mjs';

describe('CHANGELOG 格式校验器 (check-changelog)', () => {
  describe('validateChangelogItem', () => {
    it('正确通过符合标杆规范的条目', () => {
      const line = '- ✨ **批量同步**：支持创作者中心文章多选与一键分发。#9 #24';
      const errors = validateChangelogItem(line, 1);
      expect(errors).toEqual([]);
    });

    it('正确支持使用 commit 哈希的合规条目', () => {
      const line = '- 🛠️ **修复**：修复知乎脚本加载问题 [`6f8e031`](https://github.com/...)';
      const errors = validateChangelogItem(line, 2);
      expect(errors).toEqual([]);
    });

    it('拦截多级嵌套缩进（严禁二级/多级列表）', () => {
      const line = '  - 修复了某某问题 (#12)';
      const errors = validateChangelogItem(line, 3);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain('多级嵌套缩进');
    });

    it('拦截缺少分类 Emoji 的条目', () => {
      const line = '- **批量同步**：优化了性能。#24';
      const errors = validateChangelogItem(line, 4);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain('缺少规范的分类 Emoji');
    });

    it('拦截未对模块名称加粗的条目', () => {
      const line = '- ✨ 批量同步：优化了性能。#24';
      const errors = validateChangelogItem(line, 5);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain('缺少加粗的模块/特性名称');
    });

    it('拦截缺少 Issue / PR 编号关联的条目', () => {
      const line = '- ✨ **批量同步**：优化了性能，没有关联编号。';
      const errors = validateChangelogItem(line, 6);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain('缺少关联的 #Issue 或 #PR 编号');
    });
  });

  describe('extractVersionSection', () => {
    const sampleChangelog = `
# 更新日志

## [1.5.0] - 2026-10-22

### 新增
- ✨ **模块A**：新增特性描述。#1

## [1.4.2] - 2026-10-19

### 修复
- 历史条目
`;

    it('默认提取最新版本', () => {
      const result = extractVersionSection(sampleChangelog);
      expect(result.version).toBe('1.5.0');
      expect(result.items.length).toBeGreaterThan(0);
      expect(result.items.some(i => i.line.includes('模块A'))).toBe(true);
      expect(result.items.some(i => i.line.includes('历史条目'))).toBe(false);
    });

    it('可根据参数提取指定版本', () => {
      const result = extractVersionSection(sampleChangelog, '1.4.2');
      expect(result.version).toBe('1.4.2');
      expect(result.items.some(i => i.line.includes('历史条目'))).toBe(true);
    });
  });

  describe('validateChangelogFile', () => {
    it('当前仓库 CHANGELOG.md 最新版本校验 100% 通过', () => {
      const result = validateChangelogFile('CHANGELOG.md');
      expect(result.success).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.version).toBe('1.6.0');
      expect(result.totalItems).toBe(4);
    });
  });
});
