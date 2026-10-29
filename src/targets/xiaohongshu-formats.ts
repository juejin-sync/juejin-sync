// 小红书双格式内容契约：长文保留完整结构，精简图文使用可编辑的抽取内容与本地图卡。
import {Marked} from 'marked';
import {md5} from 'js-md5';
import type {Article,XiaohongshuCard,XiaohongshuImageContent} from '../types';
import {SyncError} from '../core/diagnostic';
import {resolveMermaidDiagram} from '../core/mermaid-render';
import {markdownToXiaohongshuText,formatXiaohongshuTopics,stripInlineMarkdown} from './xiaohongshu-content';
import {normalizeMarkdown} from './csdn-api';
import {fitXiaohongshuArticle,type ArticleBlock} from './xiaohongshu-article-summary';
export {XHS_ARTICLE_BODY_MAX,xhsWordCount} from './xiaohongshu-budget';

export const XHS_ARTICLE_TITLE_MAX=64;
export const XHS_IMAGE_BODY_MAX=1000;
export const XHS_IMAGE_TITLE_MAX=20;
export const XHS_IMAGE_MAX=18;
const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export const imageKey=(src:string)=>src.startsWith('data:')?`data:${md5(src)}`:src.split('?')[0];
export function xhsImageLength(text:string){return [...text].length;}

export function xhsImageCandidates(article:Article,mermaidImages?:Map<string,string>){
  const converted=markdownToXiaohongshuText(article.markdown,mermaidImages);
  return [...new Set([article.cover,...converted.images].filter((src):src is string=>!!src))];
}

