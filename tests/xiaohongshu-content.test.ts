// 小红书内容编译回归测试：标题/正文/图片上限、降级规则与话题格式。
import {describe,expect,it} from 'vitest';
import {
  XHS_BODY_MAX,
  XHS_IMAGE_MAX,
  XHS_TITLE_MAX,
  XHS_TOPIC_MAX_LENGTH,
  buildXiaohongshuTitle,
  compileXiaohongshuNote,
  formatXiaohongshuTopics,
  markdownToXiaohongshuText,
  truncateXiaohongshuBody
} from '../src/targets/xiaohongshu-content';
import type {Article} from '../src/types';

const baseArticle=(overrides:Partial<Article>={}):Article=>({
  id:'juejin-xhs-1',
  title:'掘金文章同步小红书测试',
  markdown:'## 小节\n\n正文第一段。\n\n- 列表项一\n- 列表项二',
  tags:['前端','效率工具'],
  sourceUrl:'https://juejin.cn/post/1',
  ...overrides
});

describe('小红书标题规则',()=>{
  it(`超过 ${XHS_TITLE_MAX} 字按码点截断并保留省略号`,()=>{
    const raw='这是一个非常非常长的掘金文章标题用于验证小红书标题截断规则';
    const result=buildXiaohongshuTitle(raw);
    expect([...result.title]).toHaveLength(XHS_TITLE_MAX);
    expect(result.title.endsWith('…')).toBe(true);
    expect(result.truncated).toBe(true);
  });

  it('保留 emoji 完整性（按码点而非 UTF-16 计数）',()=>{
    const raw='🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀';
    const result=buildXiaohongshuTitle(raw);
    expect([...result.title]).toHaveLength(XHS_TITLE_MAX);
  });

  it('空标题与纯标记标题直接阻断',()=>{
    expect(()=>buildXiaohongshuTitle('   ')).toThrow('小红书标题不能为空');
    expect(()=>buildXiaohongshuTitle('**')).toThrow('小红书标题不能为空');
  });
});

describe('小红书正文转换',()=>{
  it('标题降级为普通行，列表保留符号，引用去掉前缀',()=>{
    const {text}=markdownToXiaohongshuText('# 一级标题\n\n> 引用内容\n\n- 条目 A\n- 条目 B');
    expect(text).toBe('一级标题\n\n引用内容\n\n· 条目 A\n· 条目 B');
  });

  it('链接只保留文字，图片 Markdown 不进入正文',()=>{
    const {text,images}=markdownToXiaohongshuText('请看[掘金原文](https://juejin.cn/post/1)与配图 ![封面](https://p3.byteimg.com/a.png)');
    expect(text).toContain('掘金原文');
    expect(text).not.toContain('https://juejin.cn');
    expect(text).not.toContain('a.png');
    expect(images).toEqual(['https://p3.byteimg.com/a.png']);
  });

  it('代码块/表格/公式转为纯文本并产出警告',()=>{
    const result=markdownToXiaohongshuText('```js\nconst a=1;\n```\n\n| 名称 | 值 |\n| --- | --- |\n| A | 1 |\n\n公式 $E=mc^2$');
    expect(result.hasCode).toBe(true);
    expect(result.hasTable).toBe(true);
    expect(result.hasFormula).toBe(true);
    expect(result.text).toContain('const a=1;');
    expect(result.text).toContain('名称 | 值');
    expect(result.warnings).toEqual(expect.arrayContaining([
      '代码块已转为纯文本（小红书不支持代码高亮）',
      '表格已按行转为纯文本',
      '公式已转为 LaTeX 纯文本'
    ]));
  });

  it('Mermaid 图表替换为渲染后的图片，未渲染时给出警告',()=>{
    const markdown='说明文字\n\n```mermaid\nflowchart TD\nA-->B\n```';
    const code='flowchart TD\nA-->B';
    const withImage=markdownToXiaohongshuText(markdown,new Map([[code,'data:image/png;base64,AAA']]));
    expect(withImage.images).toEqual(['data:image/png;base64,AAA']);
    expect(withImage.text).not.toContain('flowchart');

    const withoutImage=markdownToXiaohongshuText(markdown);
    expect(withoutImage.images).toEqual([]);
    expect(withoutImage.warnings).toEqual(expect.arrayContaining(['Mermaid 图表未渲染为图片，已跳过该图表']));
  });

  it('未闭合代码块保留原文，避免内容静默丢失',()=>{
    const {text,hasCode}=markdownToXiaohongshuText('正文\n\n```js\nconst a=1;');
    expect(hasCode).toBe(true);
    expect(text).toContain('const a=1;');
  });
});

describe('小红书正文截断',()=>{
  it(`超过 ${XHS_BODY_MAX} 字按句子边界截断并标记`,()=>{
    const paragraph='这是用于验证截断行为的完整句子。';
    const body=paragraph.repeat(80);
    const result=truncateXiaohongshuBody(body);
    expect(result.truncated).toBe(true);
    expect([...result.text].length).toBeLessThanOrEqual(XHS_BODY_MAX);
    expect(result.text.endsWith('…')).toBe(true);
    expect(body.startsWith(result.text.slice(0,-1))).toBe(true);
  });

  it('未超限时保持原样',()=>{
    const result=truncateXiaohongshuBody('短正文');
    expect(result).toEqual({text:'短正文',truncated:false});
  });
});

