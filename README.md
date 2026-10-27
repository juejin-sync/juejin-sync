<div align="center">
  <img src="assets/logo-128.png" width="96" height="96" alt="掘金同步助手 Logo">
  <h1>掘金同步助手 · Juejin Sync</h1>
  <p><b>将掘金文章一键同步到 CSDN、微信公众号、博客园与知乎专栏草稿箱。</b></p>
  <p>
    <a href="https://github.com/juejin-sync/juejin-sync/releases/latest">📥 下载安装包</a> ·
    <a href="CHANGELOG.md">📜 更新日志</a> ·
    <a href="https://github.com/juejin-sync/juejin-sync/issues">💬 反馈与建议</a>
  </p>
</div>

[![Release](https://img.shields.io/github/v/release/juejin-sync/juejin-sync)](https://github.com/juejin-sync/juejin-sync/releases)
[![CI](https://github.com/juejin-sync/juejin-sync/actions/workflows/ci.yml/badge.svg)](https://github.com/juejin-sync/juejin-sync/actions/workflows/ci.yml)
[![Tests](https://img.shields.io/badge/tests-281%20passed-brightgreen)](tests)
[![License](https://img.shields.io/github/license/juejin-sync/juejin-sync)](LICENSE)

掘金同步助手是一款 Chrome Manifest V3 浏览器扩展。它读取你主动选择的掘金文章或编辑器草稿，在浏览器本地处理排版与图片后同步到目标平台的草稿箱。**纯本地运行，不依赖任何第三方中转服务器，零凭据托管。**

> ⚠️ **只同步草稿，不自动公开发布。** 同步完成后，请前往目标平台检查排版与内容，再自行确认发布。

---

## 🌟 支持平台

| 平台 | 同步类型 | 支持状态 |
| :--- | :--- | :---: |
| <img src="assets/platform-csdn.png" width="18" height="18" valign="middle" alt="CSDN"> **CSDN** | 草稿箱（Markdown 适配与图片转存） | ✅ 已支持 |
| <img src="assets/platform-wechat.png" width="18" height="18" valign="middle" alt="微信公众号"> **微信公众号** | 草稿箱（原生图文排版、代码高亮与封面裁剪） | ✅ 已支持 |
| <img src="assets/platform-cnblogs.png" width="18" height="18" valign="middle" alt="博客园"> **博客园** | 随笔草稿箱（Markdown 适配与图片转存） | ✅ 已支持 |
| <img src="assets/platform-zhihu.png" width="18" height="18" valign="middle" alt="知乎专栏"> **知乎专栏** | 专栏草稿箱（富文本排版与公式高保真） | ✅ 已支持 |

---

## ✨ 核心特性

- 🛡️ **纯本地安全**：完全在浏览器本地运行，直接与目标平台官方接口通信，不申请 `cookies` 敏感权限，零凭据泄露风险。
- 📝 **高保真排版**：自动转存正文图片与封面，智能适配微信公众号原生样式与知乎专栏富文本，支持代码块高亮与 Mermaid 图表。
- 📦 **单篇与批量分发**：支持掘金新文章发布时自动触发同步，也支持在创作者中心对历史文章批量一键分发。
- 🔒 **线上内容保护**：严格的账号隔离与草稿状态检测，遇到目标文章已发布会自动阻断或另存新草稿，避免覆盖线上已有内容。

---

## 🚀 安装与使用

### 📦 安装步骤（推荐）

1. 前往 [Releases 页面](https://github.com/juejin-sync/juejin-sync/releases/latest) 下载最新版 `juejin-sync-v*.zip` 并解压；
2. 打开 Chrome 浏览器，访问 `chrome://extensions/`，开启右上角的 **“开发者模式”**；
3. 点击 **“加载已解压的扩展程序”**，选择解压出的目录；
4. 在浏览器中登录掘金和需要同步的目标平台账号，刷新已打开的掘金页面即可。

> 💡 **升级方法**：下载新版本压缩包解压并覆盖原文件夹，在扩展管理页面点击“重新加载 🔄”即可。

### 🎯 如何同步

- **新文章同步**：在掘金写文章点击“发布”时，在弹出的面板中勾选需要同步的目标平台，点击“确定并发布”后即可自动同步至各平台草稿箱。
- **历史文章同步**：在掘金“创作者中心 ➔ 文章管理”或个人主页文章列表，点击“多平台同步”或使用批量向导，一键分发选中的文章。
- **查看与管理进度**：点击浏览器右上角扩展图标，可查看所有任务的同步状态、耗时、排版警告与草稿箱直达链接。

---

## 💻 本地开发

```bash
git clone https://github.com/juejin-sync/juejin-sync.git
cd juejin-sync
npm ci
npm run check    # TypeScript 类型检查
npm test         # 自动化测试（281 项全覆盖）
npm run build    # 本地开发构建
```

构建产物位于 `dist/` 目录，在 Chrome 扩展管理页直接加载该目录即可调试。

---

## 💬 反馈与贡献

欢迎通过 [GitHub Issues](https://github.com/juejin-sync/juejin-sync/issues) 提交 Bug 反馈或新功能建议。

本项目采用 [MIT License](LICENSE) 开源协议。
