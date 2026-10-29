// 离屏 Canvas 图卡排版：移动端可读字号、按实际测量分页，禁止裁掉溢出文字。
import type {XiaohongshuCard} from './types';
const WIDTH=1080,HEIGHT=1440,PADDING=88;
export function wrapCardText(context:Pick<CanvasRenderingContext2D,'measureText'>,text:string,width:number){
  const lines:string[]=[];
  for(const paragraph of text.split('\n')){
    let line='';
    for(const char of paragraph){
      if(line&&context.measureText(line+char).width>width){lines.push(line);line=char;}else line+=char;
    }
    lines.push(line);
  }
  return lines;
}
export async function renderCards(cards:XiaohongshuCard[]):Promise<string[]>{
  await document.fonts.ready;
  const canvas=document.createElement('canvas');canvas.width=WIDTH;canvas.height=HEIGHT;
  const ctx=canvas.getContext('2d');if(!ctx)throw new Error('Canvas 不可用');
  const pages:Array<{heading:string;lines:string[];kind?:'cover'|'point'|'summary';part:number}>=[];
  for(const card of cards){
    ctx.font='500 48px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
    const lines=wrapCardText(ctx,card.body,WIDTH-PADDING*2);
    const maxLines=card.kind==='cover'?14:16;
    for(let offset=0;offset<lines.length;offset+=maxLines){
      pages.push({heading:card.heading,lines:lines.slice(offset,offset+maxLines),kind:card.kind,part:offset/maxLines+1});
    }
  }
  if(pages.length>18)throw new Error('图卡分页后超过18张，请减少内容');
  return pages.map((page,index)=>{
    ctx.fillStyle='#f4f6fb';ctx.fillRect(0,0,WIDTH,HEIGHT);
    const isCover=page.kind==='cover';
    const isSummary=page.kind==='summary';
    const accentColor=isSummary?'#e05638':'#2260d2';

    ctx.fillStyle=accentColor;ctx.fillRect(PADDING,100,10,80);
    ctx.font='600 58px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';ctx.fillStyle='#142440';
    const headings=wrapCardText(ctx,page.heading,WIDTH-PADDING*2-40);
    // 超长标题也完整换行；预留更多高度时相应减少正文行，不能覆盖文字。
    if(headings.length>2)throw new Error('图卡标题过长，请缩短原文章节标题或选择仅长文');
    headings.forEach((line,i)=>ctx.fillText(line,PADDING+32,150+i*70));

    ctx.font='400 48px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';ctx.fillStyle='#25344d';
    const startY=330;
    page.lines.forEach((line,i)=>ctx.fillText(line,PADDING,startY+i*62));

    ctx.fillStyle='#5a6880';ctx.font='400 28px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
    ctx.fillText(`${index+1} / ${pages.length}`,PADDING,HEIGHT-72);
    const badgeText=isCover?'主题导读 · 本地生成':isSummary?'总结限制 · 本地生成':'核心要点 · 本地生成';
    ctx.fillText(badgeText,WIDTH-PADDING-280,HEIGHT-72);
    return canvas.toDataURL('image/png');
  });
}