describe('小红书话题格式',()=>{
  it('去重、去标点并限制数量',()=>{
    const tags=['前端','前端','React 实践','Node.js','#已带井号','','   '];
    expect(formatXiaohongshuTopics(tags)).toBe('#前端 #React实践 #Nodejs #已带井号');
  });

  it('最多保留 10 个话题',()=>{
    const tags=Array.from({length:15},(_,index)=>`标签${index}`);
    const topics=formatXiaohongshuTopics(tags).split(' ');
    expect(topics).toHaveLength(10);
  });

  it('超长标签按单标签限长截断，避免尾部挤占正文',()=>{
    const topics=formatXiaohongshuTopics(['这是一个特别特别特别特别特别长的小红书话题标签']);
    expect([...topics.slice(1)]).toHaveLength(XHS_TOPIC_MAX_LENGTH);
  });
});

describe('小红书笔记编译',()=>{
  it('封面排在第一张，正文图片按出现顺序且去重',()=>{
    const article=baseArticle({
      cover:'https://p3.byteimg.com/cover.png',
      markdown:'文字\n\n![图一](https://p3.byteimg.com/1.png)\n\n![图一重复](https://p3.byteimg.com/1.png)\n\n![图二](https://p3.byteimg.com/2.png)'
    });
    const note=compileXiaohongshuNote(article);
    expect(note.images).toEqual([
      'https://p3.byteimg.com/cover.png',
      'https://p3.byteimg.com/1.png',
      'https://p3.byteimg.com/2.png'
    ]);
  });

  it('关闭封面同步时只保留正文图片',()=>{
    const article=baseArticle({cover:'https://p3.byteimg.com/cover.png',markdown:'文字\n\n![图](https://p3.byteimg.com/1.png)'});
    const note=compileXiaohongshuNote(article,{syncCover:false});
    expect(note.images).toEqual(['https://p3.byteimg.com/1.png']);
  });

  it(`图片超过 ${XHS_IMAGE_MAX} 张时截断并警告`,()=>{
    const images=Array.from({length:XHS_IMAGE_MAX+3},(_,index)=>`https://p3.byteimg.com/${index}.png`);
    const article=baseArticle({markdown:`文字\n\n${images.map(src=>`![图](${src})`).join('\n\n')}`});
    const note=compileXiaohongshuNote(article);
    expect(note.images).toHaveLength(XHS_IMAGE_MAX);
    expect(note.warnings).toEqual(expect.arrayContaining([`图片超过 ${XHS_IMAGE_MAX} 张上限，已保留前 ${XHS_IMAGE_MAX} 张`]));
  });

  it('没有任何图片时阻断同步',()=>{
    const article=baseArticle({markdown:'只有文字，没有任何配图。'});
    expect(()=>compileXiaohongshuNote(article)).toThrow('至少需要 1 张图片');
  });

  it('空正文阻断同步',()=>{
    const article=baseArticle({markdown:'   ',cover:'https://p3.byteimg.com/cover.png'});
    expect(()=>compileXiaohongshuNote(article)).toThrow('文章正文不完整');
  });

  it('追加话题与来源说明，来源不含外链',()=>{
    const article=baseArticle({cover:'https://p3.byteimg.com/cover.png',tags:['前端'],sourceUrl:'https://juejin.cn/post/1'});
    const note=compileXiaohongshuNote(article);
    expect(note.body).toContain('#前端');
    expect(note.body).toContain('本文首发于掘金');
    expect(note.body).not.toContain('https://juejin.cn');
    expect(note.warnings).toEqual(expect.arrayContaining(['已省略原文链接：小红书正文不支持外链']));
  });

  it('关闭来源说明时不追加任何链接文案',()=>{
    const article=baseArticle({cover:'https://p3.byteimg.com/cover.png',sourceUrl:'https://juejin.cn/post/1'});
    const note=compileXiaohongshuNote(article,{appendSourceLink:false});
    expect(note.body).not.toContain('本文首发于掘金');
  });

  it('标题被截断时合并进警告列表',()=>{
    const article=baseArticle({
      title:'一二三四五六七八九十一二三四五六七八九十一二三四五',
      cover:'https://p3.byteimg.com/cover.png'
    });
    const note=compileXiaohongshuNote(article);
    expect(note.warnings).toEqual(expect.arrayContaining([`标题超过 ${XHS_TITLE_MAX} 字，已截断`]));
  });

  it('长文截断只截正文，话题与来源说明完整保留',()=>{
    const article=baseArticle({
      markdown:'这是一段用于验证截断预留策略的长正文。'.repeat(80),
      cover:'https://p3.byteimg.com/cover.png',
      tags:['前端','效率工具'],
      sourceUrl:'https://juejin.cn/post/1'
    });
    const note=compileXiaohongshuNote(article);
    expect([...note.body].length).toBeLessThanOrEqual(XHS_BODY_MAX);
    expect(note.body).toContain('#前端 #效率工具');
    expect(note.body.endsWith('本文首发于掘金')).toBe(true);
    expect(note.body).toContain('…\n\n#前端');
    expect(note.warnings).toEqual(expect.arrayContaining([`正文超过 ${XHS_BODY_MAX} 字，已截断`]));
  });

  it('尾部较长时仍不超出正文上限',()=>{
    const tags=Array.from({length:10},(_,index)=>`标签${'超长'.repeat(10)}${index}`);
    const article=baseArticle({
      markdown:'正文内容较短但依然需要保证总长度合法。',
      cover:'https://p3.byteimg.com/cover.png',
      tags,
      sourceUrl:'https://juejin.cn/post/1'
    });
    const note=compileXiaohongshuNote(article);
    expect([...note.body].length).toBeLessThanOrEqual(XHS_BODY_MAX);
    expect(note.body).toContain('#标签超长超长超长超长超长超长超长');
  });
});
