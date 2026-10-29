// 小红书偏好只在创建任务时展开为具体格式，执行与重试保持任务快照。
import type {XiaohongshuMode,XiaohongshuFormat} from '../types';
export const xhsFormats=(mode:XiaohongshuMode):XiaohongshuFormat[]=>mode==='both'?['article','image']:[mode];
export const xhsFormatLabel=(format:XiaohongshuFormat)=>format==='article'?'长文':'精简图文';
