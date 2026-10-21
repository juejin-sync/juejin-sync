// 核心同步逻辑回归测试：覆盖任务去重、异步重试、并发上限和 CSDN 请求契约。
import {afterEach,describe,expect,it,vi} from 'vitest';
import {Semaphore,mapConcurrent,retry} from '../src/core/async';
import {clearAllTasks,deleteTask,getArticleDraftMapping,getDraftMapping,migrateStoredTasks,saveArticleDraftMapping,toStorageTask,uniqueTasks} from '../src/core/store';
import {articleIdentityKeys,canDeleteTask,extractCsdnArticleId,findMatchingTask,isActiveTask,isInterruptedTask,isRetryableTask,isUncertainCreateTask} from '../src/core/task';
import {SyncError,classifySyncError} from '../src/core/diagnostic';
import {isSupportedMessage} from '../src/core/message';
import {defaultSettings,formatCategoryMappings,normalizeSettings,parseCategoryMappings,resolveCsdnCategories,shouldConfirmDraftUpdate} from '../src/core/settings';
import {buildTaskNotification} from '../src/core/notify';
import {fetchHealthStatus,isHealthAlert,parseHealthPayload,refreshHealthIfNeeded} from '../src/core/health';
import {fetchJuejinDraftByArticleId,fetchJuejinDraftByDraftId} from '../src/source/juejin-api';
import {isJuejinPublishRequest,parseJuejinPublishSuccess} from '../src/source/juejin-publish';
import {applyImageTransfers,buildDryRunReport,buildSaveArticleBody,buildSourceAttribution,checkCsdnAuth,collectExternalImages,downloadImageBlob,enforceImageFailurePolicy,extractSummary,fetchCsdnArticleState,fetchCsdnCategories,imageExtension,isJuejinPrivateImage,normalizeMarkdown,sanitizeJuejinContainers,saveDraftViaApi,stripJuejinImageParams,summarizeImageTransfers,validateCsdnArticle} from '../src/targets/csdn-api';
import {collectWechatImageUrls,compileWechatHtml,replaceWechatImageUrls} from '../src/targets/wechat-content';
import {buildWechatDraftForm,calculateCoverCrop,parseWechatMeta,saveWechatDraft} from '../src/targets/wechat-api';
import type {Article,SyncTask} from '../src/types';
import rules from '../rules.json';

const article:Article={id:'juejin-1',title:'测试文章',markdown:'正文内容足够长，用于测试同步请求。',tags:['TypeScript'],sourceUrl:'https://juejin.cn/post/1'};

afterEach(()=>vi.unstubAllGlobals());

