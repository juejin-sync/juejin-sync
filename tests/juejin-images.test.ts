// 私有图片地址刷新回归：资源身份、快照保留和代码示例隔离。
import {describe,expect,it} from 'vitest';
import {privateJuejinImages,refreshJuejinImageUrls} from '../src/source/juejin-images';
import type {Article} from '../src/types';

const path='/tos-cn-i-73owjymdk6/image-a~tplv-watermark.awebp';
const oldUrl=`https://p0-xtjj-private.juejin.cn${path}?x-orig-sign=old&policy=old`;
const freshUrl=`https://p6-xtjj-sign.byteimg.com${path}?x-signature=new&x-expires=1792982703`;
const article:Article={id:'published',sourceDraftId:'draft',sourceUrl:'https://juejin.cn/post/published',title:'发布时的标题',markdown:`发布时的正文。\n![图片](${oldUrl})`,cover:oldUrl,summary:'',tags:['原标签']};
const fresh:Article={...article,title:'后来改的标题',markdown:`后来改的正文。\n![图片](${freshUrl})`,cover:'https://example.com/other.png',summary:'后来改的摘要',tags:['新标签']};

describe('刷新掘金图片地址',()=>{
  it('仅刷新匹配的正文图与封面链接，保留提交快照及新链接签名',()=>{
    expect(refreshJuejinImageUrls(article,fresh)).toEqual({...article,markdown:article.markdown.replace(oldUrl,freshUrl),cover:freshUrl});
  });
  it.each(['',undefined])('保留明确清空或未知的封面 %s',cover=>{
    expect(refreshJuejinImageUrls({...article,cover},fresh).cover).toBe(cover);
  });
  it('没有同路径图片时保留原链接，不按顺序匹配、不猜测 CDN 域名',()=>{
    const other={...fresh,markdown:`![其他图](${freshUrl.replace('image-a','image-b')})`};
    expect(refreshJuejinImageUrls(article,other)).toBe(article);
  });
  it('忽略同路径外部域名、HTTP 链接和不同裁剪模板',()=>{
    for(const url of [freshUrl.replace('p6-xtjj-sign.byteimg.com','example.com'),freshUrl.replace('https:','http:'),freshUrl.replace('tplv-watermark','tplv-crop')]){
      expect(refreshJuejinImageUrls(article,{...fresh,markdown:`![图片](${url})`})).toBe(article);
    }
  });
  it('刷新 HTML 图片时解码实体，并保留代码示例和普通文字中的 URL',()=>{
    const escaped=oldUrl.replace(/&/g,'&amp;');
    const suffix=`\n\n普通链接 ${oldUrl}\n\n\`![代码](${oldUrl})\`\n\n\`\`\`md\n![代码](${oldUrl})\n\`\`\``;
    const input={...article,markdown:`<img src="${escaped}">${suffix}`};
    expect(refreshJuejinImageUrls(input,fresh).markdown).toBe(`<img src="${freshUrl}">${suffix}`);
  });
  it('只识别实际使用的掘金私有图片，代码示例不触发刷新',()=>{
    expect(privateJuejinImages({...article,cover:'',markdown:`\`![代码](${oldUrl})\`\n![普通图](https://example.com/a.png?policy=x)`})).toEqual([]);
  });
});
