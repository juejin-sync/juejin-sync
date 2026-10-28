// 小红书图文笔记编译器：Markdown 转纯文本正文与有序图片，遵循平台标题/正文/图片上限。
import type {Article} from '../types';
import {SyncError} from '../core/diagnostic';
import {resolveMermaidDiagram} from '../core/mermaid-render';
import {normalizeMarkdown} from './csdn-api';

export const XHS_TITLE_MAX=20;
export const XHS_BODY_MAX=1000;
export const XHS_IMAGE_MAX=18;
export const XHS_TOPIC_MAX=10;
export const XHS_TOPIC_MAX_LENGTH=20;

const TRUNCATE_SUFFIX='…';
const SOURCE_NOTE='本文首发于掘金';
const IMAGE_PATTERN=/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g;
const HTML_IMAGE_PATTERN=/<img\b[^>]*\bsrc=["']([^"']+)["']/gi;
const TABLE_SEPARATOR=/^\s*\|?[\s:|-]+\|?\s*$/;

export type XiaohongshuNote={title:string;body:string;images:string[];warnings:string[]};
export type XiaohongshuCompileOptions={appendSourceLink?:boolean;syncCover?:boolean;mermaidImages?:Map<string,string>};

export type XiaohongshuTextResult={text:string;images:string[];warnings:string[];hasCode:boolean;hasTable:boolean;hasFormula:boolean};

function codePointLength(value:string){return[...value].length;}
function sliceCodePoints(value:string,limit:number){return[...value].slice(0,limit).join('');}

/** 去除行内 Markdown/HTML 标记，保留可读文本（链接只留文字，图片另行提取）。 */
export function stripInlineMarkdown(text:string):string{
  return text
    .replace(IMAGE_PATTERN,'')
    .replace(/\[([^\]]*)\]\([^)]*\)/g,'$1')
    .replace(/<[^>]+>/g,'')
    .replace(/`([^`]*)`/g,'$1')
    .replace(/(\*\*|__)(.*?)\1/g,'$2')
    .replace(/~~(.*?)~~/g,'$1')
    .replace(/(^|[\s（(【])([*_])([^*_\n]+)\2(?=[\s）)】。，,.!?！？]|$)/g,'$1$3')
    .replace(/[*_~`]{2,}/g,'')
    .replace(/\\([\\`*_{}[\]()#+\-.!])/g,'$1')
    .replace(/\s+/g,' ')
    .trim();
}

/** 标题按平台 20 字限制截断；空标题直接阻断，避免生成无名草稿。 */
export function buildXiaohongshuTitle(raw:string){
  const cleaned=stripInlineMarkdown(raw||'').replace(/\s+/g,' ').trim();
  if(!cleaned)throw new SyncError('小红书标题不能为空，请补充文章标题','content','validation');
  if(codePointLength(cleaned)<=XHS_TITLE_MAX)return{title:cleaned,truncated:false};
  return{title:`${sliceCodePoints(cleaned,XHS_TITLE_MAX-1)}${TRUNCATE_SUFFIX}`,truncated:true};
}

function pushImage(images:string[],src:string){
  const value=(src||'').trim().replace(/&amp;/g,'&');
  if(value&&!images.includes(value))images.push(value);
}

/** 正文按段落边界截断，优先保留完整句子；上限之外追加省略号。 */
export function truncateXiaohongshuBody(body:string,limit=XHS_BODY_MAX){
  const chars=[...body];
  if(chars.length<=limit)return{text:body,truncated:false};
  const candidate=chars.slice(0,limit-1).join('');
  const breakpoints=['\n','。','！','？','；','. ','! ','? '].map(token=>candidate.lastIndexOf(token));
  const breakAt=Math.max(...breakpoints);
  const keep=breakAt>=Math.floor(limit*0.6)?candidate.slice(0,breakAt+1):candidate;
  return{text:`${keep.trimEnd()}${TRUNCATE_SUFFIX}`,truncated:true};
}

/** 标签转 #话题：去掉空白与标点、按大小写去重、最多 10 个。 */
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

export function validateXiaohongshuNote(note:XiaohongshuNote){
  if(!note.title.trim())throw new SyncError('小红书标题不能为空，请补充文章标题','content','validation');
  if(codePointLength(note.title)>XHS_TITLE_MAX)throw new SyncError(`小红书标题不能超过 ${XHS_TITLE_MAX} 字`,'content','validation');
  if(!note.body.trim())throw new SyncError('小红书正文不能为空，请补充文章内容','content','validation');
  if(codePointLength(note.body)>XHS_BODY_MAX)throw new SyncError(`小红书正文不能超过 ${XHS_BODY_MAX} 字`,'content','validation');
  if(note.images.length===0)throw new SyncError('小红书图文笔记至少需要 1 张图片：请为文章添加封面或正文配图','content','validation');
  if(note.images.length>XHS_IMAGE_MAX)throw new SyncError(`小红书图文笔记最多 ${XHS_IMAGE_MAX} 张图片`,'content','validation');
}

/** 编译为可直接驱动发布页的笔记结构：标题、正文、图片顺序与全部警告。 */
export function compileXiaohongshuNote(article:Article,options:XiaohongshuCompileOptions={}):XiaohongshuNote{
  if(!article?.markdown?.trim())throw new SyncError('文章正文不完整，暂无法同步到小红书','content','validation');
  const warnings:string[]=[];
  const {title,truncated:titleTruncated}=buildXiaohongshuTitle(article.title);
  if(titleTruncated)warnings.push(`标题超过 ${XHS_TITLE_MAX} 字，已截断`);

  const converted=markdownToXiaohongshuText(article.markdown,options.mermaidImages);
  warnings.push(...converted.warnings);

  const images:string[]=[];
  if(options.syncCover!==false&&article.cover?.trim())pushImage(images,article.cover);
  for(const src of converted.images)pushImage(images,src);
  if(images.length>XHS_IMAGE_MAX){
    images.splice(XHS_IMAGE_MAX);
    warnings.push(`图片超过 ${XHS_IMAGE_MAX} 张上限，已保留前 ${XHS_IMAGE_MAX} 张`);
  }

  const tailSegments:string[]=[];
  const topics=formatXiaohongshuTopics(article.tags||[]);
  if(topics)tailSegments.push(topics);
  if(options.appendSourceLink!==false&&article.sourceUrl){
    tailSegments.push(SOURCE_NOTE);
    warnings.push('已省略原文链接：小红书正文不支持外链');
  }
  const tail=tailSegments.length?`\n\n${tailSegments.join('\n\n')}`:'';
  // 先为话题与来源说明预留篇幅：长文只截正文，尾部信息必须完整保留。
  const bodyBudget=Math.max(1,XHS_BODY_MAX-codePointLength(tail));
  const truncatedBody=truncateXiaohongshuBody(converted.text,bodyBudget);
  if(truncatedBody.truncated)warnings.push(`正文超过 ${XHS_BODY_MAX} 字，已截断`);

  const note:XiaohongshuNote={title,body:`${truncatedBody.text}${tail}`,images,warnings};
  validateXiaohongshuNote(note);
  return note;
}