export type XiaohongshuArticleContent={title:string;html:string;text:string;images:string[];warnings:string[]};
/** 长文只生成平台已验证支持的结构；代码逐行保留，表格显式转为字段列表，不静默压平。 */
export function compileXiaohongshuArticle(article:Article,options:{mermaidImages?:Map<string,string>;appendSourceLink?:boolean;imageWeight?:number}={}):XiaohongshuArticleContent{
  const title=article.title.trim();
  if(!title||title.length>XHS_ARTICLE_TITLE_MAX)throw new SyncError('小红书长文标题需为 1～64 个字符，请调整原文标题或在偏好设置中选择其他格式','content','validation');
  const images:string[]=[],warnings:string[]=[],texts:string[]=[],countTexts:string[]=[];
  // 可读正文用换行分段，平台只累计富文本 text 节点；段落边界和 hardBreak 不占字数。
  const addText=(s:string,countText=s)=>{texts.push(s);countTexts.push(countText);};
  const image=(src:string)=>{const index=images.push(src)-1;return `<p data-xhs-image="${index}"></p>`;};
  const marked=new Marked({gfm:true});
  function render(tokens:any[]):string{
    let checkboxPrefix='';
    return tokens.map(token=>{
      switch(token.type){
        case 'space':return '';
        case 'checkbox':
          warnings.push('勾选列表已转为保留勾选状态的普通列表');
          checkboxPrefix+=token.checked?'☑ ':'☐ ';return '';
        case 'heading':{const text=stripInlineMarkdown(token.text);addText(text);return `<h${Math.min(token.depth,2)}>${escape(text)}</h${Math.min(token.depth,2)}>`;}
        case 'paragraph':case 'text':{
          // 通过 token 而非替换整行，保留与正文交错出现的配图位置。
          const parts=token.tokens||[{type:'text',text:token.text}];
          let html='',line=checkboxPrefix;checkboxPrefix='';
          const flush=()=>{if(line){addText(line,line.replace(/\n/g,''));html+=`<p>${escape(line).replace(/\n/g,'<br>')}</p>`;line='';}};
          for(const part of parts){
            if(['strong','em','del','codespan','link'].includes(part.type))warnings.push('行内强调、代码和链接按可读文本保留');
            if(part.type==='checkbox'){
              warnings.push('勾选列表已转为保留勾选状态的普通列表');
              line+=part.checked?'☑ ':'☐ ';
            }
            else if(part.type==='image'){flush();html+=image(part.href);}
            else if(part.type==='html'&&/<img\b/i.test(part.text))throw new SyncError('长文中的 HTML 图片请改为 Markdown 图片后重试','content','content');
            else line+=part.type==='br'?'\n':['text','codespan','escape'].includes(part.type)?(part.text||''):stripInlineMarkdown(part.raw||part.text||'');
          }
          flush();return html;
        }
        case 'list':return `<${token.ordered?'ol':'ul'}>${token.items.map((item:any)=>`<li>${render(item.tokens)}</li>`).join('')}</${token.ordered?'ol':'ul'}>`;
        case 'blockquote':return `<blockquote>${render(token.tokens)}</blockquote>`;
        case 'code':{
          const diagram=resolveMermaidDiagram(token.lang,token.text);
          if(diagram.isDiagram){const src=options.mermaidImages?.get(diagram.renderCode);if(!src)throw new SyncError('长文图表缺少渲染图片','content','images');return image(src);}
          warnings.push('长文编辑器不支持原生代码块，保留的代码逐行转为文本');
          addText(token.text,token.text.replace(/\t/g,'    ').replace(/\n/g,''));return `<p>${escape(token.text).replace(/ /g,'&nbsp;').replace(/\t/g,'&nbsp;&nbsp;&nbsp;&nbsp;').replace(/\n/g,'<br>')}</p>`;
        }
        case 'table':{
          warnings.push('长文编辑器不支持原生表格，保留的表格按表头转为字段列表');
          return token.rows.map((row:any[])=>row.map((cell:any,i:number)=>{
            const text=`${stripInlineMarkdown(token.header[i].text)}：${stripInlineMarkdown(cell.text)}`;addText(text);return `<p>${escape(text)}</p>`;
          }).join('')).join('');
        }
        case 'hr':return '';
        case 'html':throw new SyncError('长文包含尚未适配的 HTML 结构，请转换为 Markdown 后重试','content','content');
        default:throw new SyncError(`长文包含尚未适配的结构：${token.type}`,'content','content');
      }
    }).join('');
  }
  const blocks:ArticleBlock[]=[];
  let section=0,sectionTitle='',seenParagraph=false;
  for(const token of marked.lexer(normalizeMarkdown(article.markdown))){
    if(token.type==='heading'){section++;sectionTitle=stripInlineMarkdown(token.text);seenParagraph=false;}
    const textStart=texts.length,countStart=countTexts.length,imageStart=images.length;
    const html=render([token]);if(!html)continue;
    const firstParagraph=['paragraph','blockquote'].includes(token.type)&&!seenParagraph;
    if(['paragraph','blockquote'].includes(token.type))seenParagraph=true;
    const tableTexts=token.type==='table'?[
      `表头：${token.header.map((cell:{text:string})=>stripInlineMarkdown(cell.text)).join('｜')}`,
      ...token.rows.map((row:Array<{text:string}>)=>row.map(cell=>stripInlineMarkdown(cell.text)).join('｜'))
    ]:undefined;
    blocks.push({type:token.type,html,texts:texts.slice(textStart),countText:countTexts.slice(countStart).join(''),hasImage:images.length!==imageStart,
      section,sectionTitle,firstParagraph,hasInlineCode:token.raw.includes('`'),
      lineCount:token.type==='code'?token.text.split('\n').length:undefined,
      procedure:token.type==='list'&&(token.ordered||token.items.some((item:{task?:boolean})=>item.task)||/步骤|操作|流程|执行|清单/.test(sectionTitle)),
      compactTable:tableTexts?{texts:tableTexts,countText:tableTexts.join(''),html:tableTexts.map(text=>`<p>${escape(text)}</p>`).join('')}:undefined});
  }
  if(!texts.join('').trim())throw new SyncError('小红书长文正文不能为空','content','validation');
  if(/\$[^$]+\$/.test(article.markdown))warnings.push('公式按 LaTeX 文本保留，请在平台草稿箱核对');
  if(options.appendSourceLink!==false&&article.sourceUrl)blocks.push({type:'notice',html:'<p>本文首发于掘金</p>',texts:['本文首发于掘金'],countText:'本文首发于掘金',hasImage:false,section,sectionTitle,firstParagraph:false,hasInlineCode:false});
  const fitted=fitXiaohongshuArticle(blocks,options.imageWeight??0,article.sourceUrl);
  return{title,html:fitted.blocks.map(block=>block.html).join(''),text:fitted.blocks.flatMap(block=>block.texts).join('\n'),images,warnings:[...new Set([...warnings,...fitted.warnings])]};
}

