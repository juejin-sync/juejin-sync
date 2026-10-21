// 微信公众号内容编译器：将掘金 Markdown 重新渲染为微信编辑器可稳定保存的内联样式 HTML。
import {Marked,Renderer,type Token} from 'marked';
import hljs from 'highlight.js/lib/common';
import type {WechatCodeTheme} from '../types';
import {normalizeMarkdown} from './csdn-api';
import {resolveMermaidDiagram} from '../core/mermaid-render';

const COLORS={text:'#2b2b2b',muted:'#666666',accent:'#1d6744',border:'#dfe6e2',soft:'#f5f7f6',code:'#f6f8fa'};

export const WECHAT_CODE_THEMES:Record<WechatCodeTheme,{
  codeBg:string;
  headerBg:string;
  border:string;
  textColor:string;
  langColor:string;
  tokenStyles:Record<string,string>;
}>={
  'github-light':{
    codeBg:'#ffffff',
    headerBg:'#f6f8fa',
    border:'#e1e4e8',
    textColor:'#24292e',
    langColor:'#6a737d',
    tokenStyles:{
      'hljs-keyword':'color:#d73a49;font-weight:600;',
      'hljs-built_in':'color:#005cc5;',
      'hljs-type':'color:#005cc5;',
      'hljs-literal':'color:#005cc5;',
      'hljs-number':'color:#005cc5;',
      'hljs-operator':'color:#d73a49;',
      'hljs-punctuation':'color:#24292e;',
      'hljs-property':'color:#005cc5;',
      'hljs-regexp':'color:#032f62;',
      'hljs-string':'color:#032f62;',
      'hljs-subst':'color:#24292e;',
      'hljs-symbol':'color:#005cc5;',
      'hljs-class':'color:#6f42c1;font-weight:600;',
      'hljs-function':'color:#6f42c1;font-weight:600;',
      'hljs-title':'color:#6f42c1;font-weight:600;',
      'function_':'color:#6f42c1;font-weight:600;',
      'hljs-params':'color:#24292e;',
      'hljs-comment':'color:#6a737d;font-style:italic;',
      'hljs-doctag':'color:#d73a49;',
      'hljs-meta':'color:#005cc5;',
      'hljs-attr':'color:#005cc5;',
      'hljs-attribute':'color:#005cc5;',
      'hljs-name':'color:#22863a;',
      'hljs-tag':'color:#22863a;',
      'hljs-variable':'color:#e36209;'
    }
  },
  'onedark':{
    codeBg:'#282c34',
    headerBg:'#21252b',
    border:'#181a1f',
    textColor:'#abb2bf',
    langColor:'#828997',
    tokenStyles:{
      'hljs-keyword':'color:#c678dd;font-weight:600;',
      'hljs-built_in':'color:#e6c07b;',
      'hljs-type':'color:#e6c07b;',
      'hljs-literal':'color:#56b6c2;',
      'hljs-number':'color:#d19a66;',
      'hljs-operator':'color:#56b6c2;',
      'hljs-punctuation':'color:#abb2bf;',
      'hljs-property':'color:#e06c75;',
      'hljs-regexp':'color:#98c379;',
      'hljs-string':'color:#98c379;',
      'hljs-subst':'color:#abb2bf;',
      'hljs-symbol':'color:#61afef;',
      'hljs-class':'color:#e5c07b;font-weight:600;',
      'hljs-function':'color:#61afef;font-weight:600;',
      'hljs-title':'color:#61afef;font-weight:600;',
      'function_':'color:#61afef;font-weight:600;',
      'hljs-params':'color:#abb2bf;',
      'hljs-comment':'color:#5c6370;font-style:italic;',
      'hljs-doctag':'color:#c678dd;',
      'hljs-meta':'color:#61afef;',
      'hljs-attr':'color:#d19a66;',
      'hljs-attribute':'color:#98c379;',
      'hljs-name':'color:#e06c75;',
      'hljs-tag':'color:#e06c75;',
      'hljs-variable':'color:#e06c75;'
    }
  },
  'monokai':{
    codeBg:'#272822',
    headerBg:'#1e1f1c',
    border:'#171814',
    textColor:'#f8f8f2',
    langColor:'#75715e',
    tokenStyles:{
      'hljs-keyword':'color:#f92672;font-weight:600;',
      'hljs-built_in':'color:#66d9ef;',
      'hljs-type':'color:#66d9ef;',
      'hljs-literal':'color:#ae81ff;',
      'hljs-number':'color:#ae81ff;',
      'hljs-operator':'color:#f92672;',
      'hljs-punctuation':'color:#f8f8f2;',
      'hljs-property':'color:#a6e22e;',
      'hljs-regexp':'color:#e6db74;',
      'hljs-string':'color:#e6db74;',
      'hljs-subst':'color:#f8f8f2;',
      'hljs-symbol':'color:#ae81ff;',
      'hljs-class':'color:#a6e22e;font-weight:600;',
      'hljs-function':'color:#a6e22e;font-weight:600;',
      'hljs-title':'color:#a6e22e;font-weight:600;',
      'function_':'color:#a6e22e;font-weight:600;',
      'hljs-params':'color:#fd971f;',
      'hljs-comment':'color:#75715e;font-style:italic;',
      'hljs-doctag':'color:#f92672;',
      'hljs-meta':'color:#75715e;',
      'hljs-attr':'color:#a6e22e;',
      'hljs-attribute':'color:#e6db74;',
      'hljs-name':'color:#f92672;',
      'hljs-tag':'color:#f92672;',
      'hljs-variable':'color:#f8f8f2;'
    }
  }
};

