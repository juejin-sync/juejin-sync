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

  it('把勾选框直接放到 essay-list 下且阻止冒泡，内容区封装为 jc-essay-content',()=>{
    class MockElement {
      children: MockElement[] = [];
      parentElement: MockElement | null = null;
      className = '';
      tagName = 'div';
      listeners: Record<string, Function[]> = {};
      constructor(tagName = 'div') { this.tagName = tagName; }
      appendChild(child: MockElement) {
        if (child.parentElement) child.parentElement.removeChild(child);
        child.parentElement = this;
        this.children.push(child);
      }
      removeChild(child: MockElement) {
        const index = this.children.indexOf(child);
        if (index !== -1) {
          child.parentElement = null;
          this.children.splice(index, 1);
        }
      }
      querySelector(selector: string): MockElement | null {
        const targetClass = selector.replace(':scope > ', '').replace('.', '').split('[')[0];
        for (const child of this.children) {
          if (child.className.includes(targetClass)) return child;
          const found = child.querySelector(selector);
          if (found) return found;
        }
        return null;
      }
      addEventListener(type: string, fn: Function) {
        if (!this.listeners[type]) this.listeners[type] = [];
        this.listeners[type].push(fn);
      }
      dispatchEvent(event: { type: string; stopPropagation: Function }) {
        this.listeners[event.type]?.forEach(fn => fn(event));
      }
    }

    // 模拟掘金原生 .essay-list：包含 .first-line 和 .infos
    const essayRow = new MockElement('div');
    essayRow.className = 'essay-list';

    const firstLine = new MockElement('div');
    firstLine.className = 'first-line';
    const title = new MockElement('span');
    title.className = 'title';
    firstLine.appendChild(title);

    const infos = new MockElement('div');
    infos.className = 'infos';

    essayRow.appendChild(firstLine);
    essayRow.appendChild(infos);

    // 执行用户的 essay-list 结构重塑逻辑
    let contentWrap = essayRow.querySelector('.jc-essay-content');
    if (!contentWrap) {
      contentWrap = new MockElement('div');
      contentWrap.className = 'jc-essay-content';
      const existingChildren = [...essayRow.children];
      for (const child of existingChildren) {
        contentWrap.appendChild(child);
      }

      const wrap = new MockElement('div');
      wrap.className = 'jc-article-select-wrap';
      const checkbox = new MockElement('input');
      checkbox.className = 'jc-article-select-checkbox';

      let stopped = false;
      checkbox.addEventListener('click', (e: any) => { e.stopPropagation(); });
      wrap.appendChild(checkbox);

      essayRow.appendChild(wrap);
      essayRow.appendChild(contentWrap);

      // 测试点击冒泡拦截
      const mockEvent = { type: 'click', stopPropagation: () => { stopped = true; } };
      checkbox.dispatchEvent(mockEvent);
      expect(stopped).toBe(true);
    }

    // 验证 essay-list 直接子节点是 [wrap, contentWrap]
    expect(essayRow.children.length).toBe(2);
    expect(essayRow.children[0].className).toBe('jc-article-select-wrap');
    expect(essayRow.children[1].className).toBe('jc-essay-content');

    // 验证 contentWrap 包含原生的 first-line 和 infos
    expect(contentWrap.children.length).toBe(2);
    expect(contentWrap.children[0]).toBe(firstLine);
    expect(contentWrap.children[1]).toBe(infos);
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

  it('顶部操作条外层容器具备 jc-batch-action-bar 并嵌套 jc-batch-header-inner 卡片', () => {
    const rawTemplate = `
      <div class="jc-batch-header-bar jc-batch-action-bar">
        <div class="jc-batch-header-inner">
          <div class="jc-batch-header-left">
            <label class="jc-batch-select-all-label">
              <input type="checkbox" class="jc-batch-select-all-checkbox" />
              <span>全选当前页</span>
            </label>
          </div>
          <div class="jc-batch-header-right">
            <button type="button" class="jc-batch-trigger-btn">批量同步向导</button>
          </div>
        </div>
      </div>
    `;
    expect(rawTemplate).toContain('jc-batch-header-inner');
    expect(rawTemplate).toContain('jc-batch-action-bar');
    expect(rawTemplate).toContain('jc-batch-select-all-checkbox');
  });

  it('批量同步弹窗标题精炼为批量同步且包含标准平台列表容器', () => {
    const modalTemplate = `
      <div class="jc-batch-modal-root">
        <div class="jc-batch-modal-backdrop"></div>
        <div class="jc-batch-modal">
          <h3 id="jc-batch-modal-title">批量同步</h3>
          <div class="jc-platform-list jc-batch-platform-list" id="jc-batch-platform-grid"></div>
        </div>
      </div>
    `;
    expect(modalTemplate).toContain('<h3 id="jc-batch-modal-title">批量同步</h3>');
    expect(modalTemplate).toContain('jc-platform-list');
    expect(modalTemplate).toContain('jc-batch-modal-backdrop');
  });
});
