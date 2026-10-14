# 发布浏览器版与手机访问排查

GitHub Pages 已于 2026-10-13 成功发布：[在线入口](https://lyhrmer.github.io/media-scribe/)。初次发布的 [Actions run 38425576379](https://github.com/LYHrmer/media-scribe/actions/runs/38425576379) 完成源码测试、构建和部署；独立 HTTP GET 返回 200 和正确页面 HTML。此证据不等于华为/鸿蒙真机已通过。后续源码提交自动重新构建，具体版本以 Actions 与部署环境为准。

## GitHub Pages：仓库所有者首次设置

1. 将完整源码（包括 `.github/workflows/pages.yml`、`package-lock.json`、`src/`、`scripts/` 和 `public/`）提交到仓库 `main` 分支。无需提交 `node_modules/`、`dist/`、模型缓存或生成的模型分片。
2. 打开仓库 **Settings → Pages → Build and deployment → Source**，选择 **GitHub Actions**。这是仓库所有者的首次配置；流程不会申请额外令牌来自动开启 Pages。
3. 打开 **Actions → Deploy browser transcription to GitHub Pages → Run workflow**，选择 `main`，或向 `main` 推送一次提交。
4. 等待 `build` 和 `deploy` 均成功，再使用部署环境或 Pages 设置中显示的实际网址。

`LYHrmer/media-scribe` 的已验证部署地址为 `https://lyhrmer.github.io/media-scribe/`。若仓库名为 `owner.github.io`，默认发布在域名根目录。

流程使用官方 `checkout@v6`、`setup-node@v6`、`configure-pages@v5`、`upload-pages-artifact@v4` 和 `deploy-pages@v4`。安装命令为 `npm ci --onnxruntime-node-install-cuda=skip`，随后运行 `npm test` 和 `npm run build`。构建路径从 Pages 的 `base_path` 输出生成：项目仓库使用 `/仓库名/`，用户站点和配置好的自定义域名使用 `/`，避免脚本、worker、模型和 WebAssembly 指向错误位置。

构建任务只授予 `contents: read` 和 `pages: read`；部署任务只授予 `pages: write` 和 `id-token: write`，依赖构建成功，并且只部署 `main`。不需要用户配置 API Key 或个人访问令牌。

## 模型、下载与发布后的检查

构建脚本从公开模型源下载语音、画面、标点及人声检测所需模型，再生成完整静态站点。加入视觉后的完整构建大于 256 MiB，受限托管的精简构建约 241 MiB（最终以构建输出为准），模型分片不超过 16 MiB；浏览器首次使用时从当前部署站点下载所选模型与运行库，并优先复用缓存。用户的音视频保留在本地浏览器处理，不会通过该流程上传到 GitHub、模型网站或服务器。

发布后应检查：手机能打开首页；脚本、worker、WebAssembly、模型清单和模型分片均位于正确的发布路径；选取一个本地音视频能进入队列；首次模型下载完成后能转写并导出文本。仅 Actions 显示绿色不代表真实手机上的这些检查已通过，也不代表转写准确率已达标。

GitHub Pages 当前发布体积上限为 1 GB，每月软带宽上限为 100 GB。完整构建符合该体积限制；模型首次下载仍会使用带宽，访问增长后需要重新评估托管容量。v0.5.0 精简构建保留 SenseVoice 与 Tiny，完整构建还提供 Small；两种构建均保留视觉、标点和人声检测功能。SenseVoice 分片为无损 gzip 二进制，扩展名 `.gz.bin`，禁止把其存储压缩误当成 HTTP Content-Encoding。

## 两种手机问题分别处理

“暂无可用打开方式”来自手机文件选择器或内嵌浏览器。使用页面的兼容选择入口；如果手机内嵌浏览器仍没有可用的系统选择器，在手机的完整浏览器中打开网址再选文件。网页不能安装或修复系统文件选择器。

“Sorry, you have been blocked”来自托管平台的安全拦截，发生在应用页面加载前。修改 HTML、CSS、重新打包或把站点设置为公开，均不能直接解除这类边缘拦截。截图中的 VPN 标志不能证明 VPN 就是原因，也不能据此确定具体规则或错误码。

平台运营方需要结合完整拦截页底部的 Cloudflare Ray ID、发生时间和网址查询 Security Events，判断是否误拦截并调整对应规则。当前 Sites 工具没有该安全规则权限。GitHub Pages 已提供独立发布入口，不能保证某个网络、地区或手机浏览器始终可访问；绑定自定义域名也不能保证消除原平台的拦截。

GitHub 返回 `Resource not accessible by integration` 时，应检查连接的 GitHub App 对该仓库的有效权限。仓库元数据里的 `admin/push` 表示账号权限，不能证明集成令牌具有写入源码或设置 Pages 的权限。本项目首次发布是在用户已授权的 GitHub 浏览器会话中完成源码提交和 Pages 设置；若再次遇到集成写权限问题，不应把只读 API 成功误作写权限已经恢复。

## 官方参考

- [GitHub Pages 自定义工作流](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
- [GitHub Pages 限制](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)
- [configure-pages 输入与路径输出](https://github.com/actions/configure-pages/blob/v5/action.yml)
- [GitHub REST API 权限错误排查](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api#resource-not-accessible)
- [Cloudflare Ray ID 与安全事件查询](https://developers.cloudflare.com/fundamentals/reference/cloudflare-ray-id/)
