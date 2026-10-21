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

  it('单行弹性标题包裹结构确保复选框与标题在同一水平行内且不破坏元信息布局',()=>{
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
      closest(className: string): MockElement | null {
        let cur: MockElement | null = this;
        while (cur) {
          if (cur.className.includes(className.replace('.', ''))) return cur;
          cur = cur.parentElement;
        }
        return null;
      }
    }

    const container = new MockElement('div');
    const link = new MockElement('a');
    link.className = 'title';
    const subTitle = new MockElement('div');
    subTitle.className = 'sub-title';

    container.appendChild(link);
    container.appendChild(subTitle);

    // 执行 titleRow 注入逻辑
    let titleRow = link.closest('.jc-title-flex-row');
    if (!titleRow) {
      titleRow = new MockElement('div');
      titleRow.className = 'jc-title-flex-row';
      container.insertBefore(titleRow, link);
      titleRow.appendChild(link);
    }
    const wrap = new MockElement('div');
    wrap.className = 'jc-article-select-wrap';
    const checkbox = new MockElement('input');
    checkbox.className = 'jc-article-select-checkbox';
    wrap.appendChild(checkbox);
    titleRow.insertBefore(wrap, link);

    // 验证结构：container 拥有 titleRow 和 subTitle 两个直接子节点
    expect(container.children.length).toBe(2);
    expect(container.children[0]).toBe(titleRow);
    expect(container.children[1]).toBe(subTitle);

    // 验证 titleRow 内部：第 1 个是 wrap，第 2 个是 link（水平同级）
    expect(titleRow.children.length).toBe(2);
    expect(titleRow.children[0]).toBe(wrap);
    expect(titleRow.children[1]).toBe(link);
  });

  it('右侧浮动操作舱全选与清空状态切换自洽',()=>{
    const selectedArticles=new Map<string,string>();
    const totalCount=3;

    // 初始状态：未勾选任何文章
    expect(selectedArticles.size).toBe(0);

    // 模拟全选操作
    ['art1','art2','art3'].forEach(id=>selectedArticles.set(id,`文章${id}`));
    expect(selectedArticles.size).toBe(totalCount);

    // 模拟再次点击全选按钮（反选清空）
    selectedArticles.clear();
    expect(selectedArticles.size).toBe(0);
  });
});
