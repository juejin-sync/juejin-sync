// 双格式内容、图卡配方和任务身份回归，确保完整长文与精简图文不共用截断规则。
import {describe,expect,it} from 'vitest';
import {buildXiaohongshuImageContent,compileXiaohongshuArticle,compileXiaohongshuMarkdownDocument,extractXiaohongshuShortTitle,imageKey,validateXiaohongshuImageContent,xhsWordCount} from '../src/targets/xiaohongshu-formats';
import {findMatchingTask} from '../src/core/task';
import {uniqueTasks,toStorageTask,migrateStoredTasks} from '../src/core/store';
import type {Article,SyncTask} from '../src/types';
import {wrapCardText} from '../src/xiaohongshu-card-render';
import {vi} from 'vitest';
const article:Article={id:'source',title:'技术实践指南',markdown:'# 背景\n\n这是完整文章的第一段。\n\n## 步骤\n\n1. 创建配置。\n2. 执行检查。\n\n## 注意事项\n\n只对自己的账号使用，不要共享凭据。',summary:'介绍实现方法与使用边界。',tags:['前端'],sourceUrl:'https://juejin.cn/post/1'};

describe('小红书长文编译',()=>{
  it('紧凑勾选列表保留已完成与未完成状态，不把 checkbox 当成未知结构',()=>{
    const note=compileXiaohongshuArticle({...article,markdown:'- [x] 已部署\n- [ ] 待验证\n  - [x] 已配置告警'}, {appendSourceLink:false});
    expect(note.html).toContain('<p>☑ 已部署</p>');expect(note.html).toContain('<p>☐ 待验证</p>');
    expect(note.html).toContain('<p>☑ 已配置告警</p>');
    expect(note.text).toBe('☑ 已部署\n☐ 待验证\n☑ 已配置告警');
    expect(note.html).not.toContain('<input');
  });
  it('松散和多段落勾选列表只保留一次状态，继续保留后续段落',()=>{
    const note=compileXiaohongshuArticle({...article,markdown:'- [x] 已完成第一步\n\n  补充说明。\n\n- [ ] 等待检查\n\n  最后的必要限制。'}, {appendSourceLink:false});
    expect(note.html).toContain('<p>☑ 已完成第一步</p><p>补充说明。</p>');
    expect(note.html).toContain('<p>☐ 等待检查</p><p>最后的必要限制。</p>');
    expect(note.text).toBe('☑ 已完成第一步\n补充说明。\n☐ 等待检查\n最后的必要限制。');
  });
  it('超过1000字保留全文及末尾，不要求封面或图片',()=>{
    const note=compileXiaohongshuArticle({...article,title:'这是一个超过二十字但没有超过六十四字的长文标题',markdown:'完整内容。'.repeat(250)+'最后的必要限制。'});
    expect(note.title).toContain('六十四');expect(note.text).toContain('最后的必要限制。');expect(note.text.length).toBeGreaterThan(1000);
    expect(note.images).toEqual([]);expect(note.text).not.toContain('…');
  });
  it('章节、列表、引用保留；代码换行和表格字段明确降级',()=>{
    const note=compileXiaohongshuArticle({...article,markdown:'# 一级\n\n## 二级\n\n> 引用\n\n- 第一项\n- 第二项\n\n```js\nfunction run() {\n  return 1;\n}\n```\n\n| 名称 | 值 |\n| --- | --- |\n| A | 1 |'});
    expect(note.html).toContain('<h1>一级</h1>');expect(note.html).toContain('<ul><li>');expect(note.html).toContain('<blockquote>');
    expect(note.html).toContain('function&nbsp;run()&nbsp;{<br>&nbsp;&nbsp;return&nbsp;1;<br>}');expect(note.html).toContain('名称：A');expect(note.html).toContain('值：1');
    expect(note.warnings).toHaveLength(2);
  });
  it('图片在正文原位置形成占位符，与渲染后的图表顺序一致',()=>{
    const note=compileXiaohongshuArticle({...article,markdown:'第一段。\n\n![图](https://example.com/a.png)\n\n第二段。\n\n```mermaid\nflowchart TD\nA-->B\n```'}, {mermaidImages:new Map([['flowchart TD\nA-->B','data:image/png;base64,AA==']])});
    expect(note.images).toEqual(['https://example.com/a.png','data:image/png;base64,AA==']);
    expect(note.html).toMatch(/第一段.*data-xhs-image="0".*第二段.*data-xhs-image="1"/);
  });
  it('不把 HTML 或超限文章当作可同步成稿',()=>{
    expect(()=>compileXiaohongshuArticle({...article,markdown:'<script>bad()</script>'})).toThrow('HTML');
    expect(()=>compileXiaohongshuArticle({...article,markdown:'文'.repeat(10001)})).toThrow('10000');
    expect(()=>compileXiaohongshuArticle({...article,title:'文'.repeat(65)})).toThrow('64');
  });
  it('使用平台已观察到的中文与英文计数权重',()=>{
    expect(xhsWordCount('中文ab12。 ')).toBe(6);
    expect(xhsWordCount('a_b__')).toBe(1);expect(xhsWordCount('😀')).toBe(1);
  });
  it('段落和显式换行不占富文本字数，10000字完整保留',()=>{
    for(const separator of ['\n\n','  \n']){
      const note=compileXiaohongshuArticle({...article,markdown:'文'.repeat(5000)+separator+'末'.repeat(5000)},{appendSourceLink:false});
      expect(note.text).toBe('文'.repeat(5000)+'\n'+'末'.repeat(5000));
      expect(note.html).toContain('末'.repeat(5000));
    }
  });
  it('只在所有 text 节点累计后向上取整，不逐段放大字数',()=>{
    const note=compileXiaohongshuArticle({...article,markdown:'文'.repeat(9999)+'a\n\nb'},{appendSourceLink:false});
    expect(note.text).toBe('文'.repeat(9999)+'a\nb');
  });
  it('代码制表符会转成四个空格，校验包含实际缩进占用',()=>{
    expect(()=>compileXiaohongshuArticle({...article,markdown:'文'.repeat(9997)+'\n\n```txt\n\tX\n```'},{appendSourceLink:false})).toThrow('10002 字');
  });
  it('超限报告实际计数、超出量和设置入口，不要求用户盲目重试',()=>{
    expect(()=>compileXiaohongshuArticle({...article,markdown:'文'.repeat(10001)},{appendSourceLink:false})).toThrow('10001 字，超过 10000 字上限 1 字（正文 10001 字，配图占用 0 字）');
    expect(()=>compileXiaohongshuArticle({...article,markdown:'文'.repeat(10001)},{appendSourceLink:false})).toThrow('偏好设置');
  });
  it('过滤掘金主题元数据并保留行内代码中的 Cron、下划线和泛型符号',()=>{
    const note=compileXiaohongshuArticle({...article,markdown:'---\ntheme: cyanosis\n---\n\n## 配置 `a__b`\n\nCron：`0 0 9 * * *`，类型：`List<T>`。\n\n| 名称 | 值 |\n| --- | --- |\n| Cron | `0 0 9 * * *` |'});
    expect(note.text).not.toContain('cyanosis');expect(note.text).toContain('配置 a__b');expect(note.text).toContain('0 0 9 * * *');expect(note.text).toContain('List<T>');expect(note.text).toContain('值：0 0 9 * * *');
  });
});

