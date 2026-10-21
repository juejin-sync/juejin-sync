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
});
