# v0.5.6：粘贴音视频链接

界面新增链接输入、读取进度和取消按钮。直接从用户填写的 HTTPS 文件地址读取媒体，在内存中形成 File 后进入原有本地识别队列；不弹出保存文件窗口，不安装新的模型或添加服务器。仍需通过网络获取媒体数据，不能在不读取视频内容的情况下转写。

## 支持边界

- 支持允许跨站读取的公开音视频文件直链，含带签名参数的临时链接；签名参数按原值发送给该文件来源，文件名、导出结果和应用缓存不记录参数。
- 普通平台分享页面、登录页面、HTML / JSON 响应、M3U8 / DASH 播放列表均给出具体提示，不将网页误报成音频解码错误。
- 浏览器直接 GET，使用 CORS、`credentials: omit`、`referrerPolicy: no-referrer` 和 `cache: no-store`。不使用第三方解析代理，不自动携带站点登录凭据。
- 读取前检查声明体积，读取中累加实际体积；超过 300 MB 停止。来源连续 45 秒没有响应会超时。时长沿用现有解码后的 30 分钟限制。
- 取消立即释放界面。已取消请求晚到的结果不能加入队列、覆盖新请求状态或修改原稿。失败后可重新输入链接，已有结果仍保留。
- 关闭页面后媒体需要重新读取。来源限制、临时签名过期、浏览器不支持的编码仍可能导致失败；不承诺所有平台链接通用。

## 验证

实际使用产品的 `importMediaUrl` 对 Mozilla 公共测试视频进行 HTTPS GET：HTTP 200，Content-Type `video/mp4`，Access-Control-Allow-Origin `*`，完整读取 1,128,375 字节，生成 `flower.mp4`。SHA-256：`0cd83d944a6ca7822b4a8306cecc60a36e859b041f6702c6a1ad9ead78924451`。测试来源：<https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4>。

新增网络读取单元测试覆盖签名 URL、HTML 伪装、播放列表、文件类型、分块进度、声明和实际体积超限、取消、超时与访问拒绝；界面集成测试覆盖加入队列、取消后晚到响应、失败恢复及旧稿保留。Service Worker 对 `no-store` 请求直接放行，不缓存导入的媒体。

真实联网读取运行于 Node；已检查 CORS 响应头，但没有将它称为真实浏览器跨域或手机编码验证。界面测试使用 DOM / Worker 替身。源文件：`src/media-url.js`；测试：`tests/media-url.test.mjs`、`tests/ui.test.mjs`、`tests/sw.test.mjs`。

浏览器限制参考：[MDN CORS](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS)。
