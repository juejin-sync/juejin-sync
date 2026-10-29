// 小红书双格式内容契约：长文保留完整结构，精简图文使用可编辑的抽取内容与本地图卡。
import {Marked} from 'marked';
import {md5} from 'js-md5';
import type {Article,XiaohongshuCard,XiaohongshuImageContent,XiaohongshuPage} from '../types';
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
export type XiaohongshuMarkdownDoc={title:string;markdown:string;images:string[];warnings:string[]};

/** 生成内存 Markdown 文件，保留标准结构并处理图表；供原生文档导入使用。 */
export function compileXiaohongshuMarkdownDocument(article:Article,options:{mermaidImages?:Map<string,string>;appendSourceLink?:boolean}={}):XiaohongshuMarkdownDoc{
  const title=article.title.trim();
  if(!title||title.length>XHS_ARTICLE_TITLE_MAX)throw new SyncError('小红书长文标题需为 1～64 个字符，请调整原文标题或在偏好设置中选择其他格式','content','validation');
  const warnings:string[]=[];
  let markdown=normalizeMarkdown(article.markdown);

  if(options.mermaidImages&&options.mermaidImages.size>0){
    markdown=markdown.replace(/```mermaid\b[\s\S]*?```/g,match=>{
      const code=match.replace(/^```mermaid\s*\n?|\n?```$/g,'').trim();
      const imageSrc=options.mermaidImages?.get(code);
      if(imageSrc)return `![图表](${imageSrc})`;
      return match;
    });
  }

  const images:string[]=[];
  const imageMatches=markdown.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g);
  for(const m of imageMatches){
    const src=m[1].trim();
    if(src&&!images.includes(src))images.push(src);
  }

  if(options.appendSourceLink!==false&&article.sourceUrl){
    markdown+='\n\n---\n\n> 本文首发于掘金';
  }

  return{title,markdown,images,warnings};
}
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
const ACTION_VERBS=[
  '搭建','实现','构建','打造','开发','设计','编写','优化',
  '重构','解析','探索','玩转','搞定','实战','入门','指南',
  '上手','部署','配置','接入','集成','迁移','落地','实践'
];

export function extractXiaohongshuShortTitle(rawTitle:string):string{
  const stripped=stripInlineMarkdown(rawTitle).trim();
  if(stripped.length<=20)return stripped;

  // 1. 强标点拆分（冒号、竖线、破折号、双连字符等，不包含普通中英文内空格）
  const strongParts=stripped
    .split(/[：:｜|—]+|\s+[-–—]+\s+/)
    .map(s=>s.trim().replace(/^[【\[（(]+|[】\]）)]+$/g,'').trim())
    .filter(Boolean);
  if(strongParts.length>1){
    const candidates=strongParts.filter(s=>s.length>=4&&s.length<=20);
    if(candidates.length>0){
      return [...candidates].sort((a,b)=>b.length-a.length)[0];
    }
  }

  // 2. 弱标点拆分（逗号、句号、感叹号、问号、分号）
  const weakParts=stripped
    .split(/[，,。！？!?；;]+/)
    .map(s=>s.trim().replace(/^[【\[（(]+|[】\]）)]+$/g,'').trim())
    .filter(Boolean);
  if(weakParts.length>1){
    const candidates=weakParts.filter(s=>s.length>=4&&s.length<=20);
    if(candidates.length>0){
      return [...candidates].sort((a,b)=>b.length-a.length)[0];
    }
  }

  // 3. 中文句式分析：针对类似“用 Gitee Go 搭建WorkBuddy云端定时任务”的介词引导 + 动宾核心
  const introMatch=stripped.match(/^(?:用|基于|使用|通过|借助|利用|从)\s+/);
  if(introMatch){
    for(const verb of ACTION_VERBS){
      const verbIdx=stripped.indexOf(verb,introMatch[0].length);
      if(verbIdx!==-1){
        const actionClause=stripped.slice(verbIdx).trim();
        if(actionClause.length>=4&&actionClause.length<=20){
          return actionClause;
        }
      }
    }
    const withoutIntro=stripped.slice(introMatch[0].length).trim();
    if(withoutIntro.length>=4&&withoutIntro.length<=20){
      return withoutIntro;
    }
  }

  // 4. 无引导词但在中间包含核心技术动词的切分尝试
  for(const verb of ACTION_VERBS){
    const verbIdx=stripped.indexOf(verb);
    if(verbIdx>0){
      const actionClause=stripped.slice(verbIdx).trim();
      if(actionClause.length>=4&&actionClause.length<=20){
        return actionClause;
      }
    }
  }

  // 5. 无法安全提炼出完整短标题时保留原长标题，由 validateXiaohongshuImageContent 明确报错
  return stripped;
}