/** 按完整文章的章节抽取句子；结果供用户在平台草稿箱核对，不作为自动理解或 AI 改写。 */
export function buildXiaohongshuImageContent(article:Article,options:{syncCover?:boolean;appendSourceLink?:boolean;mermaidImages?:Map<string,string>}={}):XiaohongshuImageContent{
  const tokens=new Marked({gfm:true}).lexer(normalizeMarkdown(article.markdown));
  const sections:Array<{heading:string;text:string[]}>=[{heading:'核心内容',text:[]}];
  for(const token of tokens as any[]){
    if(token.type==='heading'){sections.push({heading:stripInlineMarkdown(token.text),text:[]});continue;}
    if(['paragraph','list','blockquote'].includes(token.type)){
      const text=markdownToXiaohongshuText(token.raw).text;
      if(text&&!/完整代码|代码如下|如下所示|见下文|下图|如图/.test(text))sections.at(-1)!.text.push(text);
    }
  }
  const nonempty=sections.filter(s=>s.text.length);
  // 均匀选取章节，确保长文尾部的限制、结论也有机会出现。
  const chosen=nonempty.length<=6?nonempty:Array.from({length:6},(_,i)=>nonempty[Math.round(i*(nonempty.length-1)/5)]);
  const takeSentence=(s:string,max:number)=>{
    const sentences=s.split('\n').flatMap(line=>line.match(/[^。！？]+[。！？]?/g)||[]).map(line=>line.trim());
    // 不选“有三件事：”“代码如下：”等引导句；精简后不能承诺已经省去的后续内容。
    return sentences.filter(t=>t&&!/[：:]$/.test(t)&&[...t].length<=max).slice(0,2).join('\n');
  };
  const cards:XiaohongshuCard[]=chosen.map(s=>({heading:s.heading,body:takeSentence(s.text.join('\n'),300)})).filter(card=>card.body);
  cards.unshift({heading:'文章主题',body:[article.title,stripInlineMarkdown(article.summary||'')].filter(Boolean).join('\n\n')});
  const segments:string[]=[];
  if(article.summary?.trim())segments.push(takeSentence(stripInlineMarkdown(article.summary),180));
  for(const card of cards.slice(1)){const text=takeSentence(card.body,110);if(text)segments.push(`${card.heading}\n${text}`);}
  let body=segments.filter(Boolean).join('\n\n');
  const tail=[formatXiaohongshuTopics(article.tags.slice(0,5)),options.appendSourceLink!==false?'本文首发于掘金':''].filter(Boolean).join('\n\n');
  // 整句选择；不生成省略号或缺失后文的半句。
  if(xhsImageLength(body)>850){body=segments.filter(Boolean).filter(s=>xhsImageLength(s)<300).slice(0,5).join('\n\n');}
  while(xhsImageLength(`${body}\n\n${tail}`)>1000&&body.includes('\n\n'))body=body.slice(0,body.lastIndexOf('\n\n'));
  const rawTitle=stripInlineMarkdown(article.title);
  const title=rawTitle.length<=20?rawTitle:(rawTitle.split(/[：:｜|，,。！？]/).find(s=>s.trim().length>0&&s.trim().length<=20)?.trim()||rawTitle);
  const sources=xhsImageCandidates(article,options.mermaidImages);
  return{title,body:[body,tail].filter(Boolean).join('\n\n'),cards,selectedImageKeys:sources.filter(s=>options.syncCover!==false||s!==article.cover).map(imageKey)};
}

export function validateXiaohongshuImageContent(content:XiaohongshuImageContent){
  if(!content||typeof content.title!=='string'||!content.title.trim()||content.title.length>20)throw new SyncError('精简图文标题需为 1～20 个字符，请调整原文标题或在偏好设置中选择其他格式','content','validation');
  if(typeof content.body!=='string'||!content.body.trim()||xhsImageLength(content.body)>1000)throw new SyncError('精简图文正文需为 1～1000 字，请调整原文标题或在偏好设置中选择其他格式','content','validation');
  if(!Array.isArray(content.cards)||!Array.isArray(content.selectedImageKeys)||!content.cards.length&&!content.selectedImageKeys.length)throw new SyncError('精简图文至少需要一张图卡或配图','content','validation');
  if(content.cards.length+content.selectedImageKeys.length>18)throw new SyncError('精简图文的图卡和配图合计不能超过18张，请减少原文配图或在偏好设置中选择仅长文','content','validation');
  for(const card of content.cards){if(typeof card.heading!=='string'||typeof card.body!=='string'||!card.body.trim()||card.heading.length>64||[...card.body].length>600)throw new SyncError('单张图卡标题不能超过64字符、正文不能超过600字，请编辑或拆分','content','validation');}
  if(content.selectedImageKeys.some(key=>typeof key!=='string'||key.length>4096))throw new SyncError('精简图文配图选择无效','content','validation');
}
