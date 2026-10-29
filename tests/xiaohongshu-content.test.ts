// 小红书共享文本提取与话题清理；两种格式的内容编排在 formats 测试中验证。
import {describe,expect,it} from 'vitest';
import {XHS_TOPIC_MAX_LENGTH,formatXiaohongshuTopics,markdownToXiaohongshuText} from '../src/targets/xiaohongshu-content';

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