export function buildXiaohongshuImageContent(article:Article,options:{syncCover?:boolean;appendSourceLink?:boolean;syncOriginalImages?:boolean;mermaidImages?:Map<string,string>}={}):XiaohongshuImageContent{
  const tokens=new Marked({gfm:true}).lexer(normalizeMarkdown(article.markdown));
  type RawSection={heading:string;text:string[];images:string[];isSummary:boolean};
  const sections:RawSection[]=[{heading:'核心内容',text:[],images:[],isSummary:false}];
  for(const token of tokens as any[]){
    if(token.type==='heading'){
      const heading=stripInlineMarkdown(token.text);
      const isSummary=/总结|结论|限制|注意|思考|展望|写在最后|结语|边界|规则/.test(heading);
      sections.push({heading,text:[],images:[],isSummary});
      continue;
    }
    if(['paragraph','list','blockquote'].includes(token.type)){
      const converted=markdownToXiaohongshuText(token.raw,options.mermaidImages);
      if(converted.text&&!/完整代码|代码如下|如下所示|见下文|下图|如图|如图所示/.test(converted.text)){
        sections.at(-1)!.text.push(converted.text);
      }
      for(const img of converted.images){
        if(img&&img!==article.cover&&!sections.at(-1)!.images.includes(img)){
          sections.at(-1)!.images.push(img);
        }
      }
    }
  }
  const nonempty=sections.filter(s=>s.text.length);
  const summarySection=nonempty.find(s=>s.isSummary);
  const bodySections=nonempty.filter(s=>s!==summarySection);

  const takeSentence=(s:string,max:number)=>{
    const sentences=s.split('\n').flatMap(line=>line.match(/[^。！？]+[。！？]?/g)||[]).map(line=>line.trim());
    return sentences.filter(t=>t&&!/[：:]$/.test(t)&&[...t].length<=max).slice(0,2).join('\n');
  };

  const targetCount=Math.min(5,Math.max(3,bodySections.length));
  const chosen=bodySections.length<=targetCount
    ?bodySections
    :Array.from({length:targetCount},(_,i)=>bodySections[Math.round(i*(bodySections.length-1)/(targetCount-1))]);

  const coverBody=[article.title,stripInlineMarkdown(article.summary||'')].filter(Boolean).join('\n\n');
  const pages:XiaohongshuPage[]=[
    {type:'card',kind:'cover',heading:'文章主题',body:coverBody}
  ];

  let originalImagesCount=0;
  const maxOriginalImages=options.syncOriginalImages?2:0;
  const usedImages=new Set<string>();

  chosen.forEach((sec,idx)=>{
    const body=takeSentence(sec.text.join('\n'),300);
    if(!body)return;
    pages.push({type:'card',kind:'point',heading:sec.heading,body,sectionIndex:idx});
    if(originalImagesCount<maxOriginalImages&&sec.images.length>0){
      const candidate=sec.images.find(img=>!usedImages.has(img));
      if(candidate){
        usedImages.add(candidate);
        originalImagesCount++;
        pages.push({type:'image',src:candidate.startsWith('data:')?'':candidate,imageKey:imageKey(candidate),sectionIndex:idx,caption:`${sec.heading} 配图`});
      }
    }
  });

  if(summarySection){
    const summaryBody=takeSentence(summarySection.text.join('\n'),300);
    if(summaryBody){
      pages.push({type:'card',kind:'summary',heading:summarySection.heading,body:summaryBody});
    }
  }

  const cardPages=pages.filter(p=>p.type==='card');
  if(cardPages.length>8){
    const cover=pages.find(p=>p.type==='card'&&p.kind==='cover')!;
    const summary=pages.find(p=>p.type==='card'&&p.kind==='summary');
    const points=pages.filter(p=>p.type==='card'&&p.kind==='point').slice(0,summary?6:7);
    pages.length=0;
    pages.push(cover,...points,...(summary?[summary]:[]));
  }

  const pointCards=pages.filter(p=>p.type==='card'&&p.kind==='point') as Array<Extract<XiaohongshuPage,{type:'card'}>>;
  const segments:string[]=[];
  if(article.summary?.trim()){
    const summaryText=takeSentence(stripInlineMarkdown(article.summary),150);
    if(summaryText&&!/^[，,。、\s]/.test(summaryText))segments.push(summaryText);
  }
  segments.push(`围绕《${article.title}》，本次图卡整理了 ${pointCards.length} 个核心要点，快速浏览关键步骤与实践总结：`);
  for(const [idx,p] of pointCards.entries()){
    segments.push(`${idx+1}. ${p.heading}`);
  }
  segments.push('完整技术细节与代码实现请查看掘金原文。');
  let bodyText=segments.join('\n\n');
  const tail=[formatXiaohongshuTopics(article.tags.slice(0,5)),options.appendSourceLink!==false?'本文首发于掘金':''].filter(Boolean).join('\n\n');
  if(xhsImageLength(bodyText)>850){
    bodyText=segments.slice(0,4).join('\n\n');
  }
  while(xhsImageLength(`${bodyText}\n\n${tail}`)>1000&&bodyText.includes('\n\n'))bodyText=bodyText.slice(0,bodyText.lastIndexOf('\n\n'));

  const title=extractXiaohongshuShortTitle(article.title);

  const cards:XiaohongshuCard[]=pages.filter((p):p is Extract<XiaohongshuPage,{type:'card'}>=>p.type==='card').map(p=>({heading:p.heading,body:p.body,kind:p.kind,sectionIndex:p.sectionIndex}));
  const selectedImageKeys=pages.filter((p):p is Extract<XiaohongshuPage,{type:'image'}>=>p.type==='image').map(p=>p.imageKey);

  return{
    version:2,
    title,
    body:[bodyText,tail].filter(Boolean).join('\n\n'),
    pages,
    originalImagesCount,
    cards,
    selectedImageKeys
  };
}

