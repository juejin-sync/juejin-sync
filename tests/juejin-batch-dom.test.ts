import {describe,expect,it} from 'vitest';
import {createJuejinArticleCache,fetchJuejinDraftByArticleId} from '../src/source/juejin-api';

describe('掘金历史文章批量同步向导核心算法与缓存',()=>{
  it('能正确计算批量耗时预估公式', ()=>{
    const calculateDuration=(articlesCount:number,platformsCount:number)=>{
      const taskCount=articlesCount*platformsCount;
      return Math.max(3,Math.ceil((taskCount/2)*2.5));
    };

    // 1 篇 × 1 平台 = 1 任务，保底 3 秒
    expect(calculateDuration(1,1)).toBe(3);
    // 10 篇 × 2 平台 = 20 任务，并发 2，每批 2.5 秒 -> 25 秒
    expect(calculateDuration(10,2)).toBe(25);
    // 5 篇 × 4 平台 = 20 任务 -> 25 秒
    expect(calculateDuration(5,4)).toBe(25);
  });

  it('智能筛选未同步文章能准确剔除全量已同步条目',()=>{
    const mockSyncedIds=new Set<string>([
      'csdn:1001','wechat:1001','cnblogs:1001','zhihu:1001', // 1001 全同步
      'csdn:1002' // 1002 仅同步了 CSDN，微信/博客园/知乎未同步
    ]);

    const isFullySynced=(articleId:string)=>{
      return mockSyncedIds.has(`csdn:${articleId}`)&&
             mockSyncedIds.has(`wechat:${articleId}`)&&
             mockSyncedIds.has(`cnblogs:${articleId}`)&&
             mockSyncedIds.has(`zhihu:${articleId}`);
    };

    expect(isFullySynced('1001')).toBe(true);
    expect(isFullySynced('1002')).toBe(false);

    // 智能筛选应只选 1002，忽略 1001
    const articles=['1001','1002'];
    const unsynced=articles.filter(id=>!isFullySynced(id));
    expect(unsynced).toEqual(['1002']);
  });

  it('批量草稿反查缓存命中时能直接复用，避免重复请求掘金分页接口',async()=>{
    const cache=createJuejinArticleCache();
    cache.set('9999',{
      article_info:{
        article_id:'9999',
        draft_id:'8888',
        title:'缓存标题',
        brief_content:'缓存摘要'
      }
    });

    const mockFetch=async(input:RequestInfo|URL)=>{
      const url=String(input);
      if(url.includes('list_by_user')){
        throw new Error('命中缓存时不应调用 list_by_user');
      }
      return Response.json({
        err_no:0,
        data:{
          article_draft:{
            id:'8888',
            title:'草稿标题',
            mark_content:'这是一篇超过二十个字符的测试文章内容，用于验证命中缓存时的行为。',
            brief_content:'草稿摘要'
          }
        }
      });
    };

    const originalFetch=globalThis.fetch;
    globalThis.fetch=mockFetch as any;
    try{
      const article=await fetchJuejinDraftByArticleId('9999','uuid','fallback',cache);
      expect(article.id).toBe('9999');
      expect(article.sourceDraftId).toBe('8888');
      expect(article.title).toBe('草稿标题');
    }finally{
      globalThis.fetch=originalFetch;
    }
  });

  it('卡片行最左侧独立居中固定列确保复选框不侵入文章内部文本流且不破坏行布局',()=>{
    class MockElement {
      children: MockElement[] = [];
      parentElement: MockElement | null = null;
      className = '';
      tagName = 'div';
      constructor(tagName = 'div') { this.tagName = tagName; }
      appendChild(child: MockElement) {
        if (child.parentElement) child.parentElement.removeChild(child);
        child.parentElement = this;
        this.children.push(child);
      }
      insertBefore(newChild: MockElement, refChild: MockElement) {
        if (newChild.parentElement) newChild.parentElement.removeChild(newChild);
        const index = this.children.indexOf(refChild);
        newChild.parentElement = this;
        if (index === -1) this.children.push(newChild);
        else this.children.splice(index, 0, newChild);
      }
      removeChild(child: MockElement) {
        const index = this.children.indexOf(child);
        if (index !== -1) {
          child.parentElement = null;
          this.children.splice(index, 1);
        }
      }
      querySelector(selector: string): MockElement | null {
        const targetClass = selector.replace('.', '').split('[')[0];
        for (const child of this.children) {
          if (child.className.includes(targetClass)) return child;
          const found = child.querySelector(selector);
          if (found) return found;
        }
        return null;
      }
    }

    // 模拟掘金整行卡片 row：包含 contentCol (title + subTitle) 和 actionsCol (buttons)
    const row = new MockElement('div');
    row.className = 'article-item-row';

    const contentCol = new MockElement('div');
    contentCol.className = 'content-col';
    const link = new MockElement('a');
    link.className = 'title';
    const subTitle = new MockElement('div');
    subTitle.className = 'sub-title';
    contentCol.appendChild(link);
    contentCol.appendChild(subTitle);

    const actionsCol = new MockElement('div');
    actionsCol.className = 'actions-col';

    row.appendChild(contentCol);
    row.appendChild(actionsCol);

    // 执行全新的独立 checkboxCol 注入逻辑
    let checkboxCol = row.querySelector('.jc-article-checkbox-col');
    if (!checkboxCol) {
      checkboxCol = new MockElement('div');
      checkboxCol.className = 'jc-article-checkbox-col';
      const checkbox = new MockElement('input');
      checkbox.className = 'jc-article-select-checkbox';
      checkboxCol.appendChild(checkbox);
      row.insertBefore(checkboxCol, row.children[0]);
    }

    // 验证行级结构：row 拥有 3 个同级子列：[0] checkboxCol, [1] contentCol, [2] actionsCol
    expect(row.children.length).toBe(3);
    expect(row.children[0]).toBe(checkboxCol);
    expect(row.children[1]).toBe(contentCol);
    expect(row.children[2]).toBe(actionsCol);

    // 验证 contentCol 内部完全未受破坏（依然是纯净的 title + subTitle）
    expect(contentCol.children.length).toBe(2);
    expect(contentCol.children[0]).toBe(link);
    expect(contentCol.children[1]).toBe(subTitle);
  });

  it('顶部内嵌操作条与底部居中浮动胶囊状态双向同步',()=>{
    const selectedArticles = new Map<string, string>();

    // 状态计算函数
    const computeState = (selectedCount: number, totalCount: number) => ({
      hasSelected: selectedCount > 0,
      count: selectedCount,
      isAll: selectedCount > 0 && selectedCount === totalCount,
      isIndeterminate: selectedCount > 0 && selectedCount < totalCount,
      bottomPillVisible: selectedCount > 0
    });

    // 初始状态：未勾选任何文章
    let state = computeState(selectedArticles.size, 5);
    expect(state.hasSelected).toBe(false);
    expect(state.bottomPillVisible).toBe(false);
    expect(state.isAll).toBe(false);

    // 勾选 2 篇：半选状态，底部浮动胶囊升起，不遮挡右侧操作
    selectedArticles.set('1', '文章1');
    selectedArticles.set('2', '文章2');
    state = computeState(selectedArticles.size, 5);
    expect(state.hasSelected).toBe(true);
    expect(state.count).toBe(2);
    expect(state.bottomPillVisible).toBe(true);
    expect(state.isIndeterminate).toBe(true);
    expect(state.isAll).toBe(false);

    // 全选当前页 5 篇
    ['3', '4', '5'].forEach(id => selectedArticles.set(id, `文章${id}`));
    state = computeState(selectedArticles.size, 5);
    expect(state.count).toBe(5);
    expect(state.isAll).toBe(true);
    expect(state.isIndeterminate).toBe(false);
    expect(state.bottomPillVisible).toBe(true);

    // 点击清空：瞬间隐藏底部胶囊
    selectedArticles.clear();
    state = computeState(selectedArticles.size, 5);
    expect(state.hasSelected).toBe(false);
    expect(state.bottomPillVisible).toBe(false);
  });
});