describe('异步控制',()=>{
  it('失败后按次数重试并返回最终结果',async()=>{
    const operation=vi.fn().mockRejectedValueOnce(new Error('temporary')).mockResolvedValue('ok');
    await expect(retry(operation,3,0)).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('限制并发并保持结果顺序',async()=>{
    let active=0;
    let peak=0;
    const result=await mapConcurrent([1,2,3,4],2,async value=>{
      active++;
      peak=Math.max(peak,active);
      await new Promise(resolve=>setTimeout(resolve,5));
      active--;
      return value*2;
    });
    expect(result).toEqual([2,4,6,8]);
    expect(peak).toBe(2);
  });
});

describe('任务历史',()=>{
  it('同一平台文章只保留更新时间最近的任务',()=>{
    const base:SyncTask={id:'old',article,platform:'csdn',status:'failed',createdAt:'2026-09-01T00:00:00Z',updatedAt:'2026-09-01T00:00:00Z',attempts:1};
    const latest:SyncTask={...base,id:'latest',status:'saved',updatedAt:'2026-09-01T01:00:00Z'};
    expect(uniqueTasks([base,latest])).toEqual([latest]);
  });

  it('从旧版草稿链接迁移 CSDN ID 并区分可恢复与不确定任务',()=>{
    expect(extractCsdnArticleId('https://editor.csdn.net/md/?articleId=123')).toBe('123');
    const task:SyncTask={id:'working',article,platform:'csdn',status:'writing',createdAt:'2026-09-01T00:00:00Z',updatedAt:'2026-09-01T00:00:00Z',attempts:1};
    expect(isInterruptedTask(task)).toBe(false);
    expect(isUncertainCreateTask(task)).toBe(true);
    expect(isInterruptedTask({...task,csdnArticleId:'123'})).toBe(true);
    expect(isInterruptedTask({...task,status:'saved'})).toBe(false);
  });

  it('通过 draft_id 识别新建与历史流程中的同一篇文章',()=>{
    const newArticle={...article,id:'draft-9',sourceDraftId:'draft-9'};
    const historyArticle={...article,id:'article-123',sourceDraftId:'draft-9'};
    const task:SyncTask={id:'saved',article:newArticle,platform:'csdn',status:'saved',createdAt:'2026-09-01T00:00:00Z',updatedAt:'2026-09-01T00:00:00Z',attempts:1,csdnArticleId:'456'};
    expect(articleIdentityKeys(historyArticle)).toEqual(['article-123','draft-9']);
    expect(findMatchingTask([task],historyArticle)).toBe(task);
  });

  it('博客园草稿按账号隔离，并可从写入中断状态恢复',()=>{
    const base:SyncTask={id:'cnblogs-a',article,platform:'cnblogs',cnblogsAccountId:'100',cnblogsPostId:'88',status:'writing',createdAt:'2026-09-01T00:00:00Z',updatedAt:'2026-09-01T00:00:00Z',attempts:1};
    const another:SyncTask={...base,id:'cnblogs-b',cnblogsAccountId:'200'};
    expect(findMatchingTask([base,another],article,'cnblogs','200')).toBe(another);
    expect(isInterruptedTask(base)).toBe(true);
    expect(uniqueTasks([base,another])).toHaveLength(2);
  });

  it('识别活动、可重试和可删除任务',()=>{
    const base:SyncTask={id:'task',article,platform:'csdn',status:'queued',createdAt:'2026-09-01T00:00:00Z',updatedAt:'2026-09-01T00:00:00Z',attempts:0};
    expect(isActiveTask(base)).toBe(true);
    expect(canDeleteTask(base)).toBe(false);
    expect(isRetryableTask({...base,status:'failed'})).toBe(true);
    expect(canDeleteTask({...base,status:'needs-confirmation'})).toBe(true);
  });

  it('删除历史记录时独立保留草稿映射',async()=>{
    const task:SyncTask={id:'saved',article,platform:'csdn',status:'saved',createdAt:'2026-09-01T00:00:00Z',updatedAt:'2026-09-01T00:00:00Z',attempts:1,csdnArticleId:'123',draftUrl:'https://editor.csdn.net/md/?articleId=123'};
    const storage:Record<string,unknown>={syncTasks:[task]};
    vi.stubGlobal('chrome',{storage:{local:{get:vi.fn(async(key:string)=>({[key]:storage[key]})),set:vi.fn(async(value:Record<string,unknown>)=>Object.assign(storage,value))}}});
    await deleteTask(task.id);
    expect(storage.syncTasks).toEqual([]);
    await expect(getDraftMapping(article.id)).resolves.toMatchObject({csdnArticleId:'123',draftUrl:task.draftUrl});
  });

  it('为正式文章 ID 和 draft_id 保存同一份草稿映射',async()=>{
    const storage:Record<string,unknown>={};
    vi.stubGlobal('chrome',{storage:{local:{get:vi.fn(async(key:string)=>({[key]:storage[key]})),set:vi.fn(async(value:Record<string,unknown>)=>Object.assign(storage,value))}}});
    const historyArticle={...article,id:'article-123',sourceDraftId:'draft-9'};
    await saveArticleDraftMapping(historyArticle,'456','https://editor.csdn.net/md/?articleId=456');
    await expect(getDraftMapping('article-123')).resolves.toMatchObject({csdnArticleId:'456'});
    await expect(getDraftMapping('draft-9')).resolves.toMatchObject({csdnArticleId:'456'});
  });

  it('删除历史记录时独立保留微信公众号草稿映射',async()=>{
    const wechatTask:SyncTask={id:'wechat-saved',article,platform:'wechat',status:'saved',createdAt:'2026-09-01T00:00:00Z',updatedAt:'2026-09-01T00:00:00Z',attempts:1,wechatAppMsgId:'wx-999',draftUrl:'https://mp.weixin.qq.com/draft/wx-999'};
    const storage:Record<string,unknown>={syncTasks:[wechatTask]};
    vi.stubGlobal('chrome',{storage:{local:{get:vi.fn(async(key:string)=>({[key]:storage[key]})),set:vi.fn(async(value:Record<string,unknown>)=>Object.assign(storage,value))}}});
    await deleteTask(wechatTask.id);
    expect(storage.syncTasks).toEqual([]);
    await expect(getDraftMapping(article.id,'wechat')).resolves.toMatchObject({wechatAppMsgId:'wx-999',draftUrl:wechatTask.draftUrl});
    await expect(getArticleDraftMapping(article,'wechat')).resolves.toMatchObject({wechatAppMsgId:'wx-999'});
  });

  it('存在正在同步的任务时拒绝清空，任务完成后才允许清空',async()=>{
    const active:SyncTask={id:'active',article,platform:'csdn',status:'writing',createdAt:'2026-09-01T00:00:00Z',updatedAt:'2026-09-01T00:00:00Z',attempts:1};
    const storage:Record<string,unknown>={syncTasks:[active]};
    vi.stubGlobal('chrome',{storage:{local:{get:async(key:string)=>({[key]:storage[key]}),set:async(value:Record<string,unknown>)=>Object.assign(storage,value)}}});
    await expect(clearAllTasks()).rejects.toThrow('仍有文章正在同步');
    expect(storage.syncTasks).toEqual([active]);
    storage.syncTasks=[{...active,status:'saved'}];
    await expect(clearAllTasks()).resolves.toBeUndefined();
    expect(storage.syncTasks).toEqual([]);
  });
});

describe('同步设置',()=>{
  it('为旧设置补齐默认值',()=>{
    expect(normalizeSettings({syncCover:false})).toEqual({...defaultSettings,syncCover:false});
    expect(normalizeSettings({}).imageFailurePolicy).toBe('continue');
  });

  it('解析分类映射并按标签匹配、去重',()=>{
    const mappings=parseCategoryMappings('JavaScript = 前端\nTypeScript=前端\n后端 = 后端\n无效行');
    expect(formatCategoryMappings(mappings)).toBe('JavaScript = 前端\nTypeScript = 前端\n后端 = 后端');
    expect(resolveCsdnCategories(['typescript','后端'],{...defaultSettings,defaultCsdnCategory:'其他',categoryMappings:mappings})).toEqual(['前端','后端']);
    expect(resolveCsdnCategories(['产品'],{...defaultSettings,defaultCsdnCategory:'其他',categoryMappings:mappings})).toEqual(['其他']);
  });

  it('仅在开启设置且已有草稿标识时等待确认',()=>{
    expect(shouldConfirmDraftUpdate({...defaultSettings,confirmDraftUpdate:true},'123')).toBe(true);
    expect(shouldConfirmDraftUpdate({...defaultSettings,confirmDraftUpdate:true})).toBe(false);
    expect(shouldConfirmDraftUpdate(defaultSettings,'123')).toBe(false);
  });
});

describe('后台消息与失败诊断',()=>{
  it('只接受已声明的扩展消息',()=>{
    expect(isSupportedMessage({type:'GET_TASKS'})).toBe(true);
    expect(isSupportedMessage({type:'SYNC_NEW_ARTICLE'})).toBe(true);
    expect(isSupportedMessage({type:'REPORT_JUEJIN_UUID',uuid:'x'})).toBe(true);
    expect(isSupportedMessage({type:'CONFIRM_PUBLISH'})).toBe(false);
    expect(isSupportedMessage({type:'UNKNOWN'})).toBe(false);
    expect(isSupportedMessage(null)).toBe(false);
  });

  it('区分登录、限流、网络和平台接口异常',()=>{
    expect(classifySyncError(new Error('请先登录 CSDN'),'authentication')).toMatchObject({category:'login',stage:'authentication'});
    expect(classifySyncError(new Error('请求失败 (429)'),'draft')).toMatchObject({category:'rate-limit'});
    expect(classifySyncError(new Error('Failed to fetch'),'images')).toMatchObject({category:'network'});
    expect(classifySyncError(new Error('Invalid Signature'),'authentication')).toMatchObject({category:'platform-change'});
    expect(classifySyncError(new Error('CSDN API 请求失败 (403)'),'draft')).toMatchObject({category:'platform-change'});
    expect(classifySyncError(new Error('CSDN API 请求失败 (400): 标题过短'),'draft')).toMatchObject({category:'content'});
  });

  it('对诊断内容中的敏感查询参数脱敏',()=>{
    expect(classifySyncError(new Error('失败 https://example.com/?token=secret&x=1'),'draft').message).toContain('token=***');
  });

  it('结构化错误优先：5xx 凭证失败不再被误判为内容异常',()=>{
    expect(classifySyncError(new SyncError('获取 CSDN 图片上传凭证失败 (500)','network','images'),'content')).toMatchObject({category:'network',stage:'images'});
    expect(classifySyncError(new SyncError('该 CSDN 文章已公开发布，已阻断同步','blocked','draft'),'draft')).toMatchObject({category:'blocked',suggestion:expect.stringContaining('核对目标账号')});
  });
});

describe('CSDN 内容与保存契约',()=>{
  it('发送请求前按 CSDN 的 5~100 字标题规则校验',()=>{
    const completeArticle={...article,markdown:'这是长度超过二十个字符的完整正文内容，用于验证发送前的内容校验。'};
    expect(()=>validateCsdnArticle({...completeArticle,title:'测试'})).toThrow('至少需要 5 个字符');
    expect(()=>validateCsdnArticle({...completeArticle,title:'这是有效标题'})).not.toThrow();
  });

  it('清理掘金主题元数据并统一代码围栏',()=>{
    expect(normalizeMarkdown('---\ntheme: juejin\nhighlight: atom-one-dark\n---\n~~~ts\nconst a=1\n~~~')).toBe('```ts\nconst a=1\n```');
  });

  it('收集 Markdown 与 HTML 外链图片并排除 CSDN 图片',()=>{
    const markdown='![a](https://img.example.com/a.png)\n<img src="https://img.example.com/b.webp">\n![](https://img-blog.csdnimg.cn/c.png)';
    expect(collectExternalImages(markdown)).toEqual(['https://img.example.com/a.png','https://img.example.com/b.webp']);
  });

  it('图片转存不扫描或改动代码示例、普通链接及纯文本',()=>{
    const src='https://img.example.com/a.png';
    const markdown=`\`![行内](${src})\`\n\n\`\`\`md\n![围栏](${src})\n<img src="${src}">\n\`\`\`\n\n    ![缩进代码](${src})\n\n![正文](${src})\n\n[普通链接](${src})\n\n纯文本 ${src}`;
    expect(collectExternalImages(markdown)).toEqual([src]);
    const result=applyImageTransfers(markdown,undefined,[{src,target:'https://img-blog.csdnimg.cn/uploaded.png'}]);
    expect(result.markdown).toContain(`\`![行内](${src})\``);
    expect(result.markdown).toContain(`![围栏](${src})`);
    expect(result.markdown).toContain(`![缩进代码](${src})`);
    expect(result.markdown).toContain('![正文](https://img-blog.csdnimg.cn/uploaded.png)');
    expect(result.markdown).toContain(`[普通链接](${src})`);
    expect(result.markdown).toContain(`纯文本 ${src}`);
  });
  it('列表里的正文图片仍需转存，引用中的围栏代码与转义图片不转存',()=>{
    const actual='https://img.example.com/actual.png';
    const code='https://img.example.com/code.png';
    const markdown=`- 条目\n\n    ![列表图片](${actual})\n\n> \`\`\`md\n> ![示例](${code})\n> \`\`\`\n\n\\![转义](${code})`;
    expect(collectExternalImages(markdown)).toEqual([actual]);
    const result=applyImageTransfers(markdown,undefined,[{src:actual,target:'https://img-blog.csdnimg.cn/actual.png'}]);
    expect(result.markdown).toContain('![列表图片](https://img-blog.csdnimg.cn/actual.png)');
    expect(result.markdown).toContain(`![示例](${code})`);
  });

  it('根据地址或 MIME 识别图片扩展名',()=>{
    expect(imageExtension('https://example.com/a.png?x=1',new Blob([],{type:'image/jpeg'}))).toBe('png');
    expect(imageExtension('https://example.com/image',new Blob([],{type:'image/webp'}))).toBe('webp');
  });

  it('已有草稿使用 id 更新，新文章使用 is_new=1',()=>{
    const prepared={markdown:'markdown',html:'<p>markdown</p>'};
    expect(buildSaveArticleBody(article,prepared)).toMatchObject({is_new:1});
    expect(buildSaveArticleBody(article,prepared,'123')).toMatchObject({id:'123',is_new:0});
    expect(buildSaveArticleBody(article,prepared,undefined,['前端','前端','后端'])).toMatchObject({categories:'前端,后端'});
  });

  it('转存部分失败时保留正文原图并忽略失败封面',()=>{
    const source='正文 ![](https://img.example.com/body.png)';
    const result=applyImageTransfers(source,'https://img.example.com/cover.png',[
      {src:'https://img.example.com/body.png',error:'403'},
      {src:'https://img.example.com/cover.png',error:'timeout'}
    ]);
    expect(result.markdown).toBe(source);
    expect(result.cover).toBeUndefined();
    expect(result.warnings).toEqual([
      expect.stringContaining('正文图片转存失败，已保留原链接'),
      expect.stringContaining('封面转存失败，已忽略')
    ]);
    expect(summarizeImageTransfers([
      {src:'a',target:'uploaded-a'},
      {src:'b',error:'403'}
    ])).toEqual({imageTotal:2,imageSucceeded:1,imageFailed:1});
    expect(()=>enforceImageFailurePolicy([{src:'b',error:'403'}],'abort')).toThrow('已按设置终止同步');
    expect(()=>enforceImageFailurePolicy([{src:'b',error:'403'}],'continue')).not.toThrow();
  });
});

describe('平台 API 边界',()=>{
  it('翻页查找超过首批 100 篇的掘金文章',async()=>{
    const firstPage=Array.from({length:100},(_,index)=>({article_info:{article_id:String(index),draft_id:`draft-${index}`}}));
    const fetchMock=vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({err_no:0,err_msg:'',data:firstPage}),{status:200}))
      .mockResolvedValueOnce(new Response(JSON.stringify({err_no:0,err_msg:'',data:[{article_info:{article_id:'target',draft_id:'draft-target',title:'目标文章'}}]}),{status:200}))
      .mockResolvedValueOnce(new Response(JSON.stringify({err_no:0,err_msg:'',data:{article_draft:{id:'draft-target',title:'目标文章',mark_content:'这是足够长的 Markdown 正文，用于验证分页读取。',tags:[]}}}),{status:200}));
    vi.stubGlobal('fetch',fetchMock);

    await expect(fetchJuejinDraftByArticleId('target','uuid')).resolves.toMatchObject({id:'target',sourceDraftId:'draft-target',title:'目标文章'});
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({page_no:2,page_size:100});
  });

  it('将 CSDN 401 识别为未登录，将 403 签名错误识别为接口异常',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('',{status:401})));
    await expect(checkCsdnAuth()).resolves.toMatchObject({ok:true,loggedIn:false});

    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('',{status:403,headers:{'x-ca-error-message':'Invalid Signature'}})));
    await expect(checkCsdnAuth()).resolves.toMatchObject({ok:false,loggedIn:false,message:expect.stringContaining('Invalid Signature')});
  });
});

