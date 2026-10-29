// 超长长文的确定性取舍：保留原文完整块，不生成新事实，不把规则抽取描述为 AI。
import {SyncError} from '../core/diagnostic';
import {XHS_ARTICLE_BODY_MAX,xhsWordCount} from './xiaohongshu-budget';

export type ArticleBlock={
  type:string;html:string;texts:string[];countText:string;hasImage:boolean;
  section:number;sectionTitle:string;firstParagraph:boolean;hasInlineCode:boolean;
  lineCount?:number;procedure?:boolean;compactTable?:Pick<ArticleBlock,'html'|'texts'|'countText'>;
};
const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const paragraph=(text:string,source:ArticleBlock):ArticleBlock=>({...source,type:'notice',html:`<p>${escape(text)}</p>`,texts:[text],countText:text,hasImage:false});
const protectedSection=/合规|边界|限制|注意|风险|结论|收尾|最后|清单/;
const protectedText=/必须|不能|不要|禁止|不得|不可|务必|仅限|只能|只对|前提|警告|风险|结论|关键|原则|应当|应该|不支持|不等于|不重试|失败时|降级|\b(?:must|never|required|warning|caution|limitation|do not|should not)\b/i;
const technicalTable=/参数|配置|凭据|接口契约|错误码|环境变量/;
const parameterText=/参数|配置|设为|设置为|超时|间隔|端口|版本|额度|寿命|有效期|返回|响应|字段|请求头|认证|定时|触发|环境变量|凭据|\b(?:timeout|port|version|interval|limit|header|token|cron)\b/i;
const isRequired=(block:ArticleBlock)=>!['paragraph','blockquote','list'].includes(block.type)||block.procedure||block.hasImage||
  protectedSection.test(block.sectionTitle)||protectedText.test(block.texts.join('\n'))||
  (parameterText.test(block.countText)&&(block.hasInlineCode||/\d/.test(block.countText)));

/** 只在总预算超限时执行；所有章节、图片和必要块均不能为了通过校验而硬删。 */
export function fitXiaohongshuArticle(blocks:ArticleBlock[],imageWeight:number,sourceUrl?:string){
  if(!Number.isFinite(imageWeight)||imageWeight<0)throw new SyncError('长文图片预算无效','content','validation');
  const count=(items:ArticleBlock[])=>xhsWordCount(items.map(item=>item.countText).join(''));
  const originalCount=count(blocks);
  if(originalCount+imageWeight<=XHS_ARTICLE_BODY_MAX)return{blocks,warnings:[]};
  const fail=(minimum:number)=>new SyncError(`小红书长文总计 ${originalCount+imageWeight} 字，超过 ${XHS_ARTICLE_BODY_MAX} 字上限 ${originalCount+imageWeight-XHS_ARTICLE_BODY_MAX} 字（正文 ${originalCount} 字，配图占用 ${imageWeight} 字）；规则保留的必要内容仍需 ${minimum+imageWeight} 字，请人工精简原文或在偏好设置中选择仅精简图文；不会截断段落或硬删必要内容`,'content','validation');
  // 原文入口必须可供读者访问；不把作者的私有编辑链接伪装成公开原文。
  let link='';
  try{const url=new URL(sourceUrl||'');if(url.origin==='https://juejin.cn'&&/^\/post\/\d+\/?$/.test(url.pathname))link=url.origin+url.pathname;}catch{}
  if(!link)throw new SyncError('超长长文规则精简需要已发布的掘金原文链接，请在原文发布后重新同步，或选择仅精简图文','content','validation');
  let duplicates=0,codes=0,tables=0,paragraphs=0;
  const seen=new Set<string>();
  let selected=blocks.filter(block=>{
    const key=JSON.stringify([block.section,block.type,block.texts]);
    const duplicate=block.type==='paragraph'&&!block.hasImage&&!block.firstParagraph&&seen.has(key);
    seen.add(key);if(duplicate)duplicates++;return!duplicate;
  });
  const notice=paragraph(`本文为本地规则精简版，部分说明、长代码或大表格已省略；完整内容见原文：${link}`,blocks[0]);
  selected.unshift(notice);
  // 表头只展示一次，行内按表头顺序保留全部单元格，先减少重复字段名而不丢表格数据。
  if(count(selected)+imageWeight>XHS_ARTICLE_BODY_MAX)selected=selected.map(block=>block.compactTable?{...block,...block.compactTable}:block);
  const large=selected.filter(block=>!block.hasImage&&(
    block.type==='code'&&(xhsWordCount(block.countText)>150||(block.lineCount||0)>=8)||
    block.type==='table'&&xhsWordCount(block.countText)>300&&!technicalTable.test(block.sectionTitle)&&!protectedSection.test(block.sectionTitle)&&!protectedText.test(block.countText)
  )).sort((a,b)=>Number(a.type==='table')-Number(b.type==='table')||xhsWordCount(b.countText)-xhsWordCount(a.countText));
  for(const block of large){
    if(count(selected)+imageWeight<=XHS_ARTICLE_BODY_MAX)break;
    const isCode=block.type==='code';if(isCode)codes++;else tables++;
    selected=selected.map(item=>item===block?paragraph(isCode?'【长代码已整块省略，完整代码见原文】':'【大表格已整块省略，完整表格见原文】',block):item);
  }
  const lastParagraph=[...selected].reverse().find(block=>block.type==='paragraph');
  // 每节至少保留一个实质内容块；已有步骤或必要参数时，首段引导语按高优先级保留而非硬占预算。
  const anchors=new Set<ArticleBlock>();
  for(const section of new Set(selected.map(block=>block.section))){
    const body=selected.filter(block=>block.section===section&&!['heading','notice'].includes(block.type)&&block.countText.trim());
    if(body.length&&!body.some(isRequired))anchors.add(body.find(block=>block.firstParagraph)||body[0]);
  }
  // 优先省略举例和背景说明；同分时先省略较长块，避免从文章尾部机械截断。
  const candidates=selected.filter(block=>!isRequired(block)&&!anchors.has(block)&&block!==lastParagraph).sort((a,b)=>{
    const rank=(block:ArticleBlock)=>block.firstParagraph?3:block.hasInlineCode||/\d/.test(block.countText)?2:/例如|比如|举个|顺便|最开始|一度|当时|看起来/.test(block.texts.join(''))?0:1;
    return rank(a)-rank(b)||xhsWordCount(b.countText)-xhsWordCount(a.countText);
  });
  for(const block of candidates){
    if(count(selected)+imageWeight<=XHS_ARTICLE_BODY_MAX)break;
    selected=selected.filter(item=>item!==block);paragraphs++;
  }
  const finalCount=count(selected);
  if(finalCount+imageWeight>XHS_ARTICLE_BODY_MAX)throw fail(finalCount);
  return{blocks:selected,warnings:[`已按本地规则精简：正文 ${originalCount} → ${finalCount} 字，配图占用 ${imageWeight} 字；去重 ${duplicates} 段，省略 ${paragraphs} 段说明、${codes} 个长代码块、${tables} 个大表格。规则不能保证原意完整，请在草稿箱核对；完整内容见掘金原文。`]};
}