function escapeHtml(value:string){return value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));}

export function highlightWechatCode(code:string,language:string,theme:WechatCodeTheme):string{
  const config=WECHAT_CODE_THEMES[theme]||WECHAT_CODE_THEMES.onedark;
  const normalizedLang=language.trim().toLowerCase();
  const aliasLang=({js:'javascript',ts:'typescript',py:'python',sh:'bash',zsh:'bash'} as Record<string,string>)[normalizedLang]||normalizedLang;

  let highlighted='';
  if(aliasLang&&hljs.getLanguage(aliasLang)){
    try{
      highlighted=hljs.highlight(code,{language:aliasLang,ignoreIllegals:true}).value;
    }catch{
      highlighted=escapeHtml(code);
    }
  }else{
    highlighted=escapeHtml(code);
  }

  const inlined=highlighted.replace(/<span\s+class="([^"]+)">/g,(_match,classListStr)=>{
    const classes=classListStr.split(/\s+/);
    const styles:string[]=[];
    for(const cls of classes){
      const style=config.tokenStyles[cls];
      if(style)styles.push(style);
    }
    return styles.length?`<span style="${styles.join(' ')}">`:'<span>';
  });

  return inlined.split(/(<[^>]+>)/g).map(part=>{
    if(part.startsWith('<')&&part.endsWith('>'))return part;
    return part.replace(/ /g,'&nbsp;');
  }).join('');
}