describe('v0.5.1 底座加固',()=>{
  it('全局闸门把同时执行的同步任务限制在上限内',async()=>{
    const gate=new Semaphore(2);
    let active=0;
    let peak=0;
    const results=await Promise.all(Array.from({length:6},(_,index)=>gate.run(async()=>{
      active++;
      peak=Math.max(peak,active);
      await new Promise(resolve=>setTimeout(resolve,5));
      active--;
      return index;
    })));
    expect(results).toEqual([0,1,2,3,4,5]);
    expect(peak).toBe(2);
  });

  it('任务持久化前剔除正文，升级时平滑迁移存量记录',async()=>{
    const full:SyncTask={id:'fat',article,platform:'csdn',status:'saved',createdAt:'2026-09-01T00:00:00Z',updatedAt:'2026-09-01T00:00:00Z',attempts:1,csdnArticleId:'123'};
    expect(toStorageTask(full).article.markdown).toBe('');
    expect(full.article.markdown.length).toBeGreaterThan(0);

    const storage:Record<string,unknown>={syncTasks:[full]};
    vi.stubGlobal('chrome',{storage:{local:{get:vi.fn(async(key:string)=>({[key]:storage[key]})),set:vi.fn(async(value:Record<string,unknown>)=>Object.assign(storage,value))}}});
    await expect(migrateStoredTasks()).resolves.toBe(true);
    expect((storage.syncTasks as SyncTask[])[0].article.markdown).toBe('');
    await expect(migrateStoredTasks()).resolves.toBe(false);
  });

  it('按草稿 ID 直查原始 Markdown，服务重试双路径',async()=>{
    const fetchMock=vi.fn().mockResolvedValue(new Response(JSON.stringify({err_no:0,err_msg:'',data:{article_draft:{id:'draft-9',title:'草稿标题',mark_content:'这是足够长的 Markdown 正文，用于验证按草稿直查。',tags:[{tag_name:'前端'}]}}}),{status:200}));
    vi.stubGlobal('fetch',fetchMock);
    await expect(fetchJuejinDraftByDraftId('draft-9','uuid','兜底标题')).resolves.toMatchObject({id:'draft-9',sourceDraftId:'draft-9',title:'草稿标题',markdown:expect.stringContaining('Markdown'),tags:['前端']});
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({draft_id:'draft-9'});
  });

  it('按 pubStatus 与 status 识别已发布文章，接口异常时返回 unknown',async()=>{
    const respond=(data:unknown,status=200)=>vi.fn().mockResolvedValue(new Response(JSON.stringify(data),{status}));
    vi.stubGlobal('fetch',respond({code:200,data:{pubStatus:'published'}}));
    await expect(fetchCsdnArticleState('1')).resolves.toBe('published');
    vi.stubGlobal('fetch',respond({code:200,data:{pubStatus:'draft'}}));
    await expect(fetchCsdnArticleState('1')).resolves.toBe('draft');
    vi.stubGlobal('fetch',respond({code:200,data:{status:0}}));
    await expect(fetchCsdnArticleState('1')).resolves.toBe('published');
    vi.stubGlobal('fetch',respond({code:200,data:{status:2}}));
    await expect(fetchCsdnArticleState('1')).resolves.toBe('draft');
    vi.stubGlobal('fetch',respond({code:500,data:null}));
    await expect(fetchCsdnArticleState('1')).resolves.toBe('unknown');
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('',{status:403})));
    await expect(fetchCsdnArticleState('1')).resolves.toBe('unknown');
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('',{status:401})));
    await expect(fetchCsdnArticleState('1')).resolves.toBe('unauthorized');
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('该文章不存在',{status:404})));
    await expect(fetchCsdnArticleState('1')).resolves.toBe('missing');
  });

  it.each(['network','invalid-json','missing-code','missing-id'])('CSDN 新建响应 %s 时标记为写入结果不确定',async kind=>{
    vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>{
      const url=String(input);
      if(url.includes('getBaseInfo'))return Response.json({code:200,data:{name:'tester'}});
      if(kind==='network')throw new TypeError('Failed to fetch');
      if(kind==='invalid-json')return new Response('<html>',{status:200});
      if(kind==='missing-code')return Response.json({data:{id:'created-but-unclear'}});
      return Response.json({code:200,data:{}});
    }));
    await expect(saveDraftViaApi({...article,title:'足够长的同步标题',markdown:'这是长度超过二十个字符的完整正文内容，用于验证写入结果不确定。'},{appendSourceLink:false})).rejects.toMatchObject({category:'interrupted',stage:'draft'});
  });

  it('图片上传凭证 5xx 按 abort 策略终止时归类为网络异常',async()=>{
    vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>{
      const url=String(input);
      if(url.includes('getBaseInfo'))return new Response(JSON.stringify({code:200,data:{name:'tester'}}),{status:200});
      if(url.includes('img.example.com'))return new Response(new Blob(['x'],{type:'image/png'}));
      return new Response('',{status:500});
    }));
    const imageArticle={...article,title:'足够长的同步标题',markdown:'正文包含外链图片 ![](https://img.example.com/a.png) 且长度超过二十个字符。'};
    await expect(saveDraftViaApi(imageArticle,{imageFailurePolicy:'abort'})).rejects.toMatchObject({category:'network',stage:'images'});
  });

  it('转译掘金 ::: 容器语法为引用块，且不碰代码围栏内的字面量',()=>{
    expect(sanitizeJuejinContainers(':::tips\n提示内容\n:::')).toBe('> 💡 提示：\n> 提示内容');
    expect(sanitizeJuejinContainers(':::warning 自定义标题\n第一行\n\n第二行\n:::')).toBe('> ⚠️ 注意：自定义标题\n> 第一行\n>\n> 第二行');
    expect(sanitizeJuejinContainers('```\n:::tips\n fenced\n```\n:::danger\n危险\n:::')).toBe('```\n:::tips\n fenced\n```\n> 🚨 警告：\n> 危险');
    expect(sanitizeJuejinContainers(':::custom-kind\n内容\n:::')).toBe('> ℹ️ custom-kind：\n> 内容');
    expect(normalizeMarkdown('---\ntheme: juejin\n---\n:::info\n说明\n:::')).toBe('> ℹ️ 说明：\n> 说明');
  });

  it('DNR 掘金规则收窄为草稿列表与详情两条接口路径',()=>{
    const typed=rules as {id:number;condition:{urlFilter:string}}[];
    const juejinRules=typed.filter(rule=>rule.condition.urlFilter.includes('api.juejin.cn'));
    expect(juejinRules.map(rule=>rule.condition.urlFilter).sort()).toEqual([
      '||api.juejin.cn/content_api/v1/article/list_by_user',
      '||api.juejin.cn/content_api/v1/article_draft/detail'
    ]);
  });
});

