# v0.5.0 中文增强实测

日期：2026-10-14。此次把 SenseVoiceSmall 接入实际浏览器 Worker，不再只在原生 Python 中比较。中文默认使用增强模型，完整版保留 Whisper Small 和 Tiny；切换英语仍使用原有 Small。全部计算在用户浏览器完成，下载模型不需要账号、API Key 或按次付费。

## 固定参考下的结果

输入使用原测试集中相同的 10 个公开/派生 PCM，全部 SHA-256 与原基准一致。参考文本仅参与模型推理后的评分。独立录音仍是 5 段；低音量、合成伴奏、停顿及本轮新增长片都是同源派生控制，不能当成更多独立录音。

以下 CER 忽略标点与空白，数字“9/九/幺/一”的差异仍算错；等价数字指标另报，不修改原评分。

| 用例 | 旧版 Small 默认 CER | SenseVoice 默认 CER | SenseVoice 按原话重试 CER |
|---|---:|---:|---:|
| 清晰中文 | 0% | 0% | 23.08% |
| 极快中文 | 100% | 15.38% | 15.38% |
| 噪声与号码 | 100% | 86.79% | 50.94% |
| 低音量中文 | 15.38% | 0% | 未重复测 |
| 合成伴奏中文 | 38.46% | 0% | 未重复测 |
| 两遍短句、中间静音 | 0% | 0% | 15.38% |
| 纯静音 | 无输出 | 人声检查暂缓，无输出 | — |
| 固定随机噪声 | 错出文字 | 人声检查暂缓，无输出 | — |

**没有全部通过。** 快速中文仍有 20/130 个字符错误，嘈杂号码仍不可信。号码样本的等价数字 CER：默认 52.83%，按原话 50.94%；旧版 Small 的仅正文重试曾达 35.85%，因此不能宣称新引擎对每个难例都更好。所有原始结果保留。

“按原话”改变模型的 `useInverseTextNormalization` 输入条件，重新运行特征提取和推理，随后运行标点模型；并非把上一份答案换个名称。该方式会把数字保留为汉字，也可能更差：清晰短句出现了“开饭”错误，所以只作为可恢复的主动重试，不自动替换第一份结果。正文、手工修改及上一版可以恢复。

英语 JFK 在同一原始 PCM 上 CER/WER 为 0；有噪声英语对话 SenseVoice WER 为 41.94%，比原有 Small 默认 29.03% 更差。完整版的英语默认保持 Small，没有把这项试验倒退变成默认行为。精简托管只有 SenseVoice 与 Tiny，设置里提供完整版入口。

## 发现并修复的回归

- 直接复用 Whisper 的静音裁切，在两遍短句中把“开放”识成“开饭”，CER 7.69%。新路径保留完整音频上下文，长片以不超过 30 秒的窗口在附近低能量位置切开，不丢弃边界样本；仅跳过整窗近静音。复测该短句 CER 为 0%。
- 新增约 60.7 秒的 8 次短句加静音控制，覆盖长片分段，104 个参考字符没有漏字或替换，CER 0%。这是派生用例。
- 模型会偶尔输出连续句号或很晚的标点 token。仅折叠连续中文句号，保留字词、数字、小数、英文点号和省略号；原始模型文字保留在 `rawText`。单独的标点 token 并入前一条字幕，避免只显示“。”的字幕条。

## 真实模型与发布路径

- 模型：官方 sherpa-onnx 的 SenseVoiceSmall int8，239,233,841 字节，SHA-256 `c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51`。
- 模型 revision：`2365baeacb507f821a0c8120fcee3d484dba7a07`。WASM/API revision：`9d5fc71d88ab1222ed1af2274fb194592af48455`。固定来源及哈希见 `scripts/prepare-sensevoice.mjs`。
- 使用原版 sherpa-onnx 特征提取、词表与解码。仅去掉示例的 Zipformer 预加载，并加 ES module 包装；没有改写模型参数，也没有把参考答案喂给模型。
- 模型、词表、运行库合计下载约 151.6 MiB，经 gzip 无损压缩；逐片校验压缩数据，解压后再校验完整原模型。缓存损坏、HTML/403、路径错误、超时不能被当成成功模型；缓存存储失败不阻止正常识别。
- 在同一站点下载，模型分片不超过 16 MiB；从空缓存下载固定官方源并校验成功。切换模型/解码方式时终止原 Worker，避免两套模型堆同时常驻。首次模型初始化仍需要明显内存，不能把下载体积当运行内存。
- 声音识别前保留 Silero 的可恢复人声检查，之后接本地标点模型。无语音控制必须按整个链路评估：SenseVoice 单独运行仍会对噪声输出“我”。

## 实验记录与复现

- `benchmarks/results-sensevoice-production-v050.json`：实际 Vite ASR + VAD + 标点 Worker，10 个固定用例及新 Worker 缓存复用检查。
- `benchmarks/results-sensevoice-verbatim-v050.json`：4 个按原话重试用例。
- `benchmarks/results-sensevoice-long-v050.json`：约 60.7 秒的长片分段与标点控制。
- `benchmarks/results-sensevoice-alternatives-v050.json`：SenseVoice 8 秒硬切与 Paraformer Small 对照。硬切快语速 CER 13.85%，但号码等价 CER 54.72% 更差；Paraformer Small 快语速 CER 20%，号码 CER 56.60%。没有仅因一个样本分数变好就把这些方案替换为默认。

运行 `npm test`；实际模型复现命令见 `scripts/benchmarks/README.md`。模型输出来自真实 WASM，不是 mock。HTTP、Cache API、Worker 消息传输在 Node VM 中模拟；AudioContext 文件解码、完整浏览器交互和华为/鸿蒙手机未在本轮实测。进程 RSS 包括多组模拟 Worker、测试缓存和下载缓冲，不代表手机内存占用。

本轮原上传歌词视频在当前工作目录缺失，没有重新测它。旧歌词、视觉与语境融合未通过项继续保留在原报告中；没有把用户给出的歌词直接写入识别规则。不能声称完整歌词已经通过。

SenseVoiceSmall 权重使用 FunASR 模型协议 v1.1，来源/作者为 FunASR / Alibaba，ONNX 转换由 k2-fsa/sherpa-onnx 提供；相关代码另为 MIT/Apache-2.0。许可正文及来源保存在 `public/licenses/` 和 `public/third-party-notices.txt`。
