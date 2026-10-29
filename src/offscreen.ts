// 离屏渲染模块：为 Service Worker 提供 Chromium DOM 环境，将 Mermaid 渲染为高清 PNG 图片。
import mermaid from 'mermaid';
import {renderCards} from './xiaohongshu-card-render';

mermaid.initialize({
  startOnLoad: false,
  theme: 'default',
  securityLevel: 'strict',
  htmlLabels: false,
  flowchart: { htmlLabels: false },
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif'
});

/** 规范化 SVG 尺寸与命名空间，确保 Canvas 能够稳定光栅化 */
function prepareSvgForCanvas(svgStr: string): { svg: string; width: number; height: number } {
  // 不压平 HTML 标签或删除图像；无法保真光栅化时明确失败。
  if(/<foreignObject\b|<image\b|@import\b/i.test(svgStr))throw new Error('图表包含无法保真转换的 HTML 标签或外部图像');
  const sanitized = svgStr;
  const viewBoxMatch = sanitized.match(/viewBox=["']\s*([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s*["']/i);
  let width = viewBoxMatch ? parseFloat(viewBoxMatch[3]) : 800;
  let height = viewBoxMatch ? parseFloat(viewBoxMatch[4]) : 600;
  if (!width || isNaN(width) || width <= 0) width = 800;
  if (!height || isNaN(height) || height <= 0) height = 600;

  let prepared = sanitized;
  if (!/xmlns=["']http:\/\/www\.w3\.org\/2000\/svg["']/i.test(prepared)) {
    prepared = prepared.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  if (/<svg\b[^>]*\bwidth=["'][^"']*["']/i.test(prepared)) {
    prepared = prepared.replace(/(<svg\b[^>]*\bwidth=)(["'])[^"']*\2/i, (_match,prefix,quote)=>`${prefix}${quote}${width}${quote}`);
  } else {
    prepared = prepared.replace(/<svg\b/i, `<svg width="${width}"`);
  }
  if (/<svg\b[^>]*\bheight=["'][^"']*["']/i.test(prepared)) {
    prepared = prepared.replace(/(<svg\b[^>]*\bheight=)(["'])[^"']*\2/i, (_match,prefix,quote)=>`${prefix}${quote}${height}${quote}`);
  } else {
    prepared = prepared.replace(/<svg\b/i, `<svg height="${height}"`);
  }

  return { svg: prepared, width, height };
}

/** 将 SVG 转换为 2 倍高清抗锯齿 PNG DataURL，并填充白色底色保证微信客户端渲染纯净 */
async function svgToPngDataUrl(svgStr: string, scale = 2): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const { svg, width, height } = prepareSvgForCanvas(svgStr);
      const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(width * scale));
          canvas.height = Math.max(1, Math.round(height * scale));
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('Canvas 2D 绘图上下文不可用');
          // 白色底色，防止微信客户端深色模式或透明背景渲染发灰变黑
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/png'));
        } catch (err) {
          reject(err);
        }
      };
      img.onerror = () => {
        // 如果 DataURL 失败，尝试 Blob URL 作为后备
        try {
          const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
          const blobUrl = URL.createObjectURL(blob);
          const fallbackImg = new Image();
          fallbackImg.crossOrigin = 'anonymous';
          fallbackImg.onload = () => {
            try {
              const canvas = document.createElement('canvas');
              canvas.width = Math.max(1, Math.round(width * scale));
              canvas.height = Math.max(1, Math.round(height * scale));
              const ctx = canvas.getContext('2d');
              if (!ctx) throw new Error('Canvas 2D 绘图上下文不可用');
              ctx.fillStyle = '#ffffff';
              ctx.fillRect(0, 0, canvas.width, canvas.height);
              ctx.drawImage(fallbackImg, 0, 0, canvas.width, canvas.height);
              URL.revokeObjectURL(blobUrl);
              resolve(canvas.toDataURL('image/png'));
            } catch (err) {
              URL.revokeObjectURL(blobUrl);
              reject(err);
            }
          };
          fallbackImg.onerror = () => {
            URL.revokeObjectURL(blobUrl);
            reject(new Error('SVG 光栅化加载失败'));
          };
          fallbackImg.src = blobUrl;
        } catch (blobErr) {
          reject(blobErr);
        }
      };
      img.src = dataUrl;
    } catch (err) {
      reject(err);
    }
  });
}

let renderSeq = 0;
// 多篇文章共用离屏文档，串行使用容器，避免后一个请求清空前一个图表。
let renderQueue:Promise<unknown> = Promise.resolve();
async function renderMermaid(code: string): Promise<string> {
  const container = document.getElementById('container') || document.body;
  container.innerHTML = '';
  const id = `mermaid-render-${Date.now()}-${++renderSeq}`;
  try{
    const { svg } = await mermaid.render(id, code, container);
    return await svgToPngDataUrl(svg);
  }finally{
    container.innerHTML = '';
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target === 'offscreen' && message?.type === 'PING') {
    sendResponse({ ok: true });
    return;
  }
  if(message?.target==='offscreen'&&message?.type==='XHS_IMAGE_TO_PNG'){
    (async()=>{
      const bitmap=await createImageBitmap(await (await fetch(message.src)).blob());
      try{
        const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;
        const ctx=canvas.getContext('2d');if(!ctx)throw new Error('Canvas 不可用');
        ctx.drawImage(bitmap,0,0);sendResponse({ok:true,dataUrl:canvas.toDataURL('image/png')});
      }finally{bitmap.close();}
    })().catch(error=>sendResponse({ok:false,error:error.message}));
    return true;
  }
  if(message?.target==='offscreen'&&message?.type==='RENDER_XHS_CARDS'){
    const rendering=renderQueue.then(()=>renderCards(message.cards));
    renderQueue=rendering.catch(()=>{});
    rendering.then(images=>sendResponse({ok:true,images})).catch(error=>sendResponse({ok:false,error:error.message}));
    return true;
  }
  if (message?.target === 'offscreen' && message?.type === 'RENDER_MERMAID') {
    const rendering = renderQueue.then(() => renderMermaid(message.code));
    renderQueue = rendering.catch(() => {});
    rendering
      .then(dataUrl => sendResponse({ ok: true, dataUrl }))
      .catch(error => {
        console.warn('Mermaid 渲染失败：', error);
        sendResponse({ ok: false, error: (error as Error).message || String(error) });
      });
    return true; // 保持异步通信通道
  }
});