describe('v0.6.0 体验深化',()=>{
  it('摘要提取剥离代码块、图片、链接与行内标记并截断到上限',()=>{
    expect(extractSummary('# 标题\n正文 **加粗** 与 [链接文字](https://example.com) `代码`\n\n![图片](https://img.example.com/a.png)\n\n```js\nconst x=1;\n```')).toBe('标题 正文 加粗 与 链接文字 代码');
    expect(extractSummary('<div>块级 HTML</div>')).toBe('块级 HTML');
    expect(extractSummary('啊'.repeat(150),100)).toBe('啊'.repeat(100));
  });

  it('首发声明仅在存在掘金来源链接时注入',()=>{
    expect(buildSourceAttribution(article)).toBe('\n\n---\n\n> 本文首发于掘金：[测试文章](https://juejin.cn/post/1)');
    expect(buildSourceAttribution({...article,sourceUrl:' '})).toBe('');
    expect(buildSourceAttribution({...article,title:' '})).toBe('\n\n---\n\n> 本文首发于掘金：https://juejin.cn/post/1');
  });

  it('剔除掘金 CDN 图片的水印参数，其他站点与非参数链接保持原样',()=>{
    expect(stripJuejinImageParams('https://p3-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/abc.png~tplv-k3u1fbpfcp-watermark.image')).toBe('https://p3-juejin.byteimg.com/tos-cn-i-k3u1fbpfcp/abc.png');
    expect(stripJuejinImageParams('https://p6-juejin.byteimg.com/abc.png?x-oss-process=image/watermark&keep=1')).toBe('https://p6-juejin.byteimg.com/abc.png?keep=1');
    expect(stripJuejinImageParams('https://img.example.com/a.png~tplv-x?x-oss-process=y')).toBe('https://img.example.com/a.png~tplv-x?x-oss-process=y');
    expect(stripJuejinImageParams('https://p3-juejin.byteimg.com/plain.png')).toBe('https://p3-juejin.byteimg.com/plain.png');
    expect(stripJuejinImageParams('not a url')).toBe('not a url');
  });

  it('分类列表接口解析字符串数组并过滤脏数据，未登录时给出指引，兼容 categories 拼写',async()=>{
    const respond=(data:unknown,status=200)=>vi.fn().mockResolvedValue(new Response(JSON.stringify(data),{status}));
    vi.stubGlobal('fetch',respond({code:200,data:{categorys:[' 前端 ','后端','',42,null]}}));
    await expect(fetchCsdnCategories()).resolves.toEqual({ok:true,categories:['前端','后端']});
    vi.stubGlobal('fetch',respond({code:200,data:{categories:['人工智能']}}));
    await expect(fetchCsdnCategories()).resolves.toEqual({ok:true,categories:['人工智能']});
    vi.stubGlobal('fetch',respond({code:200,data:{categorys:'前端'}}));
    await expect(fetchCsdnCategories()).resolves.toMatchObject({ok:true,categories:[]});
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('',{status:401})));
    await expect(fetchCsdnCategories()).resolves.toMatchObject({ok:false,message:'请先登录 CSDN'});
  });

  it('同步预演报告汇总标题、图片、容器与分类风险',()=>{
    const dryArticle:Article={id:'juejin-dry',title:'预演文章标题',tags:['TypeScript'],sourceUrl:'https://juejin.cn/post/9',markdown:'---\ntheme: juejin\n---\n开头介绍文字。\n\n![图](https://img.example.com/a.png)\n\n:::tips\n提示\n:::\n\n```ts\nconst x=1;\n```'};
    const report=buildDryRunReport(dryArticle,defaultSettings);
    expect(report.titleLength).toBe(6);
    expect(report.imageCount).toBe(1);
    expect(report.containerCount).toBe(1);
    expect(report.codeFenceCount).toBe(1);
    expect(report.categories).toEqual([]);
    expect(report.issues).toEqual([
      '未命中任何 CSDN 分类（可在偏好设置中配置默认分类或标签映射）'
    ]);
    expect(report.notices).toEqual([
      '将在正文末尾注入首发声明（掘金原文：https://juejin.cn/post/9）'
    ]);
    expect(report.summaryPreview).toContain('开头介绍文字');
    // 配置完备的合规文章：风险清单为空，预演弹窗展示绿色就绪态
    const cleanReport=buildDryRunReport({...dryArticle,tags:[]},{...defaultSettings,defaultCsdnCategory:'前端'});
    expect(cleanReport.issues).toEqual([]);
    expect(cleanReport.notices).toEqual([
      '将在正文末尾注入首发声明（掘金原文：https://juejin.cn/post/9）'
    ]);

    const offReport=buildDryRunReport({...dryArticle,title:'短'},{...defaultSettings,autoSummary:false,appendSourceLink:false,defaultCsdnCategory:'其他'});
    expect(offReport.summaryPreview).toBe('');
    expect(offReport.categories).toEqual(['其他']);
    expect(offReport.issues).toEqual(['标题 1 字，少于 CSDN 要求的 5 字下限']);
  });

  it('长耗时或多图任务触发系统通知，短任务安静；失败任务豁免时长门槛',()=>{
    const savedTask:SyncTask={id:'notify-1',article,platform:'csdn',status:'saved',createdAt:'2026-09-01T00:00:00Z',updatedAt:'2026-09-01T00:00:00Z',attempts:1,csdnArticleId:'123',draftUrl:'https://editor.csdn.net/md/?articleId=123',stats:{imageTotal:3,imageSucceeded:2,imageFailed:1,durationMs:2000}};
    expect(buildTaskNotification(savedTask,2000)).toMatchObject({id:'notify-1',kind:'saved',title:'文章已抵达 CSDN 草稿箱',draftUrl:'https://editor.csdn.net/md/?articleId=123'});
    expect(buildTaskNotification(savedTask,2000)!.message).toContain('2/3');
    const noStats:SyncTask={...savedTask,stats:undefined};
    expect(buildTaskNotification(noStats,9000)).toBeUndefined();
    expect(buildTaskNotification(noStats,10000)).toMatchObject({kind:'saved'});
    const failedTask:SyncTask={id:'notify-2',article,platform:'csdn',status:'failed',createdAt:'2026-09-01T00:00:00Z',updatedAt:'2026-09-01T00:00:00Z',attempts:1,error:'请先登录 CSDN',diagnostic:{stage:'authentication',category:'login',message:'请先登录 CSDN',suggestion:'',occurredAt:'2026-09-01T00:00:00Z'}};
    expect(buildTaskNotification(failedTask,15000)).toMatchObject({kind:'failed',title:'掘金同步助手需要处理'});
    expect(buildTaskNotification(failedTask,15000)!.message).toContain('请先登录 CSDN');
    // 快速失败（如未登录 200ms 内失败）也必须通知，避免用户切走后误以为同步成功
    expect(buildTaskNotification({...failedTask,stats:undefined},200)).toMatchObject({kind:'failed'});
    expect(buildTaskNotification({...failedTask,status:'needs-user',stats:undefined},200)).toMatchObject({kind:'failed'});
    expect(buildTaskNotification({...failedTask,status:'writing'},15000)).toBeUndefined();
  });

  it('健康状态解析降级未知字段，仅 broken 触发警示，拉取失败静默返回无数据',async()=>{
    const healthy=parseHealthPayload({csdn:'ok',juejin:'degraded',message:'掘金接口偶发超时',updatedAt:'2026-09-17T00:00:00Z'});
    expect(healthy).toMatchObject({csdn:'ok',juejin:'degraded',message:'掘金接口偶发超时',updatedAt:'2026-09-17T00:00:00Z'});
    expect(isHealthAlert(healthy)).toBe(false);
    expect(parseHealthPayload({csdn:'broken',juejin:'mystery'})).toMatchObject({csdn:'broken',juejin:'unknown'});
    expect(isHealthAlert(parseHealthPayload({csdn:'ok',juejin:'broken',message:'x'}))).toBe(true);
    expect(parseHealthPayload('invalid')).toMatchObject({csdn:'unknown',juejin:'unknown',message:''});
    expect(isHealthAlert(undefined)).toBe(false);

    vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('offline')));
    await expect(fetchHealthStatus()).resolves.toBeUndefined();
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('',{status:500})));
    await expect(fetchHealthStatus()).resolves.toBeUndefined();
  });

  it('健康检查缓存 12 小时内跳过网络请求，过期或强制时重新拉取',async()=>{
    const store:{healthStatus?:unknown}={healthStatus:{csdn:'ok',juejin:'ok',message:'',sourceUrl:'',updatedAt:'',checkedAt:new Date().toISOString()}};
    // 注意每次调用需返回全新 Response：同一实例的 body 只能被读取一次
    const fetchMock=vi.fn().mockImplementation(async()=>new Response(JSON.stringify({csdn:'degraded',juejin:'ok'}),{status:200}));
    vi.stubGlobal('fetch',fetchMock);
    vi.stubGlobal('chrome',{storage:{local:{
      get:async(key:string)=>({[key]:store[key as keyof typeof store]}),
      set:async(patch:Record<string,unknown>)=>{Object.assign(store,patch);}
    }}});
    try{
      // 缓存新鲜：直接复用本地缓存，不发起网络请求
      await expect(refreshHealthIfNeeded()).resolves.toMatchObject({csdn:'ok'});
      expect(fetchMock).not.toHaveBeenCalled();
      // 强制刷新（alarm 到期）：发起请求并更新缓存
      await expect(refreshHealthIfNeeded(true)).resolves.toMatchObject({csdn:'degraded'});
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // 缓存过期（checkedAt 早于 12 小时）：发起请求
      store.healthStatus={csdn:'ok',juejin:'ok',message:'',sourceUrl:'',updatedAt:'',checkedAt:'2020-01-01T00:00:00Z'};
      await expect(refreshHealthIfNeeded()).resolves.toMatchObject({csdn:'degraded'});
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // 无缓存（首次安装）：发起请求
      delete store.healthStatus;
      await expect(refreshHealthIfNeeded()).resolves.toMatchObject({csdn:'degraded'});
      expect(fetchMock).toHaveBeenCalledTimes(3);
    }finally{
      vi.unstubAllGlobals();
    }
  });

  it('旧设置补齐摘要与首发声明默认值，显式关闭时保留',()=>{
    expect(normalizeSettings({})).toMatchObject({autoSummary:true,appendSourceLink:true});
    expect(normalizeSettings({autoSummary:false,appendSourceLink:false})).toMatchObject({autoSummary:false,appendSourceLink:false});
  });

  it('保存请求携带编辑器摘要字段且原创 original_link 保持留空',()=>{
    const prepared={markdown:'m',html:'<p>m</p>',summary:'自动摘要文本'};
    expect(buildSaveArticleBody(article,prepared,undefined,[],true)).toMatchObject({Description:'自动摘要文本',original_link:'',type:'original'});
    expect(buildSaveArticleBody(article,prepared,undefined,[],false)).toMatchObject({Description:''});
  });

  it('更新已删除的 CSDN 草稿报 400 时自动降级为新建草稿',async()=>{
    const bodies:string[]=[];
    vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
      const url=String(input);
      if(url.includes('getBaseInfo'))return new Response(JSON.stringify({code:200,data:{name:'tester'}}),{status:200});
      bodies.push(String(init?.body));
      return bodies.length===1
        ?new Response(JSON.stringify({code:400,msg:'该文章不存在或状态异常，请手动保存！'}),{status:400})
        :new Response(JSON.stringify({code:200,data:{id:'fresh-1',url:'https://editor.csdn.net/md/?articleId=fresh-1'}}),{status:200});
    }));
    const result=await saveDraftViaApi({...article,title:'足够长的同步标题',markdown:'这是长度超过二十个字符的完整正文内容，用于验证删除降级新建流程。'},{articleId:'deleted-1'});
    expect(result).toMatchObject({articleId:'fresh-1',draftUrl:'https://editor.csdn.net/md/?articleId=fresh-1'});
    expect(JSON.parse(bodies[0])).toMatchObject({id:'deleted-1',is_new:0});
    expect(JSON.parse(bodies[1])).toMatchObject({is_new:1});
    expect(JSON.parse(bodies[1]).id).toBeUndefined();
  });

  it('CSDN 400 频控「文章频繁发布」触发自动退避并在重试成功后返回',async()=>{
    let attempts=0;
    vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>{
      const url=String(input);
      if(url.includes('getBaseInfo'))return new Response(JSON.stringify({code:200,data:{name:'tester'}}),{status:200});
      attempts++;
      if(attempts===1){
        return new Response(JSON.stringify({code:400,msg:'文章频繁发布，请稍后再试'}),{status:400});
      }
      return new Response(JSON.stringify({code:200,data:{id:'rate-ok-1',url:'https://editor.csdn.net/md/?articleId=rate-ok-1'}}),{status:200});
    }));
    const result=await saveDraftViaApi(
      {...article,title:'足够长的同步标题',markdown:'这是长度超过二十个字符的完整正文内容，用于验证频控重试流程。'},
      {rateLimitDelayMs:0}
    );
    expect(result).toMatchObject({articleId:'rate-ok-1'});
    expect(attempts).toBe(2);
  });

  it('CSDN 400 频控重试后仍失败时精准归类为 rate-limit 而非 platform-change',async()=>{
    vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>{
      const url=String(input);
      if(url.includes('getBaseInfo'))return new Response(JSON.stringify({code:200,data:{name:'tester'}}),{status:200});
      return new Response(JSON.stringify({code:400,msg:'文章频繁发布，请稍后再试'}),{status:400});
    }));
    await expect(saveDraftViaApi(
      {...article,title:'足够长的同步标题',markdown:'这是长度超过二十个字符的完整正文内容，用于验证频控错误分类。'},
      {rateLimitDelayMs:0}
    )).rejects.toMatchObject({category:'rate-limit',message:expect.stringContaining('CSDN 发文过于频繁')});
  });
});