export function validateXiaohongshuImageContent(content:XiaohongshuImageContent){
  if(!content||typeof content.title!=='string'||content.title.trim().length<2||content.title.length>20)throw new SyncError('精简图文标题需在 2～20 个字符以内，请调整原文标题或在偏好设置中选择其他格式','content','validation');
  if(typeof content.body!=='string'||!content.body.trim()||xhsImageLength(content.body)>1000)throw new SyncError('精简图文正文需为 1～1000 字，请调整原文标题或在偏好设置中选择其他格式','content','validation');
  const cards=Array.isArray(content.cards)?content.cards:(Array.isArray(content.pages)?content.pages.filter(p=>p.type==='card'):[]);
  const images=Array.isArray(content.selectedImageKeys)?content.selectedImageKeys:(Array.isArray(content.pages)?content.pages.filter(p=>p.type==='image'):[]);
  if(!cards.length&&!images.length)throw new SyncError('精简图文至少需要一张图卡或配图','content','validation');
  if(cards.length+images.length>18)throw new SyncError('精简图文的图卡和配图合计不能超过18张，请减少原文配图或在偏好设置中选择仅长文','content','validation');
  for(const card of cards as XiaohongshuCard[]){if(typeof card.heading!=='string'||typeof card.body!=='string'||!card.body.trim()||card.heading.length>64||[...card.body].length>600)throw new SyncError('单张图卡标题不能超过64字符、正文不能超过600字，请编辑或拆分','content','validation');}
  if(content.selectedImageKeys?.some(key=>typeof key!=='string'||key.length>4096))throw new SyncError('精简图文配图选择无效','content','validation');
}
