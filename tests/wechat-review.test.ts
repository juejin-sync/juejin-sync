// v1.0 review 回归：验证写入安全、账号隔离、内容保真和弹窗状态，不访问真实平台。
import {afterEach,describe,expect,it,vi} from 'vitest';
import {saveWechatDraft} from '../src/targets/wechat-api';
import {collectWechatImageUrls,compileWechatHtml,replaceWechatImageUrls} from '../src/targets/wechat-content';
import {dataUrlToBlob} from '../src/targets/csdn-api';
import {extractMermaidBlocks,renderAllMermaidBlocks,renderMermaidToPng} from '../src/core/mermaid-render';
import {deleteTask,getArticleDraftMapping,saveArticleDraftMapping,uniqueTasks} from '../src/core/store';
import {findMatchingTask,isRetryableTask} from '../src/core/task';
import {refreshPlatformSelection,syncReplyState} from '../src/core/sync-dialog';
import {EditorMetadataCache} from '../src/source/editor-metadata';
import {fetchJuejinDraftByArticleId} from '../src/source/juejin-api';
import type {Article,PlatformId,SyncTask} from '../src/types';

const article:Article={id:'source-1',title:'测试同步文章',markdown:'这是一篇超过二十个字符的测试文章，用于验证微信同步行为。',tags:[],sourceUrl:'https://juejin.cn/post/1'};
const meta=(account='gh_a')=>`{t:"123",ticket:"ticket",user_name:"${account}",nick_name:"测试公众号"}`;
function mockWechat(write:()=>Response|Promise<Response>,accounts=['gh_a','gh_a']){
  let authCount=0;
  return vi.fn(async(input:RequestInfo|URL)=>{
    const url=String(input);
    if(url==='https://mp.weixin.qq.com/')return new Response(meta(accounts[Math.min(authCount++,accounts.length-1)]));
    if(url.includes('operate_appmsg'))return write();
    if(url.includes('filetransfer'))return Response.json({base_resp:{err_msg:'ok'},cdn_url:'https://mmbiz.qpic.cn/transferred',content:'10'});
    if(url.includes('cropimage'))return Response.json({base_resp:{err_msg:'ok'},result:[1,2,3].map(id=>({cdnurl:`https://mmbiz.qpic.cn/c${id}`,file_id:id,width:100,height:100}))});
    return new Response(new Blob(['image'],{type:'image/png'}));
  });
}
const success=()=>Response.json({appMsgId:'draft-1',base_resp:{ret:0,err_msg:'ok'}});
afterEach(()=>vi.unstubAllGlobals());

