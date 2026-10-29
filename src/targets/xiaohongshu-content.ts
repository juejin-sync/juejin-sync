// 小红书共享文本提取：Markdown 转可读文本与图片候选，格式限制由双格式编译器处理。
import {resolveMermaidDiagram} from '../core/mermaid-render';
import {normalizeMarkdown} from './csdn-api';
import {Lexer} from 'marked';

export const XHS_TOPIC_MAX=10;
export const XHS_TOPIC_MAX_LENGTH=20;

const IMAGE_PATTERN=/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g;
const HTML_IMAGE_PATTERN=/<img\b[^>]*\bsrc=["']([^"']+)["']/gi;
const TABLE_SEPARATOR=/^\s*\|?[\s:|-]+\|?\s*$/;


export type XiaohongshuTextResult={text:string;images:string[];warnings:string[];hasCode:boolean;hasTable:boolean;hasFormula:boolean};

function sliceCodePoints(value:string,limit:number){return[...value].slice(0,limit).join('');}

/** 去除行内 Markdown/HTML 标记，保留可读文本（链接只留文字，图片另行提取）。 */
export function stripInlineMarkdown(text:string):string{
  // 先解析标记再提取文本，不能把代码和配置值中的星号、下划线当作排版符号删除。
  const plain=(tokens:any[]):string=>tokens.map(token=>{
    if(token.type==='image'||token.type==='html')return '';
    if(token.type==='br')return ' ';
    return token.tokens?plain(token.tokens):(token.text||'');
  }).join('');
  return plain(Lexer.lexInline(text)).replace(/\s+/g,' ').trim();
}

function pushImage(images:string[],src:string){
  const value=(src||'').trim().replace(/&amp;/g,'&');
  if(value&&!images.includes(value))images.push(value);
}

/** 标签转 #话题：去掉空白与标点、按大小写去重、单标签限长、最多 10 个。 */
export function formatXiaohongshuTopics(tags:string[]){
  const seen=new Set<string>();
  const topics:string[]=[];
  for(const tag of tags||[]){
    const cleaned=String(tag||'').replace(/[#\s]+/g,'').replace(/[，,。.、；;：:！!？?“”"'（）()【】[\]<>《》]/g,'').trim();
    // 单标签限长，确保话题尾部篇幅可控，长文截断时不会被整段丢弃。
    const label=sliceCodePoints(cleaned,XHS_TOPIC_MAX_LENGTH);
    if(!label)continue;
    const key=label.toLocaleLowerCase();
    if(seen.has(key))continue;
    seen.add(key);
    topics.push(`#${label}`);
    if(topics.length>=XHS_TOPIC_MAX)break;
  }
  return topics.join(' ');
}

/**
 * Markdown 转小红书纯文本：标题降级为普通行、列表保留符号、表格按行拆分、
 * 代码块与公式保留原文，Mermaid 图表按渲染结果替换为图片。
 */
export function markdownToXiaohongshuText(markdown:string,mermaidImages?:Map<string,string>):XiaohongshuTextResult{
  const normalized=normalizeMarkdown(markdown||'');
  const images:string[]=[];
  const output:string[]=[];
  const warnings:string[]=[];
  let hasCode=false,hasTable=false,hasFormula=false;
  let inFence=false;
  let fenceLang='';
  let fenceLines:string[]=[];
  const pushText=(value:string)=>{const text=value.trim();if(text)output.push(text);};

  for(const rawLine of normalized.split('\n')){
    const line=rawLine.replace(/\s+$/,'');
    if(!inFence&&/^\s{0,3}```/.test(line)){
      inFence=true;
      fenceLang=line.replace(/^\s{0,3}```/,'').trim();
      fenceLines=[];
      continue;
    }
    if(inFence){
      if(/^\s{0,3}```/.test(line)){
        inFence=false;
        const code=fenceLines.join('\n').trim();
        const {isDiagram,renderCode}=resolveMermaidDiagram(fenceLang,code);
        if(isDiagram){
          const dataUrl=mermaidImages?.get(renderCode);
          if(dataUrl)pushImage(images,dataUrl);
          else warnings.push('Mermaid 图表未渲染为图片，已跳过该图表');
        }else{
          hasCode=true;
          pushText(code);
        }
        continue;
      }
      fenceLines.push(rawLine);
      continue;
    }

    // 图片先于文本提取：图片 Markdown 会被移除，不进入正文。
    for(const match of line.matchAll(IMAGE_PATTERN))pushImage(images,match[1]);
    for(const match of line.matchAll(HTML_IMAGE_PATTERN))pushImage(images,match[1]);

    if(!line.trim()){output.push('');continue;}
    if(/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line))continue;

    const heading=line.match(/^\s{0,3}#{1,6}\s+(.*)$/);
    if(heading){pushText(stripInlineMarkdown(heading[1]));continue;}

    if(/^\s{0,3}>\s?/.test(line)){pushText(stripInlineMarkdown(line.replace(/^\s{0,3}>\s?/,'')));continue;}

    if(TABLE_SEPARATOR.test(line)){hasTable=true;continue;}
    if(/^\s{0,3}\|.*\|\s*$/.test(line)){
      hasTable=true;
      const cells=line.trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map(cell=>stripInlineMarkdown(cell)).filter(Boolean);
      pushText(cells.join(' | '));
      continue;
    }

    const ordered=line.match(/^\s{0,3}(\d+)[.)]\s+(.*)$/);
    if(ordered){pushText(`${ordered[1]}. ${stripInlineMarkdown(ordered[2])}`);continue;}
    const unordered=line.match(/^\s{0,3}[-*+]\s+(.*)$/);
    if(unordered){pushText(`· ${stripInlineMarkdown(unordered[1])}`);continue;}

    if(/^\s*\$\$|\$[^$\n]+\$/.test(line))hasFormula=true;
    const plain=stripInlineMarkdown(line).replace(/\$\$?/g,'').trim();
    pushText(plain);
  }

  if(inFence&&fenceLines.length){
    // 未闭合的代码块按普通文本保留，避免内容静默丢失。
    hasCode=true;
    pushText(fenceLines.join('\n'));
  }
  if(hasCode)warnings.push('代码块已转为纯文本（小红书不支持代码高亮）');
  if(hasTable)warnings.push('表格已按行转为纯文本');
  if(hasFormula)warnings.push('公式已转为 LaTeX 纯文本');

  const text=output.join('\n').replace(/\n{3,}/g,'\n\n').replace(/^\n+|\n+$/g,'').trim();
  return{text,images,warnings,hasCode,hasTable,hasFormula};
}