describe('长文 Markdown 文件生成',()=>{
  it('清理掘金专属主题元数据并正确替换 Mermaid 图表引用',()=>{
    const doc=compileXiaohongshuMarkdownDocument({
      ...article,
      markdown:'---\ntheme: cyanosis\n---\n\n# 标题\n\n正文。\n\n```mermaid\nflowchart TD\nA-->B\n```\n\n![配图](https://example.com/p.png)'
    },{mermaidImages:new Map([['flowchart TD\nA-->B','data:image/png;base64,CHART']])});
    expect(doc.markdown).not.toContain('cyanosis');
    expect(doc.markdown).toContain('![图表](data:image/png;base64,CHART)');
    expect(doc.images).toContain('https://example.com/p.png');
    expect(doc.images).toContain('data:image/png;base64,CHART');
    expect(doc.markdown).toContain('本文首发于掘金');
  });
  it('超长长文标题在 1~64 范围之外时抛出友好校验错误',()=>{
    expect(()=>compileXiaohongshuMarkdownDocument({...article,title:''})).toThrow('64');
    expect(()=>compileXiaohongshuMarkdownDocument({...article,title:'长'.repeat(65)})).toThrow('64');
  });
});

describe('超长长文的本地规则精简',()=>{
  const background=Array.from({length:30},(_,i)=>`例如，${String.fromCharCode(0x4e01+i)}是当时的一段背景说明。${'这段只讲经历和过程。'.repeat(45)}`).join('\n\n');
  const markdown=`# 背景\n\n本文讨论定时任务的可靠性。\n\n${background}\n\n## 步骤\n\n1. 创建任务。\n2. 验证执行结果。\n\n## 参数\n\n`+'超时设置为 `300` 秒，Cron 使用 `0 5 9 * * *`。\n\n## 限制\n\n只能用于自己的账号，失败时必须告警。';
  it('按完整内容块精简，保留章节、步骤、参数与末尾限制；输入与重试结果不变',()=>{
    const source={...article,markdown};const before=JSON.stringify(source);
    const note=compileXiaohongshuArticle(source);
    expect(xhsWordCount(note.text.replace(/\n/g,''))).toBeLessThanOrEqual(10000);
    for(const text of ['本文讨论定时任务的可靠性。','创建任务。','验证执行结果。','300','0 5 9 * * *','只能用于自己的账号，失败时必须告警。'])expect(note.text).toContain(text);
    for(const heading of ['背景','步骤','参数','限制'])expect(note.html).toContain(`>${heading}</h`);
    expect(note.text).toContain('本文为本地规则精简版');expect(note.text).toContain(article.sourceUrl);
    expect(note.warnings.join('')).toContain('已按本地规则精简');expect(note.text).not.toContain('…');
    for(const paragraph of background.split('\n\n'))if(note.text.includes(paragraph.slice(0,20)))expect(note.text).toContain(paragraph);
    expect(JSON.stringify(source)).toBe(before);expect(compileXiaohongshuArticle(source)).toEqual(note);
  });
  it('精确去重已满足预算时，不再省略可完整保留的长代码',()=>{
    const duplicate='完全相同的背景描述。'.repeat(40);
    const code='const keep_original = true;\n'.repeat(20);
    const note=compileXiaohongshuArticle({...article,markdown:`# 介绍\n\n主题说明。\n\n${Array(35).fill(duplicate).join('\n\n')}\n\n\`\`\`js\n${code}\`\`\``});
    expect(note.text.split(duplicate)).toHaveLength(2);
    expect(note.text).toContain(code.trimEnd());expect(note.text).not.toContain('长代码已整块省略');
    expect(note.warnings.join('')).toContain('去重 34 段');
  });
  it('省略长代码时用明确标记替代整块，保留短代码和引用原文的入口',()=>{
    const note=compileXiaohongshuArticle({...article,markdown:`# 实现\n\n功能说明。\n\n\`\`\`js\n${'const long_example = 123;\n'.repeat(800)}\`\`\`\n\n\`\`\`sh\nrun --check\n\`\`\`\n\n## 限制\n\n不能省略失败处理。`});
    expect(note.text).toContain('【长代码已整块省略，完整代码见原文】');expect(note.text).not.toContain('long_example');
    expect(note.text).toContain('run --check');expect(note.text).toContain('不能省略失败处理。');expect(note.text).toContain(article.sourceUrl);
  });
  it('超限时表头只展示一次，参数表仍保留全部单元格数据',()=>{
    const table='|参数名称|参数值|\n|---|---|\n'+Array.from({length:20},(_,i)=>`|参数${i}|value_${i}|`).join('\n');
    const note=compileXiaohongshuArticle({...article,markdown:`${markdown}\n\n## 参数\n\n${table}`});
    expect(note.text).toContain('表头：参数名称｜参数值');
    for(let i=0;i<20;i++)expect(note.text).toContain(`参数${i}｜value_${i}`);
    expect(note.text).not.toContain('大表格已整块省略');
  });
  it('非关键大表格需要省略时整块标记，不留下半张表格',()=>{
    const table='|示例|描述|\n|---|---|\n'+Array.from({length:120},(_,i)=>`|案例${i}|${'附带的历史说明。'.repeat(20)}|`).join('\n');
    const note=compileXiaohongshuArticle({...article,markdown:`# 背景\n\n主题说明。\n\n${table}\n\n## 限制\n\n必须检查执行结果。`});
    expect(note.text).toContain('【大表格已整块省略，完整表格见原文】');expect(note.text).not.toContain('案例');
    expect(note.text).toContain('必须检查执行结果。');
  });
  it('精简仍保留全部配图及图表，位置占位符与原始图片索引一致',()=>{
    const note=compileXiaohongshuArticle({...article,markdown:`${markdown}\n\n![原图](https://example.com/a.png)\n\n\`\`\`mermaid\nflowchart TD\nA-->B\n\`\`\``},{mermaidImages:new Map([['flowchart TD\nA-->B','data:image/png;base64,AA==']]),imageWeight:800});
    expect(note.images).toEqual(['https://example.com/a.png','data:image/png;base64,AA==']);
    expect(note.html).toMatch(/data-xhs-image="0".*data-xhs-image="1"/);
    expect(xhsWordCount(note.text.replace(/\n/g,''))+800).toBeLessThanOrEqual(10000);
  });
  it.each([undefined,'https://juejin.cn/editor/drafts/1','https://other.example/post/1'])('没有公开原文入口时不生成无法补全的精简稿：%s',sourceUrl=>{
    expect(()=>compileXiaohongshuArticle({...article,markdown,sourceUrl})).toThrow('已发布的掘金原文链接');
  });
  it('必要步骤仍超限时明确失败，不删除列表中的部分条目来凑预算',()=>{
    expect(()=>compileXiaohongshuArticle({...article,markdown:`# 必要步骤\n\n1. ${'必要操作。'.repeat(2500)}\n2. 核对结果。`})).toThrow('必要内容');
  });
});