describe('微信写入安全',()=>{
  it.each([400,401,429,500])('更新返回 %i 不会降级新建',async status=>{
    const fetch=mockWechat(()=>Response.json({base_resp:{ret:-1,err_msg:'rejected'}},{status}));
    vi.stubGlobal('fetch',fetch);
    await expect(saveWechatDraft(article,{appMsgId:'old',accountId:'gh_a'})).rejects.toBeDefined();
    const writes=fetch.mock.calls.filter(([url])=>String(url).includes('operate_appmsg'));
    expect(writes).toHaveLength(1);
    expect(String(writes[0][0])).toContain('sub=edit');
  });
  it.each(['network','json','empty','missing-id'])('新建 %s 响应不确定时禁止批量重试',async kind=>{
    vi.stubGlobal('fetch',mockWechat(()=>{
      if(kind==='network')throw new TypeError('Failed to fetch');
      if(kind==='json')return new Response('<html>gateway</html>');
      return Response.json(kind==='empty'?{}:{base_resp:{ret:0}});
    }));
    await expect(saveWechatDraft(article)).rejects.toMatchObject({category:'interrupted',stage:'draft'});
    expect(isRetryableTask({status:'needs-user',diagnostic:{category:'interrupted'}} as SyncTask)).toBe(false);
  });
  it('初始账号不匹配时不上传也不写入',async()=>{
    const fetch=mockWechat(success);
    vi.stubGlobal('fetch',fetch);
    await expect(saveWechatDraft(article,{accountId:'gh_b'})).rejects.toMatchObject({category:'blocked'});
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('最终保存前切换账号时阻断写入',async()=>{
    const fetch=mockWechat(success,['gh_a','gh_b']);
    vi.stubGlobal('fetch',fetch);
    await expect(saveWechatDraft(article,{accountId:'gh_a'})).rejects.toMatchObject({category:'blocked'});
    expect(fetch.mock.calls.some(([url])=>String(url).includes('operate_appmsg'))).toBe(false);
  });
  it('旧草稿无账号绑定时禁止猜测归属',async()=>{
    const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
    await expect(saveWechatDraft(article,{appMsgId:'legacy'})).rejects.toMatchObject({category:'blocked'});
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([false,true])('无封面文章可以保存，正文有图=%s',async withImage=>{
    const fetch=mockWechat(success);vi.stubGlobal('fetch',fetch);
    const result=await saveWechatDraft({...article,markdown:article.markdown+(withImage?'\n\n![图](https://example.com/a.png)':'')});
    expect(result.articleId).toBe('draft-1');
    expect(result.stats.imageTotal).toBe(withImage?1:0);
    expect(result.warnings).toHaveLength(0);
    expect(fetch.mock.calls.some(([url])=>String(url).includes('cropimage'))).toBe(false);
  });
  it('有封面时仍完整上传裁剪，失败不伪装成功',async()=>{
    vi.stubGlobal('createImageBitmap',vi.fn(async()=>({width:1600,height:900,close:()=>{}})));
    const fetch=mockWechat(success);vi.stubGlobal('fetch',fetch);
    expect((await saveWechatDraft({...article,cover:'https://example.com/cover.png'})).stats.imageTotal).toBe(1);
    expect(fetch.mock.calls.some(([url])=>String(url).includes('cropimage'))).toBe(true);
  });
  it.each([1,-1,200040,987654])('更新返回业务错误 %i 不自动新建',async ret=>{
    const fetch=mockWechat(()=>Response.json({base_resp:{ret,err_msg:''}}));
    vi.stubGlobal('fetch',fetch);
    await expect(saveWechatDraft(article,{appMsgId:'old',accountId:'gh_a'})).rejects.toMatchObject({category:'platform-change'});
    const writes=fetch.mock.calls.filter(([url])=>String(url).includes('operate_appmsg'));
    expect(writes).toHaveLength(1);
    expect(String(writes[0][0])).toContain('sub=edit');
  });
  it('Mermaid 渲染不可用时不上传图片也不保存缺图草稿',async()=>{
    const fetch=mockWechat(success);vi.stubGlobal('fetch',fetch);
    vi.stubGlobal('chrome',{});
    await expect(saveWechatDraft({...article,markdown:article.markdown+'\n\n```mermaid\nflowchart TD\nA-->B\n```'})).rejects.toMatchObject({category:'content'});
    expect(fetch.mock.calls.some(([url])=>/operate_appmsg|filetransfer/.test(String(url)))).toBe(false);
  });
  it('微信接口返回登录过期 (ret: 200003) 时正确归类为 login 错误',async()=>{
    const fetch=mockWechat(()=>Response.json({base_resp:{ret:200003,err_msg:''}}));
    vi.stubGlobal('fetch',fetch);
    await expect(saveWechatDraft(article,{accountId:'gh_a'})).rejects.toMatchObject({category:'login'});
  });
  it('微信接口返回错误时错误提示使用 ret 代码而不是 HTTP 200',async()=>{
    const fetch=mockWechat(()=>Response.json({base_resp:{ret:999999,err_msg:''}}));
    vi.stubGlobal('fetch',fetch);
    await expect(saveWechatDraft(article,{accountId:'gh_a'})).rejects.toThrow('错误码 (999999)');
  });
});

describe('内容保真和元信息隔离',()=>{
  it('微信排版与防断行：加粗标题与后续标点（冒号/逗号）杜绝因空格、换行、<br> 或 &nbsp; 导致的分行',()=>{
    const md1 = '1. **三维到二维投影**  \n   : 利用 `Vector3.project(camera)` 将世界坐标映射为屏幕像素坐标';
    const html1 = compileWechatHtml(md1);
    expect(html1).toContain('<strong style="font-weight:700;color:#2b2b2b;display:inline;">三维到二维投影</strong>: 利用');
    expect(html1).not.toContain('<br>:');
    expect(html1).not.toContain('<br>');

    const md2 = '* **在上篇中**  \n  , 我们见证了 Google Antigravity + Blender MCP';
    const html2 = compileWechatHtml(md2);
    expect(html2).toContain('<strong style="font-weight:700;color:#2b2b2b;display:inline;">在上篇中</strong>, 我们见证了');
    expect(html2).not.toContain('<br>,');
    expect(html2).not.toContain('在上篇中</strong><br>');

    const md3 = '* **在上篇中**\n&nbsp;&nbsp;, 我们见证了英文字符逗号场景';
    const html3 = compileWechatHtml(md3);
    expect(html3).toContain('<strong style="font-weight:700;color:#2b2b2b;display:inline;">在上篇中</strong>, 我们见证了');

    const md4 = '**视觉语言**  \n：全自主工业装卸物流';
    const html4 = compileWechatHtml(md4);
    expect(html4).toContain('<strong style="font-weight:700;color:#2b2b2b;display:inline;">视觉语言</strong>：全自主');

    const userCase1 = '- **在上篇中**\n  ，我们见证了 Google Antigravity + Blender MCP 带来的颠覆性效率：让 AI Agent 充当“手持游标卡尺的 3D 建模师”，打通了 3D 资产自动生成的最后一公里；';
    const htmlUser1 = compileWechatHtml(userCase1);
    expect(htmlUser1).toContain('<strong style="font-weight:700;color:#2b2b2b;display:inline;">在上篇中</strong>，我们见证了 Google Antigravity');
    expect(htmlUser1).not.toContain('</strong>\n');
    expect(htmlUser1).not.toContain('</strong><br');
    expect(htmlUser1).not.toContain('在上篇中</strong> ，');

    const userCase2 = '1. **三维到二维投影**\n  ：利用 `Vector3.project(camera)` 将世界坐标映射为屏幕像素坐标 (rawX, rawY)；\n2. **自适应上下智能翻转**\n  ：默认优先展示在目标正上方；当物体靠近屏幕顶部时（上方空间小于 45px），卡片自动智能翻转至物体下方展示；';
    const htmlUser2 = compileWechatHtml(userCase2);
    expect(htmlUser2).toContain('<strong style="font-weight:700;color:#2b2b2b;display:inline;">三维到二维投影</strong>：利用');
    expect(htmlUser2).toContain('<strong style="font-weight:700;color:#2b2b2b;display:inline;">自适应上下智能翻转</strong>：默认优先展示');
    expect(htmlUser2).not.toContain('</strong>\n');
    expect(htmlUser2).not.toContain('</strong><br');
    expect(htmlUser2).not.toContain('三维到二维投影</strong> ：');
    expect(htmlUser2).not.toContain('自适应上下智能翻转</strong> ：');

    // 兼容下划线加粗与 HTML 标签加粗（均同行绝不断行）
    const htmlUnderline = compileWechatHtml('1. __三维到二维投影__\n  ：利用算法；\n- **在上篇中**\n  ，见证效率。');
    expect(htmlUnderline).toContain('三维到二维投影</strong>：利用算法');
    expect(htmlUnderline).toContain('在上篇中</strong>，见证效率');
  });

  it('非 HTTP(S) 锚点链接与空链接不生成文末参考链接和角标',()=>{
    const md = '这是一个 [内部锚点](#) 和 [空哈希](#section) 以及 [真实链接](https://juejin.cn/post/1)。';
    const html = compileWechatHtml(md);
    expect(html).toContain('内部锚点</span>');
    expect(html).not.toContain('内部锚点</span><sup>');
    expect(html).toContain('空哈希</span>');
    expect(html).not.toContain('空哈希</span><sup>');
    expect(html).toContain('真实链接</span><sup>[1]</sup>');
    expect(html).toContain('<section style="margin-top:28px;font-size:13px;word-break:break-all;"><p>参考链接</p><p>[1] https://juejin.cn/post/1</p></section>');
    expect(html).not.toContain('[2]');
    expect(html).not.toContain('<p>[1] #');
    expect(html).not.toContain(']#');
  });
  it('使用用户提供的微信原生结构与 Mac 三色圆点，逐行保留空行和缩进',()=>{
    const html=compileWechatHtml('```js\nimport React from "react";\n\nfunction demo() {\n\treturn 1;\n}\n```');
    expect(html).toContain('class="code-snippet__js code-snippet__custom"');
    expect(html).toContain('class="code-snippet__header"');
    expect(html).toContain('data-lang="javascript"');
    expect(html.match(/<code><span leaf="">/g)).toHaveLength(5);
    expect(html).toContain('<code><span leaf="">&nbsp;</span></code>');
    expect(html).toContain('return');
    expect(html).not.toContain('<br');
    expect(html).not.toContain('>code</p>');
  });
  it.each([['kotlin','kotlin'],['ts title="demo"','typescript'],['',''],['html','html']])('语言标记 %s 不被固定成示例的 kotlin', (language,expected)=>{
    const html=compileWechatHtml('```'+language+'\nconst value = 1;\n```');
    expect(html).toContain(`data-lang="${expected}"`);
  });
  it('原生代码行可还原 JSX、比较符、引号和连续缩进，不注入外部 class 标签',()=>{
    const code='async loadStations() {\n  if (this.loading) return;\n\n  const view = <Panel value="a & b" />;\n  if (a < b && b > 0) return view;\n}';
    const html=compileWechatHtml('```javascript\n'+code+'\n```');
    const restored=[...html.matchAll(/<code><span leaf="">([\s\S]*?)<\/span><\/code>/g)].map(([,line])=>line==='&nbsp;'?'':line.replace(/<[^>]+>/g,'').replace(/&nbsp;/g,' ').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&amp;/g,'&')).join('\n');
    expect(restored).toBe(code);
    expect(html).not.toContain('<Panel');
    expect(html).not.toContain('class="hljs-keyword"');
  });
  it('代码围栏和行内代码中的 HTML 保持原样且不作为图片上传',()=>{
    const html=compileWechatHtml('```html\n<script>alert(1)</script>\n<style>.x{color:red}</style>\n<img src="https://example.com/code.png">\n```\n\n`<img src="https://example.com/inline.png">`');
    expect(html).toContain('alert');
    expect(html).toContain('.x');
    expect(html).toContain('red}');
    expect(html).toContain('https://example.com/code.png');
    expect(collectWechatImageUrls(html)).toEqual([]);
  });
  it('实际 HTML 脚本不透传，HTML 图片仍可转存',()=>{
    const html=compileWechatHtml('<script>alert(1)</script>\n\n<img src="https://example.com/a.png" onerror="alert(1)">');
    expect(html).not.toContain('alert(1)');
    expect(collectWechatImageUrls(html)).toEqual(['https://example.com/a.png']);
  });
  it('参考链接去重编号，图片替换不修改代码与参考地址',()=>{
    const url='https://example.com/a.png';
    const html=compileWechatHtml(`[文档](${url}) [同一文档](${url})\n\n![图片](${url})\n\n\`${url}\``);
    expect(html).toContain('参考链接');
    expect(html.match(/<sup>\[1\]<\/sup>/g)).toHaveLength(2);
    const replaced=replaceWechatImageUrls(html,new Map([[url,'https://mmbiz.qpic.cn/a']]));
    expect(collectWechatImageUrls(replaced)).toEqual(['https://mmbiz.qpic.cn/a']);
    expect(replaced).toContain(`[1] ${url}`);
    expect(replaced).toContain(`${url}</span>`);
  });
  it('清空封面摘要生效，切换草稿不串用，晚到响应留在原草稿',()=>{
    const cache=new EditorMetadataCache();
    cache.remember('a',{cover_image:'a.jpg',brief_content:'摘要'});
    expect(cache.get('b').cover).toBeUndefined();
    cache.remember('b',{cover_image:'',brief_content:''});
    cache.remember('a',{cover_image:'late-a.jpg'});
    expect(cache.get('b')).toMatchObject({cover:'',summary:''});
    cache.remember('a',{cover_image:'',brief_content:''});
    expect(cache.get('a')).toMatchObject({cover:'',summary:''});
  });
  it('历史草稿明确无封面时，不回退到文章列表的旧封面',async()=>{
    vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>Response.json({err_no:0,data:String(input).includes('list_by_user')
      ?[{article_info:{article_id:'1',draft_id:'draft-1',cover_image:'old-cover.jpg'}}]
      :{article_draft:{id:'draft-1',mark_content:article.markdown,cover_image:''}}})));
    expect((await fetchJuejinDraftByArticleId('1','uuid')).cover).toBe('');
  });
});

describe('任务身份与弹窗结果',()=>{
  it('两个公众号映射及删除后的映射各自保留',async()=>{
    const store:Record<string,unknown>={};
    vi.stubGlobal('chrome',{storage:{local:{get:async(key:string)=>({[key]:store[key]}),set:async(patch:Record<string,unknown>)=>Object.assign(store,patch)}}});
    await saveArticleDraftMapping(article,'draft-a',undefined,'wechat','gh_a');
    await saveArticleDraftMapping(article,'draft-b',undefined,'wechat','gh_b');
    expect(await getArticleDraftMapping(article,'wechat','gh_a')).toMatchObject({wechatAppMsgId:'draft-a'});
    expect(await getArticleDraftMapping(article,'wechat','gh_b')).toMatchObject({wechatAppMsgId:'draft-b'});
    expect(await getArticleDraftMapping(article,'wechat')).toBeUndefined();
    const tasks=['gh_a','gh_b'].map((wechatAccountId,index)=>({id:wechatAccountId,article,platform:'wechat',wechatAccountId,wechatAppMsgId:`draft-${index}`,status:'saved',updatedAt:new Date().toISOString()} as SyncTask));
    expect(uniqueTasks(tasks)).toHaveLength(2);
    expect(findMatchingTask(tasks,article,'wechat','gh_b')?.id).toBe('gh_b');
    store.syncTasks=tasks;await deleteTask('gh_a');
    expect(await getArticleDraftMapping(article,'wechat','gh_a')).toMatchObject({wechatAppMsgId:'draft-0'});
  });
  it('只有 saved 状态计入成功，等待确认与进行中不计入',()=>{
    expect(syncReplyState({ok:true,task:{status:'saved'}}).saved).toBe(true);
    for(const status of ['needs-confirmation','queued','checking-login','transforming','writing'] as const)expect(syncReplyState({ok:true,task:{status}}).saved).toBe(false);
    expect(()=>syncReplyState({ok:true,task:{status:'failed',error:'失败'}})).toThrow('失败');
    expect(()=>syncReplyState({ok:true})).toThrow();
  });
  it('登录刷新保留取消勾选，登录失效移除选项，恢复后不偷偷重选',()=>{
    const selected=new Set<PlatformId>();
    const auths=[{platform:'csdn' as const,loggedIn:true},{platform:'wechat' as const,loggedIn:true}];
    refreshPlatformSelection(selected,auths,true);
    expect([...selected]).toEqual(['csdn','wechat']);
    selected.delete('wechat');
    refreshPlatformSelection(selected,auths,false);
    expect([...selected]).toEqual(['csdn']);
    refreshPlatformSelection(selected,[{platform:'csdn',loggedIn:false}],false);
    refreshPlatformSelection(selected,auths,false);
    expect(selected.size).toBe(0);
  });

  it('左对齐与排版防散字：段落、列表与容器统一 left 对齐并支持长代码折行',()=>{
    const md=`在早期迭代中，建模时遗留了 24 条未清理的零散路径（例如 \`Neon_Track_East_Dock3_Spur\` 从 \`(6.76, -4.5)\` ）。`;
    const html=compileWechatHtml(md);
    expect(html).toContain('text-align:left;');
    expect(html).toContain('word-break:break-word;');
    expect(html).toContain('overflow-wrap:break-word;');
    expect(html).not.toContain('letter-spacing:0.02em');
  });

  it('列表项与加粗内联性：加粗标题与紧随标点保持同一行，不被换行撕裂且标记 display:inline',()=>{
    const md=`
* **调度派**
：喜欢黑夜底色的高对比暗色大屏；
* **汇报派**：喜欢明亮清爽的白昼工业沙盘。

- **在上篇中**
，我们见证了 **Google Antigravity + Blender MCP** 带来的颠覆性效率；
- **在上篇中**
  , 我们见证了英文字符逗号场景；
- **在下篇中**，我们见证了前端工程化与图形学结合的深度。

1. **彻底清扫全部 24 条杂乱历史斜线与多余支轨**
；
2. **货物存储区工业黄色标定界**
：
   - 采用标准工程安全琥珀黄（\`#f59e0b\`，线宽 0.06m）；
`;
    const html=compileWechatHtml(md);
    // 加粗显式具备 display:inline，防止平台基础样式覆盖为块级元素
    expect(html).toContain('<strong style="font-weight:700;color:#2b2b2b;display:inline;">调度派</strong>：');
    expect(html).toContain('<strong style="font-weight:700;color:#2b2b2b;display:inline;">汇报派</strong>：');
    expect(html).toContain('<strong style="font-weight:700;color:#2b2b2b;display:inline;">在上篇中</strong>，');
    expect(html).toContain('<strong style="font-weight:700;color:#2b2b2b;display:inline;">在上篇中</strong>,');
    expect(html).toContain('<strong style="font-weight:700;color:#2b2b2b;display:inline;">彻底清扫全部 24 条杂乱历史斜线与多余支轨</strong>；');
    expect(html).toContain('<strong style="font-weight:700;color:#2b2b2b;display:inline;">货物存储区工业黄色标定界</strong>：');
    // 行内内容保持连续，并整体放在列表项的同一个段落中。
    expect(html).not.toMatch(/<\/strong>\s*\n\s*[：；，,]/);
    expect(html).not.toMatch(/<\/strong>\s+[：；，,]/);
    expect(html).toMatch(/<li[^>]*><p[^>]*><strong/);
  });

  it.each(['：', '，', ':', ','])('列表内加粗与 %s 后正文共用一个段落', punctuation=>{
    const html=compileWechatHtml(`- **得记得**${punctuation}出差、休假、忙起来就会忘，而断一天就丢连续记录；\n- **得有条件**${punctuation}得打开电脑或手机装着客户端，设备不在身边就没办法；\n- **得自己确认**${punctuation}签了之后还得看一眼有没有真的成功。`);
    const items=[...html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map(match=>match[1]);
    expect(items).toHaveLength(3);
    for(const item of items){
      expect(item).toMatch(/^<p\b[^>]*><strong\b/);
      expect(item).toContain(`</strong>${punctuation}`);
      expect(item.match(/<p\b/g)).toHaveLength(1);
      expect(item).toMatch(/<\/p>$/);
      expect(item).not.toMatch(/<br\b|white-space:nowrap/);
    }
  });

  it('列表段落保留嵌套列表和独立段落的边界',()=>{
    const html=compileWechatHtml('- **得记得**：说明\n\n  第二段说明。\n\n  - **子项**：子项说明');
    expect(html).toMatch(/说明<\/p><p[^>]*>第二段说明。<\/p><ul/);
    expect(html).toMatch(/<ul[^>]*><li[^>]*><p[^>]*><strong[^>]*>子项/);
    expect(html).not.toMatch(/<p[^>]*><ul/);
  });

  it('行内代码与标点内联性：行内代码渲染为 span 杜绝微信误判为独立代码块，且与冒号紧贴同行',()=>{
    const md=`
* \`execute_blender_code\`
: 直接向 Blender 发送场景生成；
* \`execute_blender_code\`
  : 直接向 Blender 发送场景生成（带缩进）；
* \`execute_blender_code\` : 直接向 Blender 发送场景生成；
* \`get_scene_info\`
/ \`get_object_info\` : 毫秒级内省。
`;
    const html=compileWechatHtml(md);
    expect(html).toContain('<span style="display:inline;padding:2px 5px;');
    expect(html).not.toContain('<code style="display:inline;');
    expect(html).toContain('execute_blender_code</span>: 直接向 Blender 发送场景生成；');
    expect(html).toContain('execute_blender_code</span>: 直接向 Blender 发送场景生成（带缩进）；');
    expect(html).toContain('get_scene_info</span> / <span style="display:inline;');
    expect(html).not.toMatch(/<\/span>\s*\n\s*[:/]/);
    expect(html).not.toMatch(/<\/span>\s+[:：]/);
  });

  it('Mermaid 图表提取与图文渲染：提取代码块，命中图片映射时输出居中图片，缺失时阻止编译',()=>{
    const md=`
前文说明。

\`\`\`mermaid
stateDiagram-v2
    direction LR
    [*] --> 空车接驳: 巡线
    空车接驳 --> [*]
\`\`\`

后文说明。
`;
    const blocks=extractMermaidBlocks(md);
    expect(blocks.length).toBe(1);
    expect(blocks[0].originalText).toContain('stateDiagram-v2');

    expect(()=>compileWechatHtml(md)).toThrow('Mermaid');

    // 2. 提供已渲染图片（DataURL / 链接）时，输出规范居中图片
    const mockDataUrl='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const mermaidImages=new Map<string,string>([[blocks[0].originalText,mockDataUrl]]);
    const renderedHtml=compileWechatHtml(md,{mermaidImages});
    expect(renderedHtml).not.toContain('<section class="code-snippet__js">');
    expect(renderedHtml).toContain('<p style="margin:22px 0;text-align:center;"><img src="data:image/png;base64,');
    expect(renderedHtml).toContain('alt="Mermaid 图表"');

    // 3. collectWechatImageUrls 正确收录该 DataURL
    const collected=collectWechatImageUrls(renderedHtml);
    expect(collected).toContain(mockDataUrl);

    // 4. replaceWechatImageUrls 正确将其替换为微信 CDN 链接
    const replaced=replaceWechatImageUrls(renderedHtml,new Map([[mockDataUrl,'https://mmbiz.qpic.cn/mermaid_test_cdn']]));
    expect(replaced).toContain('src="https://mmbiz.qpic.cn/mermaid_test_cdn"');
    expect(replaced).not.toContain(mockDataUrl);
  });

  it('Flowchart 流程图兼容支持：识别 ```flowchart、```flowchart TD 及包含子图的流程图并渲染为图文',()=>{
    const md=`
在本项目中，我们采用了 Antigravity + Blender MCP Server 的自动化建模架构。

\`\`\`flowchart TD
  A[开发者自然语言业务需求] --> B[Google Antigravity Agent]
  subgraph Blender_MCP_Tools [Blender MCP 自动化双向控制工具链]
    B -->|1. execute_blender_code| C[Blender 3D 引擎环境]
    C -->|2. get_scene_info / get_object_info| B
  end
  D --> E[Vue 3 + Three.js 前端数字孪生大屏]
\`\`\`
`;
    const blocks=extractMermaidBlocks(md);
    expect(blocks.length).toBe(1);
    expect(blocks[0].renderCode).toContain('flowchart TD');
    expect(blocks[0].renderCode).toContain('subgraph Blender_MCP_Tools');

    const mockPng='data:image/png;base64,mockFlowchartPngData';
    const mermaidImages=new Map<string,string>([
      [blocks[0].originalText,mockPng],
      [blocks[0].renderCode,mockPng]
    ]);
    const html=compileWechatHtml(md,{mermaidImages});
    expect(html).not.toContain('<section class="code-snippet__js">');
    expect(html).toContain('<p style="margin:22px 0;text-align:center;"><img src="data:image/png;base64,mockFlowchartPngData" alt="Mermaid 图表"');

    expect(()=>compileWechatHtml(md)).toThrow('Mermaid');
  });

  it('DataURL 转二进制 Blob 支持：能将 base64 数据正确解码为 image/png 二进制 Blob',()=>{
    const base64Data='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const blob=dataUrlToBlob(base64Data);
    expect(blob.type).toBe('image/png');
    expect(blob.size).toBeGreaterThan(0);

    const textData='data:text/plain;charset=utf-8,Hello%20World';
    const textBlob=dataUrlToBlob(textData);
    expect(textBlob.type).toBe('text/plain');
    expect(textBlob.size).toBe(11);
  });

  it('Mermaid 离屏渲染与 chrome.runtime.getContexts 兼容调度',async()=>{
    let createDocumentCount = 0;
    let messageSent = false;
    vi.stubGlobal('chrome', {
      runtime: {
        getContexts: async () => {
          return createDocumentCount > 0 ? [{ contextType: 'OFFSCREEN_DOCUMENT' }] : [];
        },
        getURL: (path: string) => `chrome-extension://mock-id/${path}`,
        sendMessage: (msg: any, callback: (res: any) => void) => {
          if (msg?.target === 'offscreen' && msg?.type === 'PING') {
            callback({ ok: true });
            return;
          }
          if (msg?.target === 'offscreen' && msg?.type === 'RENDER_MERMAID') {
            messageSent = true;
            callback({ ok: true, dataUrl: 'data:image/png;base64,renderedDiagram' });
          }
        }
      },
      offscreen: {
        Reason: { DOM_PARSER: 'DOM_PARSER' },
        createDocument: async () => {
          createDocumentCount++;
        }
      }
    });

    const result = await renderMermaidToPng('stateDiagram-v2\n[*] --> Active');
    expect(createDocumentCount).toBe(1);
    expect(messageSent).toBe(true);
    expect(result).toBe('data:image/png;base64,renderedDiagram');

    // 再次调用时，getContexts 返回已存在的文档，不再重复调用 createDocument
    const result2 = await renderMermaidToPng('flowchart TD\nA --> B');
    expect(createDocumentCount).toBe(1);
    expect(result2).toBe('data:image/png;base64,renderedDiagram');
  });

  it('加粗与标点跨行跨空行吸附：彻底杜绝分行或分裂为独立段落',()=>{
    const md=`
1. **彻底清扫全部 24 条杂乱历史斜线与多余支轨**

;

2. **货物存储区工业黄色标定界**

:
   - 采用标准工程安全琥珀黄（\`#f59e0b\`，线宽 0.06m）；

1. **三维到二维投影**

   : 利用 \`Vector3.project(camera)\` 算法；

- **在上篇中**

  ，我们见证了效率提升；

* **视觉语言**

：构建统一设计系统；
`;
    const html=compileWechatHtml(md);
    expect(html).toContain('彻底清扫全部 24 条杂乱历史斜线与多余支轨</strong>;');
    expect(html).toContain('货物存储区工业黄色标定界</strong>:');
    expect(html).toContain('三维到二维投影</strong>: 利用');
    expect(html).toContain('在上篇中</strong>，我们见证了');
    expect(html).toContain('视觉语言</strong>：构建');
    // 绝不生成单独的段落包围标点
    expect(html).not.toContain('<p>;</p>');
    expect(html).not.toContain('<p>:</p>');
    expect(html).not.toContain('<p>：');
    expect(html).not.toContain('<p>，');
  });

  it('每张图按完整渲染源码对应，同正文不同方向不混用',async()=>{
    const codes:string[]=[];
    vi.stubGlobal('chrome',{
      runtime:{getContexts:async()=>[{}],getURL:(path:string)=>path,
        sendMessage:(msg:any,callback:any)=>{
          if(msg.type==='PING')return callback({ok:true});
          expect(msg.type).toBe('RENDER_MERMAID');
          codes.push(msg.code);
          callback({ok:true,dataUrl:`data:image/png;base64,${codes.length}`});
        }},
      offscreen:{createDocument:async()=>{}}
    });
    const md='```flowchart TD\nA-->B\n```\n\n```flowchart LR\nA-->B\n```';
    const images=await renderAllMermaidBlocks(md);
    expect(codes).toEqual(['flowchart TD\nA-->B','flowchart LR\nA-->B']);
    const html=compileWechatHtml(md,{mermaidImages:images});
    expect(collectWechatImageUrls(html)).toEqual(['data:image/png;base64,1','data:image/png;base64,2']);
  });
});