describe('掘金发布成功观察',()=>{
  const url='https://api.juejin.cn/content_api/v1/article/publish?aid=2608&uuid=test';
  it('只识别发布接口 POST 请求',()=>{
    expect(isJuejinPublishRequest(url,'POST')).toBe(true);
    expect(isJuejinPublishRequest('https://juejin.cn/content_api/v1/article/publish','POST')).toBe(true);
    expect(isJuejinPublishRequest(url,'GET')).toBe(false);
    expect(isJuejinPublishRequest('https://api.juejin.cn/content_api/v1/article_draft/update','POST')).toBe(false);
    expect(isJuejinPublishRequest('https://example.com/content_api/v1/article/publish','POST')).toBe(false);
  });
  it('业务成功且包含文章标识时返回草稿与文章身份',()=>{
    expect(parseJuejinPublishSuccess(url,'POST',JSON.stringify({draft_id:'draft-1'}),200,JSON.stringify({err_no:0,err_msg:'success',data:{article_id:'article-1'}})))
      .toEqual({draftId:'draft-1',articleId:'article-1'});
    expect(parseJuejinPublishSuccess(url,'POST',JSON.stringify({draft_id:'draft-1'}),200,JSON.stringify({err_no:0,data:{draft_id:'draft-1',article_id:123}})))
      .toEqual({draftId:'draft-1',articleId:'123'});
  });
  it.each([
    [500,{err_no:0,data:{article_id:'article-1'}}],
    [200,{err_no:2,err_msg:'参数错误',data:null}],
    [200,{err_no:0,data:{}}],
    [200,{err_no:0,data:{article_id:'0'}}],
    [200,{err_no:0,data:{article_id:0}}]
  ])('HTTP 或业务响应不完整或缺少有效文章 ID 时不触发同步', (status,response)=>{
    expect(parseJuejinPublishSuccess(url,'POST',JSON.stringify({draft_id:'draft-1'}),status,JSON.stringify(response))).toBeUndefined();
  });
  it('请求缺少草稿身份时不触发同步',()=>{
    expect(parseJuejinPublishSuccess(url,'POST','{}',200,JSON.stringify({err_no:0,data:{article_id:'article-1'}}))).toBeUndefined();
    expect(parseJuejinPublishSuccess(url,'POST',JSON.stringify({draft_id:'0'}),200,JSON.stringify({err_no:0,data:{article_id:'article-1'}}))).toBeUndefined();
  });
});

