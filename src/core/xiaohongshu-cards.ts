// 将用户确认的图卡配方交给现有离屏文档渲染，图片只在当前请求中存活。
import type {XiaohongshuCard} from '../types';
import {ensureOffscreenDocument} from './mermaid-render';
export async function renderXiaohongshuCards(cards:XiaohongshuCard[]):Promise<string[]>{
  if(!cards.length)return [];
  if(!await ensureOffscreenDocument())throw new Error('图卡渲染环境未就绪，请重新加载扩展后重试');
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('本地图卡生成超时')),30000);
    chrome.runtime.sendMessage({target:'offscreen',type:'RENDER_XHS_CARDS',cards},response=>{
      clearTimeout(timer);
      if(chrome.runtime.lastError||!response?.ok||!Array.isArray(response.images))reject(new Error(response?.error||'本地图卡生成失败'));
      else resolve(response.images);
    });
  });
}
