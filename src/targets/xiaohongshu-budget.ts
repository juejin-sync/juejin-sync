// 小红书长文预算：文本与图片均按已核对的平台 wordCount 扩展计算。
export const XHS_ARTICLE_BODY_MAX=10000;
export function xhsWordCount(text:string){
  const count=(pattern:RegExp)=>(text.match(pattern)||[]).length;
  return Math.ceil(count(/[\u4e00-\u9fa5\s]/g)+(count(/[a-zA-Z0-9]/g)+count(/[^\u4e00-\u9fa5\w\s]/g))*0.5);
}
export function xhsArticleImageWeight(width:number,height:number){
  if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0)throw new Error('长文图片尺寸无效');
  const scaledHeight=height/width*740;
  return scaledHeight>=1340?400:20*Math.ceil(scaledHeight/64);
}