describe('v1.0.0 微信公众号完整同步',()=>{
  it('从公众平台首页提取账号、令牌和图片上传票据',()=>{
    const html='window.wx.commonData={data:{t:"123456",ticket:"ticket-x",user_name:"gh_test",nick_name:"测试公众号",time:"1789000000"}}';
    expect(parseWechatMeta(html)).toEqual({token:'123456',ticket:'ticket-x',userName:'gh_test',nickName:'测试公众号',svrTime:1789000000});
    expect(parseWechatMeta('<html>login</html>')).toBeUndefined();
  });

  it('按微信约束重新生成内联样式 HTML 并移除外链跳转',()=>{
    const html=compileWechatHtml('## 小标题\n\n正文 **加粗** 与 [外链](https://example.com)。\n\n![图](https://img.example.com/a.png)\n\n```ts\nconst x = 1 < 2\n```');
    expect(html).toContain('border-left:4px solid');
    expect(html).toContain('<strong style=');
    expect(html).not.toContain('href="https://example.com"');
    expect(html).toContain('src="https://img.example.com/a.png"');
    expect(html).toContain('&lt;');
    expect(html).not.toContain('<script');
  });

  it('将正文图片地址替换为微信 CDN 地址',()=>{
    const html=compileWechatHtml('![图](https://img.example.com/a.png?x=1&y=2)');
    const replaced=replaceWechatImageUrls(html,new Map([['https://img.example.com/a.png?x=1&y=2','https://mmbiz.qpic.cn/new.png']]));
    expect(replaced).toContain('https://mmbiz.qpic.cn/new.png');
    expect(replaced).not.toContain('img.example.com');
  });

  it('识别 Markdown 与 HTML 图片且不漏掉 CSDN 图床来源',()=>{
    const html=compileWechatHtml('![](https://img-blog.csdnimg.cn/a.png)\n\n<img src="https://example.com/b.webp">');
    expect(collectWechatImageUrls(html)).toEqual(['https://img-blog.csdnimg.cn/a.png','https://example.com/b.webp']);
  });

  it('居中计算三种封面裁剪比例并写入草稿契约',()=>{
    expect(calculateCoverCrop('1_1',1200,800)).toMatchObject({x1:1/6,y1:0,x2:5/6,y2:1,x1Abs:200,x2Abs:1000});
    const meta={token:'123',ticket:'t',userName:'gh_x',nickName:'公众号',svrTime:1};
    const config=calculateCoverCrop('16_9',1600,900);
    const form=buildWechatDraftForm({...article,title:'微信公众号测试文章',summary:'摘要'},'<p>正文</p>',meta,[{cdnurl:'https://mmbiz.qpic.cn/cover.jpg',file_id:99,width:1600,height:900,config}]);
    expect(form.get('cdn_url0')).toBe('https://mmbiz.qpic.cn/cover.jpg');
    expect(form.get('cdn_16_9_url0')).toBe('https://mmbiz.qpic.cn/cover.jpg');
    expect(form.get('content0')).toBe('<p>正文</p>');
    expect(JSON.parse(form.get('crop_list0')!)).toMatchObject({crop_list:[{ratio:'16_9',file_id:99}]});
  });

  it('正确编译无序列表、有序列表与嵌套列表且不触发 list_item 异常',()=>{
    const md=`
- 无序列表项 1
- 无序列表项 2
  - 子列表项 A
  - 子列表项 B
1. 有序列表项 1
2. 有序列表项 2
`;
    const html=compileWechatHtml(md);
    expect(html).toContain('<ul style=');
    expect(html).toContain('<ol style=');
    expect(html).toContain('<li style=');
    expect(html).toContain('无序列表项 1');
    expect(html).toContain('子列表项 A');
    expect(html).toContain('有序列表项 1');
  });

  it('更新微信草稿时表单携带 AppMsgId 参数',()=>{
    const meta={token:'123',ticket:'t',userName:'gh_x',nickName:'公众号',svrTime:1};
    const config=calculateCoverCrop('16_9',1600,900);
    const form=buildWechatDraftForm(article,'<p>正文</p>',meta,[{cdnurl:'https://mmbiz.qpic.cn/cover.jpg',file_id:99,width:1600,height:900,config}],'appmsg-123456');
    expect(form.get('AppMsgId')).toBe('appmsg-123456');
  });

  it('微信更新遇到 500 暂停核对，不再隐式新建草稿',async()=>{
    const testArticle={...article,markdown:'这是一篇用来测试微信公众号草稿自动降级新建的长文章内容。',cover:'https://example.com/cover.jpg'};
    let callCount=0;
    const fetchMock=vi.fn(async(url:string|URL)=>{
      const href=String(url);
      if(href==='https://mp.weixin.qq.com/'||href==='https://mp.weixin.qq.com')return{ok:true,status:200,text:async()=>'window.wx.commonData={data:{t:"123456",ticket:"ticket-x",user_name:"gh_test",nick_name:"测试公众号",time:"1789000000"}};'};
      if(href.includes('/cgi-bin/cropimage'))return{ok:true,status:200,json:async()=>({base_resp:{err_msg:'ok'},result:[{cdnurl:'https://mmbiz.qpic.cn/c1',file_id:1,width:1600,height:900},{cdnurl:'https://mmbiz.qpic.cn/c2',file_id:2,width:900,height:900},{cdnurl:'https://mmbiz.qpic.cn/c3',file_id:3,width:900,height:1200}]})};
      if(href.includes('/cgi-bin/filetransfer'))return{ok:true,status:200,json:async()=>({base_resp:{err_msg:'ok'},cdn_url:'https://mmbiz.qpic.cn/img1'})};
      if(href.includes('example.com/cover.jpg'))return{ok:true,status:200,blob:async()=>new Blob(['dummy-bytes'],{type:'image/jpeg'})};
      if(href.includes('/cgi-bin/operate_appmsg')){
        callCount++;
        if(href.includes('sub=edit')){
          return{ok:false,status:500,json:async()=>({base_resp:{ret:-1,err_msg:'appmsg not exist'}})};
        }
        if(href.includes('sub=create')){
          return{ok:true,json:async()=>({appMsgId:88888,base_resp:{ret:0,err_msg:'ok'}})};
        }
      }
      return{ok:true,text:async()=>''};
    });
    vi.stubGlobal('fetch',fetchMock);
    vi.stubGlobal('createImageBitmap',vi.fn(async()=>({width:1600,height:900,close:()=>{}})));
    await expect(saveWechatDraft(testArticle,{appMsgId:'old-deleted-draft-id',accountId:'gh_test'})).rejects.toMatchObject({category:'interrupted'});
    expect(callCount).toBe(1);
  });
});