describe('精简图文配方',()=>{
  it('不保留只剩引导语的步骤、数量承诺或配置说明，独立条目之间保留换行',()=>{
    const content=buildXiaohongshuImageContent({...article,markdown:'## 操作\n\n每天完成三件事：\n\n1. 查询任务\n2. 执行任务\n3. 检查结果\n\n## 配置\n\n函数详情 → 环境变量：\n\n修改配置后立即生效。'});
    expect(content.body).not.toContain('三件事：');expect(content.body).not.toContain('环境变量：');
    expect(content.cards.find(card=>card.heading==='操作')?.body).toContain('1. 查询任务\n2. 执行任务');
  });
  it('覆盖原文后部限制，去掉指向缺失代码的段落，不添加省略号',()=>{
    const content=buildXiaohongshuImageContent({...article,markdown:article.markdown+'\n\n完整代码如下。\n\n```js\nreturn 1;\n```'});
    expect(content.body).toContain('使用边界');expect(content.cards.some(card=>card.body.includes('不要共享凭据'))).toBe(true);
    expect(content.body).not.toContain('完整代码如下');expect(content.body).not.toContain('…');
    expect(()=>validateXiaohongshuImageContent(content)).not.toThrow();
  });
  it('没有原图时从真实文章内容生成图卡；超长标题留给用户编辑',()=>{
    const content=buildXiaohongshuImageContent({...article,title:'这是一个完全没有分隔符而且超过二十字的技术文章标题'});
    expect(content.cards.length).toBeGreaterThan(0);expect(content.selectedImageKeys).toEqual([]);
    expect(()=>validateXiaohongshuImageContent(content)).toThrow('20');
  });
  it('中英文混排无标点长标题智能提炼动宾短标题，不把空格当分隔符误切为单字',()=>{
    const title='用 Gitee Go 搭建WorkBuddy云端定时任务';
    const shortTitle=extractXiaohongshuShortTitle(title);
    expect(shortTitle).toBe('搭建WorkBuddy云端定时任务');
    expect(shortTitle).not.toBe('用');
    expect(shortTitle.length).toBeLessThanOrEqual(20);

    const content=buildXiaohongshuImageContent({...article,title});
    expect(content.title).toBe('搭建WorkBuddy云端定时任务');
    expect(()=>validateXiaohongshuImageContent(content)).not.toThrow();
  });
  it('带冒号中英文长标题提取信息量完整且<=20字的分句，单字标题被拦截',()=>{
    const longTitle='Vite 6.0 深度实战解析：企业生产级构建与性能优化';
    const shortTitle=extractXiaohongshuShortTitle(longTitle);
    expect(shortTitle.length).toBeGreaterThanOrEqual(4);
    expect(shortTitle.length).toBeLessThanOrEqual(20);
    expect(shortTitle).toBe('Vite 6.0 深度实战解析');

    const content=buildXiaohongshuImageContent({...article,title:'技术'});
    expect(()=>validateXiaohongshuImageContent({...content,title:'用'})).toThrow('2～20');
  });
  it('图片去重使用资源身份，data URL 不进入配方存储',()=>{
    const src='data:image/png;base64,AA==';
    const content=buildXiaohongshuImageContent({...article,markdown:`## 步骤\n\n1. 操作。\n\n![图](${src})`},{syncOriginalImages:true});
    expect(content.selectedImageKeys).toEqual([imageKey(src)]);expect(JSON.stringify(content)).not.toContain('base64');
    expect(imageKey('https://example.com/a.png?token=old')).toBe(imageKey('https://example.com/a.png?token=new'));
  });
  it('原图增强默认关闭，显式开启后最多2张且顺序紧跟对应观点图卡',()=>{
    const md=`# 介绍\n\n## 第一章\n\n第一段文字。\n\n![图1](https://example.com/1.png)\n\n## 第二章\n\n第二段文字。\n\n![图2](https://example.com/2.png)\n\n## 第三章\n\n第三段文字。\n\n![图3](https://example.com/3.png)`;
    const defContent=buildXiaohongshuImageContent({...article,markdown:md});
    expect(defContent.originalImagesCount).toBe(0);
    expect(defContent.pages.every(p=>p.type==='card')).toBe(true);
    expect(defContent.selectedImageKeys).toEqual([]);

    const enhanced=buildXiaohongshuImageContent({...article,markdown:md},{syncOriginalImages:true});
    expect(enhanced.originalImagesCount).toBe(2);
    expect(enhanced.pages.filter(p=>p.type==='image')).toHaveLength(2);
    expect(enhanced.selectedImageKeys).toHaveLength(2);
    // 原图应紧跟在观点图卡之后
    const firstImgIdx=enhanced.pages.findIndex(p=>p.type==='image');
    expect(enhanced.pages[firstImgIdx-1].type).toBe('card');
    expect(enhanced.pages[firstImgIdx-1].kind).toBe('point');
  });
  it('精简图文导读采用稳定模板并与实际观点数量对应，不以承接词起头',()=>{
    const content=buildXiaohongshuImageContent(article);
    expect(content.body).toMatch(/围绕《技术实践指南》，本次图卡整理了 \d+ 个核心要点/);
    expect(content.body).toContain('2. 步骤');
    expect(content.body).not.toMatch(/^[，,。、\s]/);
  });
  it('编辑后字数和总图片预算重新校验，图卡内容不能静默截掉',()=>{
    const content=buildXiaohongshuImageContent(article);
    expect(()=>validateXiaohongshuImageContent({...content,body:'字'.repeat(1001)})).toThrow('1000');
    expect(()=>validateXiaohongshuImageContent({...content,cards:Array.from({length:19},()=>content.cards[0])})).toThrow('18');
    expect(()=>validateXiaohongshuImageContent({...content,cards:[{heading:'标题',body:'字'.repeat(601)}]})).toThrow('600');
  });
  it('图卡按实际宽度换行，保留所有字符及显式空行',()=>{
    const context={measureText:(text:string)=>({width:[...text].length*10})};
    const lines=wrapCardText(context as any,'一二三四五\n\nabcdef',30);
    expect(lines).toEqual(['一二三','四五','','abc','def']);
  });
});

