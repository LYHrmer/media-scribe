# v0.5.7 开发分支：B站链接 → 完整音轨 → 本地转写

**状态：开发环境链路已验证，在线发布未通过。当前 Sites 服务器在 B站视频信息接口收到 HTTP 412 / -412（`request was banned`）；添加真实应用 User-Agent 后单次复测仍被拒绝。停止上游探测，不合并发布该功能，在线站点恢复 v0.5.6。需要解决平台访问许可或受支持的数据获取渠道后，再验证线上全链路。**

本轮接通公开普通 BV / av 视频、b23.tv 短链接及指定分P。用户粘贴分享文本，点「读取链接」，完成后点「开始转写」。不需要平台账号、Cookie、API Key 或手动下载文件。后台仅中转音轨，识别、标点和结果编辑继续在浏览器内完成。YouTube、抖音本轮未接入。

## 官方接入核查（2026-10-15）

已核对官方外链播放器、授权稿件查询与开发者入驻文档。当前公开文档尚未确认满足本项目条件的音轨获取接口；稿件查询的播放页和 iframe 地址不能当成音频流。需要平台确认具体媒体权限与接口，不能把普通 OAuth 授权视为取音权限。本轮未继续请求被拒绝的接口，也未启动新的线上验收。官方依据、待确认的接入条件和验收要求见 [音频接入核查](BILIBILI_ACCESS_REVIEW.md)。

## 实现与边界

- 根据普通视频元数据选择链接指定的分P / CID，再使用公开 WBI 参数读取匿名 DASH AAC 音轨；不直接把 HTML 网页交给解码器。
- 向媒体 CDN 发送播放器正常使用的原视频页 Referer。相同媒体地址的诊断对照：未带 Referer 返回 403 HTML，补正常 Referer 返回正确的 MP4 字节，完整 GET 返回 200；没有使用账号、Cookie、IP 切换或挑战求解。
- 只接受 B站视频页与 b23.tv；每次跳转重新校验。只读取平台明确返回的固定 CDN HTTPS 音轨；可以选择合法备用 URL，不开放任意地址代理。
- 仅处理公开普通视频的完整音轨，拒绝付费、试看、DRM、互动、直播、番剧或未允许匿名读取的内容。单P最长 30 分钟、音轨最多 64 MiB；45 秒无响应会取消。检查响应状态、媒体头、声明与实际长度；超限和截断不进入成功队列。
- 连接在收到响应前失败时，对同一地址最多再试一次；403、429、用户取消与已开始传输的部分文件不自动重试。用户仍可重新点「读取链接」。
- 进度、取消、明确错误提示与旧稿保护均沿用现有队列。B站导入的是 M4A 音频，不会伪装成视频触发 OCR；若要核对画面字幕，仍需选择本地视频。
- 本地文件不上传；用户主动提交的 B站页面地址和返回音轨经过本站服务。应用不持久保存媒体、链接或转写结果，托管平台仍可能记录基础请求日志。

## 固定样本与真实推理

10 条样本在请求媒体前冻结，失败不换样本。独立匿名下载验证：10/10 完整音轨取得并通过 ffprobe 与 FFmpeg 全解码，总计 32,458,007 字节。随后用实际 Vite 编译后的 SenseVoice、VAD 与标点 Worker 处理各条完整 PCM，10/10 产出正文和时间段，没有使用参考答案提示模型。总 PCM 时长约 1693.18 秒；本机顺序推理共约 377.24 秒，该耗时不是手机性能或网络下载耗时。

本轮选择可用的 SenseVoice 中英识别路径；不等于对完整版默认英语 Whisper Small 另做了一轮验证。传输、缓存和 Worker 通道使用 Node 适配层；媒体解码使用 FFmpeg，不是浏览器 AudioContext。没有 Chrome/华为/鸿蒙真机端到端通过的声明。

