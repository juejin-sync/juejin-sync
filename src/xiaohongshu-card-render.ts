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
  const pages:Array<{heading:string;lines:string[];part:number}>=[];
  for(const card of cards){
    ctx.font='500 46px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
    const lines=wrapCardText(ctx,card.body,WIDTH-PADDING*2);
    for(let offset=0;offset<lines.length;offset+=18)pages.push({heading:card.heading,lines:lines.slice(offset,offset+18),part:offset/18+1});
  }
  if(pages.length>18)throw new Error('图卡分页后超过18张，请减少内容');
  return pages.map((page,index)=>{
    ctx.fillStyle='#f4f6fb';ctx.fillRect(0,0,WIDTH,HEIGHT);
    ctx.fillStyle='#2260d2';ctx.fillRect(PADDING,100,10,80);
    ctx.font='600 58px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';ctx.fillStyle='#142440';
    const headings=wrapCardText(ctx,page.heading,WIDTH-PADDING*2-40);
    // 超长标题也完整换行；预留更多高度时相应减少正文行，不能覆盖文字。
    if(headings.length>2)throw new Error('图卡标题过长，请缩短原文章节标题或选择仅长文');
    headings.forEach((line,i)=>ctx.fillText(line,PADDING+32,150+i*70));
    ctx.font='400 46px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';ctx.fillStyle='#25344d';
    page.lines.forEach((line,i)=>ctx.fillText(line,PADDING,330+i*57));
    ctx.fillStyle='#5a6880';ctx.font='400 28px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
    ctx.fillText(`${index+1} / ${pages.length}`,PADDING,HEIGHT-72);
    ctx.fillText('文章重点 · 本地生成',WIDTH-PADDING-280,HEIGHT-72);
    return canvas.toDataURL('image/png');
  });
}
