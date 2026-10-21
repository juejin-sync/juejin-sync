// 1.2.0 排版回归：代码字面量不得因中文正文清洗发生变化。
import {describe,it,expect} from 'vitest';
import {normalizeMarkdown} from '../src/targets/csdn-api';
import {compileWechatHtml} from '../src/targets/wechat-content';

function codeLines(html:string){
  return [...html.matchAll(/<code><span leaf="">([\s\S]*?)<\/span><\/code>/g)].map(([,line])=>line==='&nbsp;'?'':line.replace(/<[^>]+>/g,'').replace(/&nbsp;/g,' ').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&amp;/g,'&')).join('\n');
}

describe('代码内容保真',()=>{
  it.each(['python','markdown'])('保留 %s 围栏中的加粗示例和跨行标点',language=>{
    const code='text = """**标题**\n\n: 下一行"""';
    const md=`\`\`\`${language}\n${code}\n\`\`\``;
    expect(normalizeMarkdown(md)).toBe(md);
    expect(codeLines(compileWechatHtml(md))).toBe(code);
  });
  it('保留列表内代码块的缩进及标点空格',()=>{
    const code='if (ready) {\n  log("a , b： c");\n}';
    const md='- 示例\n\n  ```js\n'+code.split('\n').map(line=>'  '+line).join('\n')+'\n  ```';
    expect(codeLines(compileWechatHtml(md))).toBe(code);
  });
  it('保留行内代码内部空格，但允许外部标点紧贴',()=>{
    const html=compileWechatHtml('- `a , b： c`\n  ：说明');
    expect(html).toContain('>a , b： c</span>：说明');
  });
});