export function renderMacCodeCard(highlightedCode:string,language:string,theme:WechatCodeTheme):string{
  const config=WECHAT_CODE_THEMES[theme]||WECHAT_CODE_THEMES.onedark;
  const normalizedLang=language.trim().toLowerCase();
  const displayLang=normalizedLang?escapeHtml(normalizedLang):'';
  const lines=highlightedCode.split('\n').map(line=>`<code><span leaf="">${line||'&nbsp;'}</span></code>`).join('');

  return`<section class="code-snippet__js code-snippet__custom" style="margin:20px 0;border-radius:8px;overflow:hidden;background-color:${config.codeBg};box-shadow:0 4px 16px rgba(0,0,0,0.12);border:1px solid ${config.border};font-size:13px;font-family:Menlo,Monaco,Consolas,'Courier New',monospace;line-height:1.65;-webkit-font-smoothing:antialiased;">`+
    `<div class="code-snippet__header" style="display:flex;align-items:center;height:32px;padding:0 12px;background-color:${config.headerBg};border-bottom:1px solid ${config.border};box-sizing:border-box;user-select:none;">`+
      `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background-color:#ff5f56;margin-right:6px;flex:0 0 auto;"></span>`+
      `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background-color:#ffbd2e;margin-right:6px;flex:0 0 auto;"></span>`+
      `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background-color:#27c93f;margin-right:8px;flex:0 0 auto;"></span>`+
      (displayLang?`<span style="margin-left:auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:11px;color:${config.langColor};text-transform:lowercase;font-weight:500;letter-spacing:0.5px;">${displayLang}</span>`:'')+
    `</div>`+
    `<div style="padding:12px 14px;overflow-x:auto;-webkit-overflow-scrolling:touch;background-color:${config.codeBg};">`+
      `<pre class="code-snippet__js code-snippet code-snippet_nowrap" data-lang="${displayLang}" data-layout-id="null" style="margin:0;padding:0;font-family:inherit;font-size:12.5px;line-height:1.65;white-space:pre;word-break:normal;color:${config.textColor};tab-size:2;background:transparent;border:none;">${lines}</pre>`+
    `</div>`+
  `</section>`;
}

/** 仅合并加粗或行内代码后以标点开头的正文段落，不改写代码 token。 */
function joinPunctuationParagraphs(tokens:Token[]){
  for(const token of tokens){
    if(token.type==='list')for(const item of token.items)joinPunctuationParagraphs(item.tokens);
    else if(token.type==='blockquote')joinPunctuationParagraphs(token.tokens||[]);
  }
  for(let i=1;i<tokens.length;i++){
    const current=tokens[i];
    if(current.type!=='paragraph'||!/^[:;,.!?：；，。！？、]/.test(current.text))continue;
    let previousIndex=i-1;
    while(previousIndex>=0&&tokens[previousIndex].type==='space')previousIndex--;
    let previous=tokens[previousIndex];
    if(previous?.type==='list')previous=previous.items.at(-1)?.tokens.filter((token:Token)=>token.type!=='space').at(-1);
    if(!previous||!['paragraph','text'].includes(previous.type)||!('tokens' in previous)||!previous.tokens)continue;
    const last=previous.tokens.at(-1);
    if(last?.type!=='strong'&&last?.type!=='codespan')continue;
    previous.tokens.push(...(current.tokens||[]));
    tokens.splice(previousIndex+1,i-previousIndex);
    i=previousIndex;
  }
}