describe('格式任务隔离',()=>{
  const task=(format?:'article'|'image')=>({id:format||'legacy',article,platform:'xiaohongshu',xiaohongshuAccountId:'account',xiaohongshuFormat:format,status:'saved',updatedAt:'2026-10-28T00:00:00Z',createdAt:'2026-10-28T00:00:00Z',attempts:1}) as SyncTask;
  it('同一文章同一账号的两种格式分别保留、匹配',()=>{
    const tasks=[task('article'),task('image')];
    expect(uniqueTasks(tasks)).toHaveLength(2);
    expect(findMatchingTask(tasks,article,'xiaohongshu','account','article')?.id).toBe('article');
    expect(findMatchingTask(tasks,article,'xiaohongshu','account','image')?.id).toBe('image');
    expect(findMatchingTask([task()],article,'xiaohongshu','account','article')).toBeUndefined();
  });
  it('旧图文任务确定性迁移为 image，保留既有状态',async()=>{
    let saved:any;
    vi.stubGlobal('chrome',{storage:{local:{get:async()=>({syncTasks:[{...task(),article:{...article,markdown:''}}]}),set:async(value:any)=>{saved=value;}}}});
    try{expect(await migrateStoredTasks()).toBe(true);expect(saved.syncTasks[0]).toMatchObject({xiaohongshuFormat:'image',status:'saved'});}finally{vi.unstubAllGlobals();}
  });
  it('历史仅保留配方与格式，原始长文正文继续瘦身',()=>{
    const content=buildXiaohongshuImageContent(article);
    const stored=toStorageTask({...task('image'),xiaohongshuImageContent:content});
    expect(stored.article.markdown).toBe('');expect(stored.xiaohongshuImageContent).toEqual(content);
  });
});
