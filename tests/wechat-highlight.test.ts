import {describe,expect,it} from 'vitest';
import {compileWechatHtml,highlightWechatCode,renderMacCodeCard,WECHAT_CODE_THEMES} from '../src/targets/wechat-content';

describe('微信代码块质感排版与高亮着色',()=>{
  const sampleJs=`const greeting = "Hello, World!";\nfunction add(a, b) {\n  return a + b;\n}`;

  it('渲染标准的 Mac 经典三色圆点装饰（红黄绿点）与右上角语言标签',()=>{
    const card=renderMacCodeCard('const a = 1;','typescript','onedark');
    // 红黄绿三色圆点
    expect(card).toContain('background-color:#ff5f56');
    expect(card).toContain('background-color:#ffbd2e');
    expect(card).toContain('background-color:#27c93f');
    // 右上角语言标签
    expect(card).toContain('typescript');
    // 微信原生 code-snippet__js 兼容类与 pre
    expect(card).toContain('class="code-snippet__js code-snippet__custom"');
    expect(card).toContain('class="code-snippet__js code-snippet code-snippet_nowrap"');
  });

  it('移动端自适应：具备横向滚动与防硬换行规则', ()=>{
    const card=renderMacCodeCard('const a = 1;','javascript','onedark');
    expect(card).toContain('overflow-x:auto');
    expect(card).toContain('-webkit-overflow-scrolling:touch');
    expect(card).toContain('white-space:pre');
    expect(card).toContain('word-break:normal');
  });

  it('支持浅色 GitHub Light 主题代码着色（白底、深色字、内联样式）',()=>{
    const html=compileWechatHtml('```javascript\n'+sampleJs+'\n```',{theme:'github-light'});
    // 背景为白色
    expect(html).toContain('background-color:#ffffff');
    // 文本主色
    expect(html).toContain('color:#24292e');
    // 关键字着色 #d73a49
    expect(html).toContain('color:#d73a49');
    // 字符串着色 #032f62
    expect(html).toContain('color:#032f62');
    // 不含外部 class 语法高亮类
    expect(html).not.toContain('class="hljs-keyword"');
  });

  it('支持深色 OneDark 主题代码着色（深灰蓝底、OneDark 色谱）',()=>{
    const html=compileWechatHtml('```javascript\n'+sampleJs+'\n```',{theme:'onedark'});
    // OneDark 背景 #282c34
    expect(html).toContain('background-color:#282c34');
    // 文本色 #abb2bf
    expect(html).toContain('color:#abb2bf');
    // 关键字 #c678dd
    expect(html).toContain('color:#c678dd');
    // 字符串 #98c379
    expect(html).toContain('color:#98c379');
  });

  it('支持深色 Monokai 主题代码着色（复古深底、Monokai 标志色谱）',()=>{
    const html=compileWechatHtml('```javascript\n'+sampleJs+'\n```',{theme:'monokai'});
    // Monokai 背景 #272822
    expect(html).toContain('background-color:#272822');
    // 文本色 #f8f8f2
    expect(html).toContain('color:#f8f8f2');
    // 关键字 #f92672
    expect(html).toContain('color:#f92672');
    // 字符串 #e6db74
    expect(html).toContain('color:#e6db74');
  });

  it('标签外部空格转为 &nbsp; 保护缩进，且不损坏标签内部 style 属性', ()=>{
    const highlighted=highlightWechatCode('  return a + b;','javascript','onedark');
    // 缩进空格被转为 &nbsp;
    expect(highlighted).toContain('&nbsp;&nbsp;');
    // span style 属性格式完好
    expect(highlighted).toContain('<span style="color:#c678dd;font-weight:600;">return</span>');
  });

  it('未标注语言或未知语言安全 fallback，不抛错且安全转义',()=>{
    const unknownCode='<hello & "world">';
    const html=compileWechatHtml('```unknown-lang-xyz\n'+unknownCode+'\n```');
    expect(html).toContain('&lt;hello');
    expect(html).toContain('&amp;');
    expect(html).toContain('&quot;world&quot;');
  });
});