| 样本 | 来源类型 | 完整音轨秒数 | 完整解码 | 真实模型产出 |
| --- | --- | ---: | --- | --- |
| [sample-01](https://www.bilibili.com/video/BV13x41117TL) | 歌曲讲解（中英混合） | 554.12 | 通过 | 有正文、时间段和标点 |
| [sample-02](https://www.bilibili.com/video/BV1L8f1BiErq) | 谷爱凌英语采访 | 87.93 | 通过 | 有正文、时间段和标点 |
| [sample-03](https://www.bilibili.com/video/BV19NF5zLE7G) | 户外军事采访 | 150.09 | 通过 | 有正文、时间段和标点 |
| [sample-04](https://www.bilibili.com/video/BV1ct411Q7Q6) | 央视街访 | 187.99 | 通过 | 有正文、时间段和标点 |
| [sample-05](https://www.bilibili.com/video/BV1xt4y1S7Hp?p=3) | Billie 英语采访 P3 | 56.24 | 通过 | 有正文、时间段和标点 |
| [sample-06](https://www.bilibili.com/video/BV1p4rMBwEgo?p=8) | Alan 英语采访 P8 | 80.76 | 通过 | 有正文、时间段和标点 |
| [sample-07](https://www.bilibili.com/video/BV1K64y1u7MT) | BBC 一分钟新闻 | 64.30 | 通过 | 有正文、时间段和标点 |
| [sample-08](https://www.bilibili.com/video/BV1KTsre2EDU) | 金海豚评委采访 | 66.71 | 通过 | 有正文、时间段和标点 |
| [sample-09](https://www.bilibili.com/video/BV1MgdDYvELc) | 央视诗会报道 | 291.99 | 通过 | 有正文、时间段和标点 |
| [sample-10](https://www.bilibili.com/video/BV1kv411s76z) | 中文访谈片段 | 153.05 | 通过 | 有正文、时间段和标点 |

## 正确性核对与保留的失败

- 这些完整音轨没有逐字人工标注，完整音轨的 CER/WER 均记为 `null`，绝不把“有文字”写成“准确率 100%”。原始版权音视频和完整转写不放入公开仓库。
- 在查看完整模型输出前，独立从 sample-03 画面读出约 37–45 秒的 40 字旁白。完整音轨转写中的对应段落字词编辑错误为 0/40，标点位置有差异。这只是单段核对，不能代表整片准确率；同片其他位置仍有可见的错字、漏字。
- 将该旁白硬裁成 37–45 秒后另跑模型，得到 3/40 字缺失，位于裁剪边界；完整上下文中这些字仍在。保留此诊断，不据此裁剪用户输入、修改答案或宣布识别升级。
- 正式导入模块＋正式 HTTP handler 的第一轮为 9/10：sample-06 连接中断，单独重新读取成功。加入“收到响应前连接失败最多重试一次”后，第二轮仍为 9/10：sample-07 传输中断。这说明有限重试不能保证网络永不失败；两个失败均保留在报告中。所有样本至少一次完整成功，但不能把两轮结果合并为“首次全通过”。
- 265 项自动检查通过，覆盖接口白名单、跳转、分P、WBI、状态与内容校验、体积、取消、超时、有限重试、CORS、前端队列、导出与旧稿保留。界面检查使用 DOM/Worker 替身。

数据见 [冻结清单](benchmarks/BILIBILI_SAMPLES.json) 与 [指标和失败记录](benchmarks/BILIBILI_RESULTS.json)。首次在线部署的 10/10 请求均收到 B站上游拒绝，未取到音轨；首页 HTTP 200、Pages CORS 预检 204。此失败已保留，不能将本地 handler 的成功代替在线服务成功。补充真实应用身份标识后单次复测仍失败，最小日志确认拒绝发生于 `/x/web-interface/view`：HTTP 412，JSON code -412，message `request was banned`。未进行 Cookie 借用、挑战求解、IP 轮换或替代路由探测。

## 复现

需要 Node.js 20 以上及 ffmpeg/ffprobe。输出目录应位于仓库外，不要提交下载的版权音视频。

```sh
node scripts/benchmarks/validate-bilibili.mjs docs/benchmarks/BILIBILI_SAMPLES.json /tmp/bilibili-handler-check
node scripts/benchmarks/validate-bilibili.mjs docs/benchmarks/BILIBILI_SAMPLES.json /tmp/bilibili-live-check https://tingxie-local.mossy-loach-2602.chatgpt.site/api/bilibili
```

第一条调用正式导入函数与进程内 HTTP handler，真实请求 B站；第二条请求已部署 HTTP 服务。两者均真实保存完整音轨、记录 SHA-256 并全解码，任何失败非零退出；不模拟平台结果。真实 WASM 转写可按 `scripts/benchmarks/run-sensevoice-production.mjs` 执行：先将每份媒体解码成 16 kHz 单声道 f32le、记录哈希，然后生成 `cases` 清单。没有人工参考的样本省略 `reference`，评分为 `null`，参考文本只在推理后交给评分器。

实现参考：[yt-dlp B站提取器](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/bilibili.py)、[Cloudflare 静态资源绑定](https://developers.cloudflare.com/workers/static-assets/binding/)。本项目只实现普通公开视频音轨所需的 HTTP 路径，不内置 yt-dlp，不绕过平台登录与付费要求。
