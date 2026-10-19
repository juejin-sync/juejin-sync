// 扩展构建入口：后台和扩展页输出模块，注入网页的 Content Script 输出普通脚本。
import { build } from 'esbuild';
import fs from 'node:fs/promises';
const watch = process.argv.includes('--watch');
const release = process.argv.includes('--release');
await fs.rm('dist', { recursive: true, force: true });
await fs.mkdir('dist', { recursive: true });
await Promise.all(['manifest.json','rules.json','LICENSE','assets/logo.svg','assets/logo-16.png','assets/logo-32.png','assets/logo-48.png','assets/logo-128.png','assets/platform-csdn.png','assets/platform-wechat.png','assets/platform-cnblogs.svg','assets/platform-cnblogs.png','assets/platform-zhihu.svg','assets/platform-zhihu.png','src/popup.html','src/popup.css','src/juejin-content.css','src/offscreen.html'].map(async file => fs.copyFile(file, `dist/${file.split('/').pop()}`)));
const common={bundle:true,minify:release,target:'chrome120',outdir:'dist',sourcemap:!release};
// manifest.content_scripts 不支持 ESM；源文件为单元测试导出的函数也必须打包进普通脚本。
const builds=[
  {...common,entryPoints:{background:'src/background.ts',popup:'src/popup.ts',offscreen:'src/offscreen.ts'},format:'esm'},
  {...common,entryPoints:{'juejin-page':'src/juejin-page.ts','juejin-content':'src/juejin-content.ts','zhihu-bridge':'src/zhihu-bridge.ts'},format:'iife'}
];
if(watch){const {context}=await import('esbuild');await Promise.all(builds.map(async options=>{const ctx=await context(options);await ctx.watch();}));console.log('Watching…');}else{await Promise.all(builds.map(options=>build(options)));console.log('Built dist/');}
