// 同步设置纯逻辑：规范化旧版设置、分类映射和设置页文本格式。
import type {CategoryMapping,ExtensionSettings} from '../types';

export const defaultSettings:ExtensionSettings={
  xiaohongshuMode:'both',
  defaultCsdnCategory:'',
  categoryMappings:[],
  syncCover:true,
  autoSummary:true,
  appendSourceLink:true,
  imageFailurePolicy:'continue',
  confirmDraftUpdate:false,
  wechatCodeTheme:'onedark'
};

function clean(value:unknown){return typeof value==='string'?value.trim():'';}

export function normalizeSettings(value:unknown):ExtensionSettings{
  const input=value&&typeof value==='object'?value as Partial<ExtensionSettings>:{};
  const mappings=Array.isArray(input.categoryMappings)?input.categoryMappings.map(item=>({sourceTag:clean(item?.sourceTag),targetCategory:clean(item?.targetCategory)})).filter(item=>item.sourceTag&&item.targetCategory):[];
  const themeCandidate=input.wechatCodeTheme;
  const wechatCodeTheme=themeCandidate==='github-light'||themeCandidate==='monokai'?themeCandidate:'onedark';
  return{
    xiaohongshuMode:input.xiaohongshuMode==='article'||input.xiaohongshuMode==='image'?input.xiaohongshuMode:'both',
    defaultCsdnCategory:clean(input.defaultCsdnCategory),
    categoryMappings:mappings,
    syncCover:input.syncCover!==false,
    autoSummary:input.autoSummary!==false,
    appendSourceLink:input.appendSourceLink!==false,
    imageFailurePolicy:input.imageFailurePolicy==='abort'?'abort':'continue',
    confirmDraftUpdate:input.confirmDraftUpdate===true,
    wechatCodeTheme
  };
}

export function resolveCsdnCategories(tags:string[],settings:ExtensionSettings){
  const normalizedTags=new Set(tags.map(tag=>tag.trim().toLocaleLowerCase()).filter(Boolean));
  const categories=settings.categoryMappings
    .filter(mapping=>normalizedTags.has(mapping.sourceTag.trim().toLocaleLowerCase()))
    .map(mapping=>mapping.targetCategory.trim())
    .filter(Boolean);
  if(!categories.length&&settings.defaultCsdnCategory.trim())categories.push(settings.defaultCsdnCategory.trim());
  return[...new Set(categories)];
}

export function parseCategoryMappings(value:string):CategoryMapping[]{
  return value.split(/\r?\n/).map(line=>{
    const separator=line.indexOf('=');
    return separator<0?undefined:{sourceTag:line.slice(0,separator).trim(),targetCategory:line.slice(separator+1).trim()};
  }).filter((item):item is CategoryMapping=>!!item?.sourceTag&&!!item.targetCategory);
}

export function formatCategoryMappings(mappings:CategoryMapping[]){return mappings.map(item=>`${item.sourceTag} = ${item.targetCategory}`).join('\n');}

export function shouldConfirmDraftUpdate(settings:ExtensionSettings,articleId?:string){return settings.confirmDraftUpdate&&!!articleId;}