/** 清理行内 HTML 中的多余软换行与空白，防止微信二次渲染为强制断行或拆散加粗/代码与标点。 */
function cleanInlineHtml(content:string):string{
  return content
    // 1. 任何行内标签、中文、西文或右括号后紧随空白/换行/<br>/&nbsp; 及标点：彻底消除其间所有换行与空白，确保同行紧贴
    .replace(/(<\/(?:strong|span|em|b|i|code|a)>|[\u4e00-\u9fa5\w)）\]｝》】”’])(?:\s|<br\s*\/?>|&nbsp;|&#160;|\u00a0|\u3000)+([:;,.!?：；，。！？、）］｝》】”’—–])/gi, '$1$2')
    // 2. 标点前残留的任何 <br> 或空格软换行彻底清除
    .replace(/(?:\s|<br\s*\/?>|&nbsp;|&#160;|\u00a0|\u3000)+([:;,.!?：；，。！？、）］｝》】”’—–])/g, '$1')
    // 3. 中文标点后紧随的多余空格或换行清除（中文排版标点自带间距，避免分行）
    .replace(/([：；，。！？、])(?:\s|<br\s*\/?>|&nbsp;|&#160;|\u00a0|\u3000)+/g, '$1')
    // 4. 中文与标签之间的换行消除（防止断裂与多余空格）
    .replace(/(>)\s*\n\s*([\u4e00-\u9fa5])/g, '$1$2')
    .replace(/([\u4e00-\u9fa5])\s*\n\s*(<)/g, '$1$2')
    .replace(/([\u4e00-\u9fa5])\s*\n\s*([\u4e00-\u9fa5])/g, '$1$2')
    // 5. 标签与斜杠之间的换行折叠为单个空格
    .replace(/(>)\s*\n\s*(\/)/g, '$1 $2')
    // 6. 消除括号/引号闭合与标点间的多余空格，如 ) 。 -> )。
    .replace(/([)）\]｝》】”’])\s+([：；，。！？、）］｝》】”’])/g, '$1$2')
    // 7. 其余西文与跨行软换行折叠为单个空格
    .replace(/\s*\n\s*/g, ' ');
}

/** 对最终编译出的微信 HTML 进行终极格式净化，消除任何可能引起微信编辑器断行的孤立换行与结构性撕裂。 */
function cleanFinalWechatHtml(html:string):string{
  return html
    // 确保加粗/行内标签后紧跟的冒号/逗号绝无空格和换行
    .replace(/(<\/(?:strong|b|span|code)>)(?:\s|<br\s*\/?>|&nbsp;|&#160;|\u00a0|\u3000)*([:;,.!?：；，。！？、）］｝》】”’—–])/gi, '$1$2')
    // 确保 <li> 标签内部不保留孤立的纯换行符 \n（微信编辑器会将富文本内的未包装裸换行符解析为独立行）
    .replace(/<li\b([^>]*)>([\s\S]*?)<\/li>/gi, (_match, attrs, inner) => {
      let cleaned = cleanInlineHtml(inner)
        .replace(/(<\/(?:strong|b)>)\s*([:;,.!?：；，。！？、])/gi, '$1$2')
        .replace(/\s*\n\s*/g, ' ')
        .trim();
      return `<li${attrs}>${cleaned}</li>`;
    });
}

/** 普通正文使用内联样式；代码块保留微信编辑器专用的结构与经典 Mac 三色圆点卡片高亮；Mermaid 图表支持渲染为图片。 */
export function compileWechatHtml(markdown:string,options?:{mermaidImages?:Map<string,string>;theme?:WechatCodeTheme}){
  const theme:WechatCodeTheme=options?.theme||'onedark';
  // 仅处理解析后的 HTML 节点，不修改围栏代码与行内代码中的标签示例。
  const references:string[]=[];
  // 暂存代码 HTML，正文清洗完成后还原，防止空白和标点处理进入字面量。
  const literals:string[]=[];
  const preserveLiteral=(html:string)=>`<code data-wechat-literal="${literals.push(html)-1}"></code>`;
  const renderer=new Renderer();
  renderer.heading=function({tokens,depth}){
    const text=cleanInlineHtml(this.parser.parseInline(tokens));
    if(depth===1)return`<h1 style="margin:32px 0 16px;font-size:24px;line-height:1.45;color:${COLORS.text};font-weight:700;text-align:left;">${text}</h1>`;
    if(depth===2)return`<h2 style="margin:30px 0 14px;padding-left:12px;border-left:4px solid ${COLORS.accent};font-size:21px;line-height:1.5;color:${COLORS.text};font-weight:700;text-align:left;">${text}</h2>`;
    return`<h3 style="margin:24px 0 12px;font-size:18px;line-height:1.55;color:${COLORS.text};font-weight:700;text-align:left;">${text}</h3>`;
  };
  renderer.paragraph=function({tokens}){return`<p style="margin:16px 0;font-size:16px;line-height:1.8;color:${COLORS.text};text-align:left;word-break:break-word;">${cleanInlineHtml(this.parser.parseInline(tokens))}</p>`;};
  renderer.blockquote=function({tokens}){return`<blockquote style="margin:20px 0;padding:12px 16px;border-left:4px solid ${COLORS.accent};background:${COLORS.soft};color:${COLORS.muted};text-align:left;word-break:break-word;">${this.parser.parse(tokens)}</blockquote>`;};
  renderer.code=function({text,lang}){
    const {isDiagram,renderCode}=resolveMermaidDiagram(lang,text);
    if(isDiagram){
      const imageUrl=options?.mermaidImages?.get(renderCode);
      if(imageUrl){
        return`<p style="margin:22px 0;text-align:center;"><img src="${escapeHtml(imageUrl)}" alt="Mermaid 图表" style="display:block;max-width:100%;height:auto;margin:0 auto;" /></p>`;
      }
      throw new Error('Mermaid 图表缺少渲染图片，已停止生成缺图正文');
    }
    const cleanCode=text.replace(/\r\n?/g,'\n').replace(/\t/g,'  ');
    const language=lang?.trim().split(/\s+/)[0]||'';
    const normalizedLanguage=({js:'javascript',ts:'typescript',py:'python',sh:'bash',zsh:'bash'} as Record<string,string>)[language]||language;
    const highlighted=highlightWechatCode(cleanCode,normalizedLanguage,theme);
    return preserveLiteral(renderMacCodeCard(highlighted,normalizedLanguage,theme));
  };
  renderer.codespan=function({text}){return preserveLiteral(`<span style="display:inline;padding:2px 5px;border-radius:3px;background:${COLORS.code};color:#c7254e;font-size:0.9em;font-family:Menlo,Consolas,monospace;word-break:break-word;overflow-wrap:break-word;">${escapeHtml(text)}</span>`);};
  renderer.strong=function({tokens}){return`<strong style="font-weight:700;color:${COLORS.text};display:inline;">${cleanInlineHtml(this.parser.parseInline(tokens))}</strong>`;};
  renderer.em=function({tokens}){return`<em style="font-style:italic;display:inline;">${cleanInlineHtml(this.parser.parseInline(tokens))}</em>`;};
  renderer.del=function({tokens}){return`<span style="text-decoration:line-through;color:${COLORS.muted};display:inline;">${cleanInlineHtml(this.parser.parseInline(tokens))}</span>`;};
  renderer.link=function({tokens,href}){
    const target=(href||'').trim();
    const isHttpUrl=/^https?:\/\//i.test(target);
    const label=cleanInlineHtml(this.parser.parseInline(tokens));
    if(!isHttpUrl){
      return`<span style="color:${COLORS.accent};text-decoration:underline;">${label}</span>`;
    }
    let number=references.indexOf(target)+1;
    if(!number)number=references.push(target);
    return`<span style="color:${COLORS.accent};text-decoration:underline;">${label}</span><sup>[${number}]</sup>`;
  };
  renderer.image=function({href,text}){return`<p style="margin:22px 0;text-align:center;"><img src="${escapeHtml(href)}" alt="${escapeHtml(text)}" style="display:block;max-width:100%;height:auto;margin:0 auto;" /></p>`;};
  renderer.hr=function(){return`<hr style="margin:28px 0;border:0;border-top:1px solid ${COLORS.border};" />`;};
  renderer.list=function(token){
    const tag=token.ordered?'ol':'ul';
    const start=token.ordered&&token.start&&token.start!==1?` start="${token.start}"`:'';
    let body='';
    for(let i=0;i<token.items.length;i++)body+=this.listitem(token.items[i]);
    return`<${tag}${start} style="margin:16px 0;padding-left:2em;color:${COLORS.text};text-align:left;">${body}</${tag}>`;
  };
  renderer.listitem=function(item){
    // 整句使用同一个段落容器，避免富文本编辑器分别归一化加粗节点与裸文本。
    const paragraph=(text:string)=>`<p style="margin:0;font-size:16px;line-height:1.75;text-align:left;word-break:break-word;">${cleanInlineHtml(text)}</p>`;
    let content='';
    if(item.tokens){
      content=item.tokens.map(token=>{
        if(token.type==='text'||token.type==='paragraph'){
          return paragraph(token.tokens?this.parser.parseInline(token.tokens):escapeHtml(token.text||''));
        }
        return this.parser.parse([token]);
      }).join('');
    }else{
      content=paragraph(escapeHtml(item.text||''));
    }
    return`<li style="margin:8px 0;font-size:16px;line-height:1.75;text-align:left;word-break:break-word;">${cleanInlineHtml(content)}</li>`;
  };
  renderer.table=function(token){
    const cell=(item:(typeof token.header)[number])=>{const tag=item.header?'th':'td';const background=item.header?`background:${COLORS.soft};font-weight:700;`:'';return`<${tag} style="padding:8px 10px;border:1px solid ${COLORS.border};${background}text-align:${item.align||'left'};">${cleanInlineHtml(this.parser.parseInline(item.tokens))}</${tag}>`;};
    const header=`<tr>${token.header.map(cell).join('')}</tr>`;
    const body=token.rows.map(row=>`<tr>${row.map(cell).join('')}</tr>`).join('');
    return`<section style="margin:20px 0;overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:14px;line-height:1.6;"><thead>${header}</thead><tbody>${body}</tbody></table></section>`;
  };
  renderer.tablerow=function({text}){return`<tr>${text}</tr>`;};
  renderer.tablecell=function(token){const tag=token.header?'th':'td';const background=token.header?`background:${COLORS.soft};font-weight:700;`:'';return`<${tag} style="padding:8px 10px;border:1px solid ${COLORS.border};${background}text-align:${token.align||'left'};">${cleanInlineHtml(this.parser.parseInline(token.tokens))}</${tag}>`;};
  renderer.html=function({text}){
    // 原始 HTML 不透传属性；图片只保留地址，其余标签保留可见文本。
    const safe=text.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi,'');
    return safe.split(/(<img\b[^>]*>)/gi).map(part=>{
      const src=part.match(/^<img\b[^>]*\bsrc=["']([^"']+)["']/i)?.[1];
      if(src)return`<img src="${escapeHtml(src.replace(/&amp;/g,'&'))}" style="display:block;max-width:100%;height:auto;margin:22px auto;" />`;
      return escapeHtml(part.replace(/<[^>]*>/g,''));
    }).join('');
  };
  const marked=new Marked({renderer,gfm:true,breaks:false});
  const tokens=marked.lexer(normalizeMarkdown(markdown));
  joinPunctuationParagraphs(tokens);
  const html=cleanFinalWechatHtml(marked.parser(tokens)).replace(/<code data-wechat-literal="(\d+)"><\/code>/g,(_match,index)=>literals[Number(index)]);
  const footnotes=references.length?`<section style="margin-top:28px;font-size:13px;word-break:break-all;"><p>参考链接</p>${references.map((url,index)=>`<p>[${index+1}] ${escapeHtml(url)}</p>`).join('')}</section>`:'';
  return`<section style="margin:0 6px;font-size:16px;line-height:1.8;color:${COLORS.text};text-align:left;word-break:break-word;">${html}${footnotes}</section>`;
}

export function collectWechatImageUrls(html:string){
  return[...new Set([...html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/gi)].map(match=>match[1].replace(/&amp;/g,'&')))];
}

export function replaceWechatImageUrls(html:string,replacements:Map<string,string>){
  return html.replace(/(<img\b[^>]*\bsrc=")([^"]+)(")/gi,(match,prefix,source,suffix)=>{
    const target=replacements.get(source.replace(/&amp;/g,'&'));
    return target?`${prefix}${escapeHtml(target)}${suffix}`:match;
  });
}
