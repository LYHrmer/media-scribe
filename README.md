# 听写匣 · 浏览器本地版

打开网页，选择音频或视频，点击「开始转写」。不需要安装软件、账号或 API Key，也不按识别次数收费。音视频、视频画面和识别结果在浏览器本机处理；网络只用于下载网页、运行库和开源模型。

[在线使用](https://lyhrmer.github.io/media-scribe/) · [源码](https://github.com/LYHrmer/media-scribe)

## 使用方式

- **自动**：视频识别完整音轨，同时将画面文字保留在候选区供核对。标题、人名条不会自动替代语音；音频直接识别声音。
- **仅识别声音**：忽略画面上的字幕、标题和标识。
- **仅识别画面字幕**：适合有字幕或没有音轨的视频。可疑字另列为待核对候选，不自动拼进正文。
- **中文增强**：默认使用 SenseVoice Small，保留上下文识别快语速；数字整理与按原话识别是两次真实推理；按原话重试还会对低音量尝试适度放大，可恢复上一版。
- 不满意可切换方式后点「不满意，重新转写」。高精度声音识别在设置未变时会交替尝试带时间轴与仅正文解码；后者只有粗略时间，不能当逐句字幕对齐。快速档未手动改动时重转会升为高精度。原结果及手工修改会保留，失败或停止后仍可使用，成功后可恢复上一版。
- 声音识别前用约 2.2 MiB 的 Silero 模型检查人声。极低人声概率的文件先显示待核对提示，避免直接生成噪声幻觉；点击「仍然尝试识别」即可对该文件持续跳过检查。检测失败自动继续原识别，短片直接放行，不按 VAD 裁剪歌词。
- 正文可以编辑、复制，导出 TXT；SRT、VTT、JSON 使用识别片段和时间轴。画面字幕时间表示抽样到字幕的时间，不是经过声音对齐的逐字时间。

首次使用下载所需模型，以后优先使用浏览器缓存。清理缓存或空间不足可能导致重新下载。中文音频默认使用 SenseVoice Small int8。模型与 sherpa-onnx 运行库经无损压缩后首次共下载约 152 MiB，解压后的模型约 228 MiB；分片和完整模型均校验 SHA-256。完整版保留 Whisper Small q4f16（约 191 MiB），切换英语时优先使用它；画面使用 PP-OCRv4（约 15.5 MiB 模型，另有 OpenCV 运行库）。完整构建另提供 Tiny 快速档。体积受限的部署提供 SenseVoice 与 Tiny，保留视觉功能；设置里提供完整版链接，方便使用通用高精度。

中文输出会按需运行本地 CT-Transformer 标点模型，补逗号、句号、问号等，保留原始字词与已有标点。通过只保留相关词表，将原模型约 72 MiB 裁成约 7.3 MiB；保留词输入的原/裁模型预测已实测一致。纯英文沿用语音/OCR 原标点，中英混合场景仍需校对。标点失败时保留原文；JSON 可追溯补标点前的文字。详见 [标点验证](docs/PUNCTUATION_VALIDATION.md)。

## 正确性与当前限制

v0.5.4 修复连续转写的资源释放与失败恢复：每份文件结束后关闭识别 Worker，再补标点或处理下一份文件；停止下载会中止当前分片请求，损坏的中文模型缓存可重新获取。音频读取支持阶段间取消，重采样前解除多声道引用。缓存模型仍可复用，但每份文件要重新初始化模型，可能增加等待时间；这些修复不改变识别字词，也不代表已经通过手机内存实测。220 项回归检查通过；歌词人声分离与字幕四组对照仍未达到采用门槛，详情见 [继续验证记录](docs/LIFECYCLE_LYRICS_VALIDATION.md)。

v0.5.3 修复 SenseVoice 输出紧邻 `，。` 的格式错误，保留原始 `rawText` 和存留字符的时间来源；实际编译后的 ASR、VAD、标点 Worker 已复测，字词错误率没有因此改变。本轮另对比三种 Qwen 研究方案：在每种语言各 4 名新说话人的小集中，部分方案降低了错误率，但仍有个别样本退步、无语音误报，私人歌词仍未解决，视觉核对产生 0 条可用替换。Qwen 尚未接入产品，原生 CPU 与研究 WASM 的结果不等于手机浏览器验证。四方案分母、失败项与部署边界见 [Qwen 准确率验证](docs/QWEN_ACCURACY_VALIDATION.md)，开发者复现见 [研究工具说明](research/qwen-20261014/README.md)。

v0.5.2 增加英语 Small 的分段合并保护，避免把模型已识别出的、预测时间分开的正文误合并而漏词。不增加模型或推理次数，仍保持 30 / 5 窗口。默认英语 11 项实测输出的词错误数均未改善也未退化；已知 q8 诊断中的合并漏词能在相同 tokens 上修复，但不据此更换默认模型或承诺普遍口音准确率提升。新增 9 段真实采访与未采用的候选见 [口音验证报告](docs/ACCENT_VALIDATION.md)。

v0.5.1 新增真实中英文采访验证，修复画面标题截断语音流程、异常时间戳造成字幕漏字、小数被断句的问题。低音量增强仅用于用户主动重试，默认保留原音频。结果与未改善的实验见 [采访验证报告](docs/INTERVIEW_VALIDATION.md)，可复现来源见 [MELI 样本说明](docs/benchmarks/MELI_INTERVIEWS.md)。

**能输出文字不代表识别正确。当前版本对快速中文、嘈杂语音和现场歌声仍可能严重漏字或编造文字。** 不应把模型名称或模型置信分当成准确率。

v0.5.0 已用实际构建后的 WASM Worker 复测固定公开样本：快语速中文 CER 从旧版 Small 的 100% 降至 15.38%；清晰、低音量、合成伴奏和带停顿中文逐字正确，静音/纯噪声被暂缓。嘈杂号码仍未通过；英文保留原模型。新引擎本轮没有复测缺失的私有歌词视频，不能宣称歌词已经修好。完整结果、失败项、模型对照与限制见 [中文增强验证](docs/SENSEVOICE_VALIDATION.md)。

之前已执行 11 个音频用例：6 段独立录音/视频音轨、3 个同源派生控制、2 个合成无语音控制。记录字符错误率、英文词错误率、标点和无语音误识别，并对比不同模型。清晰中英文短句可正确转出，但多项困难用例未通过；新的 [重试实测](docs/RETRY_VALIDATION.md)、[语音后续实验](docs/FAILED_ASR_EXPERIMENTS.md) 和 [画面语境实验](docs/CONTEXTUAL_OCR_EXPERIMENT.md) 也保留未通过项。既有完整失败结果保留在 [正确性测试报告](docs/ACCURACY_BENCHMARK.md) 和 [模型对照](docs/MODEL_COMPARISON.md)。参考文本只参与事后评分，没有作为推理提示或输出答案。

视频增加了真实本地 OCR、透视裁剪、竖排转正、逐字置信与跨帧校对。字幕很小、模糊、遮挡、运动或其他文字干扰时仍可能识错；画面内容也未必就是正在说的话。实际结果与验证范围见 [OCR 验证记录](docs/OCR_VALIDATION.md)。

- 单文件不超过 300 MB、30 分钟；音频解码会读取完整文件，较长文件需要较多内存。
- 视频短片最多每秒 2 帧；长片在全时段抽取相邻帧，总数不超过 360。抽样可能漏掉短暂字幕，界面会说明。
- 人声检测只用于可恢复的整片低概率候选，不根据标准 VAD 语音区间切掉歌声。已验证的小集中 9 个正例保留、3 个负例暂缓（含一份65秒同源噪声派生控制）；这不是所有歌声/耳语的保证，纯噪声仍可能误通过。详见 [人声检查验证](docs/VAD_VALIDATION.md)。
- 手机提供通用选择器、独立音频/视频入口及可见的单文件入口；系统没有可用选择器时，网页不能修复系统能力。
- 当前测试包含真实模型和实际 WASM 推理，传输/缓存用本地替身；不能等同于 Chrome、华为/鸿蒙真机完整操作验证。
- 浏览器必须支持 WebAssembly 和文件所用媒体编码。较新的桌面 Chrome/Edge 优先，其余设备需要实测。文件和图片不能通过本应用上传到模型服务。

## 开发和自托管

需要 Node.js 20 以上。普通用户无需执行以下命令。

```sh
npm ci --onnxruntime-node-install-cuda=skip
npm test
npm run build
npm run dev
```

部署完整 `dist/` 到 HTTPS 静态网站即可。模型在构建时从官方来源下载；浏览器从同一站点下载，不需要单独连接模型网站。Whisper 权重拆成不超过 16 MiB 的分片；模型资产均有 SHA-256 校验。缓存目录默认 `.cache/models/` 和 `.cache/ocr-v4/`，支持 `MODELS_CACHE_DIR`、`OCR_MODELS_CACHE_DIR`、`PUNCTUATION_CACHE_DIR`、`SENSEVOICE_CACHE_DIR`；人声检查模型从固定官方版本生成 `public/models-vad/`。标点构建需要系统 `tar`，从经哈希校验的官方归档提取模型后，在构建时裁剪词表；不依赖 Python 或额外模型服务。

默认完整构建面向 GitHub Pages 等较大静态空间。受 256 MiB 限制的托管使用 `VITE_COMPACT_BUILD=1 npm run build`，保留默认 SenseVoice 和 Tiny，去掉可选 Small；完整版三种模型均可选。GitHub Pages 使用 `.github/workflows/pages.yml`；设置与访问问题见 [发布说明](docs/DEPLOYMENT.md)。模型、媒体、缓存和 `dist/` 不提交源代码仓库。

复现正确性测试见 [测试脚本说明](scripts/benchmarks/README.md)。生成的私有 PCM 和用户视频不公开。自动逻辑检查覆盖取消、重试、原稿恢复、下载完整性、手机文件选择、字幕融合及时间轴；这些检查不能替代识别正确性测试。

## 参考与许可

借鉴 [Whisper Web](https://github.com/xenova/whisper-web) 的浏览器解码与 Worker 架构。按用户要求执行 [REA](https://github.com/morluto/rea) 6.4.0 分析 OpenWhispr 和 Vosk 浏览器版的源码切片，共 20 个文件、52 条导入/引用关系；未声称完成整款商业程序的二进制反编译。分析记录见 [ASR_ANALYSIS.md](docs/ASR_ANALYSIS.md)。本轮又使用 REA 源码导入分析 Whisper Web 与 Transcribe.js，成功关系图及完整应用分析受阻记录见 [REA 采访优化研究](docs/benchmarks/REA_ASR_RESEARCH.md)。

项目代码见 LICENSE。Whisper、SenseVoice、sherpa-onnx、Transformers.js、ONNX Runtime、RapidOCR/PaddleOCR、OpenCV、Silero VAD 和 js-clipper 保留各自许可，见 `public/third-party-notices.txt` 与 `public/licenses/`。源码包不包含用户文件或模型权重。SenseVoiceSmall 权重采用 FunASR 模型协议（代码另为 MIT），保留 FunASR / Alibaba、SenseVoiceSmall 及 k2-fsa 转换来源；详见开源说明。
