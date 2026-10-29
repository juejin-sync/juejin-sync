// 长文粘贴仅接受 PNG/JPEG，复用离屏 Canvas 将 WebP 转为 PNG；不经第三方服务。
import {ensureOffscreenDocument} from './mermaid-render';
export async function normalizeXiaohongshuArticleImage(blob:Blob):Promise<Blob>{
  if(blob.type!=='image/webp')return blob;
  if(!await ensureOffscreenDocument())throw new Error('图片转换环境未就绪');
  const bytes=new Uint8Array(await blob.arrayBuffer());let binary='';
  for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));
  const dataUrl=await new Promise<string>((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('长文配图转换超时')),15000);
    chrome.runtime.sendMessage({target:'offscreen',type:'XHS_IMAGE_TO_PNG',src:`data:${blob.type};base64,${btoa(binary)}`},response=>{
      clearTimeout(timer);
      if(chrome.runtime.lastError||!response?.ok)reject(new Error(response?.error||'长文配图转换失败'));else resolve(response.dataUrl);
    });
  });
  return (await fetch(dataUrl)).blob();
}