describe('掘金私有图床与防盗链支持',()=>{
  const samplePrivateUrl='https://p0-xtjj-private.juejin.cn/tos-cn-i-73owjymdk6/f769cd7aad8e4c0d9af66abef25ee254~tplv-73owjymdk6-jj-mark-v1:0:0:0:0:5o6Y6YeR5oqA5pyv56S-5Yy6IEAg5aSP5aSp6KaB5Zad5Yaw5Y-v5LmQ:q75.awebp?policy=eyJ2bSI6MywidWlkIjoiNDI2NTc2MDg0NTQ2ODI5NiJ9&rk3s=e9ecf3d6&x-orig-authkey=f32326d3454f2ac7e96d3d06cdbb035152127018&x-orig-expires=1790226146&x-orig-sign=iUtmyS0OiBNnkohnQQvZPjmMC7o%3D';

  it('准确识别掘金私有存储与带签名外链图片',()=>{
    expect(isJuejinPrivateImage(samplePrivateUrl)).toBe(true);
    expect(isJuejinPrivateImage('https://p1-xtjj-private.juejin.cn/abc.png')).toBe(true);
    expect(isJuejinPrivateImage('https://example.com/pic.jpg?x-orig-sign=123')).toBe(true);
    expect(isJuejinPrivateImage('https://p3-juejin.byteimg.com/plain.png')).toBe(false);
    expect(isJuejinPrivateImage('https://img.example.com/a.png')).toBe(false);
  });

  it('私有签名图片原样保留，绝不裁剪破坏路径签名',()=>{
    expect(stripJuejinImageParams(samplePrivateUrl)).toBe(samplePrivateUrl);
    const escaped=samplePrivateUrl.replace(/&/g,'&amp;');
    expect(stripJuejinImageParams(escaped)).toBe(escaped);
  });

  it('DNR 规则包含私有图床防盗链伪装规则',()=>{
    const typed=rules as {id:number;action:{requestHeaders:{header:string;value:string}[]};condition:{urlFilter?:string}}[];
    const privateRule=typed.find(r=>r.id===9);
    expect(privateRule).toBeDefined();
    expect(privateRule?.condition.urlFilter).toBe('-private.juejin.cn/');
    expect(privateRule?.action.requestHeaders).toEqual([
      {header:'Origin',operation:'set',value:'https://juejin.cn'},
      {header:'Referer',operation:'set',value:'https://juejin.cn/'}
    ]);
  });

  it('下载私有图片时直连 403 自动降级通过打开的掘金 Tab 代下',async()=>{
    const dataUrl='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>{
      const url=String(input);
      if(url.startsWith('data:image/'))return new Response(new Blob(['fake-img'],{type:'image/png'}));
      return new Response('',{status:403});
    }));
    vi.stubGlobal('chrome',{
      tabs:{
        query:vi.fn().mockResolvedValue([{id:101,url:'https://juejin.cn/editor/drafts/123',active:true}]),
        sendMessage:vi.fn().mockResolvedValue({ok:true,dataUrl})
      }
    });

    const blob=await downloadImageBlob(samplePrivateUrl);
    expect(blob.type).toBe('image/png');
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(101,{type:'DOWNLOAD_IMAGE_VIA_PAGE',url:samplePrivateUrl});
  });

  it('下载私有图片时直连 403 且无可用 Tab 代下时抛出网络/内容异常',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('',{status:403})));
    vi.stubGlobal('chrome',{
      tabs:{
        query:vi.fn().mockResolvedValue([]),
        sendMessage:vi.fn()
      }
    });
    await expect(downloadImageBlob(samplePrivateUrl)).rejects.toThrow('图片下载失败 (403)');
  });
});
