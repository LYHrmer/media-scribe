# 中英文真实采访评测：MELI 固定片段

本页仅定义样本与复现流程，不报告任何识别实验结果。四段片段均在查看待测模型输出前选定，之后通过音频、标注、参考文本的 SHA256 固定，不能为提高分数换答案或样本。

## 来源与范围

来源为 Suyuan Liu、Molly Babel（University of British Columbia）的 **MELI: Mandarin-English Language Interview**，发布版本 1.2（2026-10-07）。原始录音为自然社会语言学采访，包含受访者对语言学习、方言及语言标准性的回答。

| 样本 | 语言 | 原录音区间（秒） | 准备后时长 | 官方音频 ID | 官方标注 ID |
|---|---|---|---:|---:|---:|
| meli-f01b-zh | 中文 | 270.600000–296.220612 | 25.620625 秒 | 1116060 | 1116056 |
| meli-f00a-en | 英文 | 188.688481–223.378413 | 34.689938 秒 | 1115854 | 1115880 |
| meli-m00a-zh | 中文 | 567.580000–603.553333 | 35.973375 秒 | 1115924 | 1115925 |
| meli-m00a-en | 英文 | 300.498481–339.378912 | 38.880438 秒 | 1115829 | 1115790 |

合计 135.164375 秒；每种语言涉及两位不同受访者。总计四段语言会话录音、**三位受访者**，其中 M00A 同时提供中英文片段，不能说成四位独立受访者。英文包含非母语口音，不能代表英语母语采访总体。

- [数据集发布页](https://doi.org/10.5683/SP3/5WMRUO)
- [官方论文（LREC 2026）](https://aclanthology.org/2026.lrec-1.468/)
- [官方录制流程](https://borealisdata.ca/api/access/datafile/1115444)
- [官方标注流程](https://borealisdata.ca/api/access/datafile/1115404)
- [官方数据版本元数据 API](https://borealisdata.ca/api/datasets/:persistentId/?persistentId=doi:10.5683/SP3/5WMRUO)

音频/标注下载 URL 格式为 `https://borealisdata.ca/api/access/datafile/<上表ID>`。脚本使用已固定的数据文件 ID，无需先准备本地元数据，也不会根据可变的最新版本自动换样本。

## 参考答案与有效性边界

每段必须完整落在官方 TextGrid 的 `task=Interview` 区间内；不使用 `Sentence Reading`。参考来自 `utterance-corrected` 层：先由 Whisper-large-v3 起稿，再由双语研究助理人工校正。因此它不是纯人工从零标注，也不是本项目待测 Small / SenseVoice 模型的输出；报告应说明这项标注来源可能带来的偏差。本轮准备流程不额外声称完成了人工逐字听审。

参考清理仅删除非语音 `{...}` 标记和半词 `&fragment` 标记，并删除中文空格。完整字词、重复、口头语和原有语法均保留，原始标注与清理后参考分别留存。标准 CER/WER 会计入口头语和重复词差异；分析时应区分内容识错、口头语省略以及同音字书写差异，不能把每个字面差异都解释成听错含义。

**官方原标注刻意省略大多数标点**，这些参考不能用于计算标点正确率。中文标注另有代词书写规范，也可能形成口语含义相同的字面差异。

官方流程规定立体声左声道为受访者、右声道为采访者；只有受访者被完整转录。脚本选择没有 `interviewer` 标记的连续回答，保留左声道，不拼接句子。因此本集合验证采访回答的识别，**不验证双人整场转写、说话人区分或采访问题识别**。源码范围 WAV 保留立体声，可进一步检查串音。

处理只有左声道选择与 `scipy.signal.resample_poly(left, 160, 441)` 重采样至 16kHz；不加噪、不降噪、不变速、不调增益。下载使用官方支持的 HTTP Range，避免为了半分钟片段下载完整数百 MB WAV。下载的原始立体声 PCM 范围、范围 WAV、完整 TextGrid、重采样 PCM 和规范化参考均固定 SHA256。完整原 WAV 的 MD5 仅来自发布方，**未在本地验证完整文件**。

## 复现

需要 Python 3.10+；生成本轮逐字节相同的 PCM 所用依赖为 `numpy==2.3.5 scipy==1.17.0`。若其他版本生成了不同字节，脚本明确失败，不会自动接受新哈希。

```bash
python -m pip install numpy==2.3.5 scipy==1.17.0
python scripts/benchmarks/prepare-meli-interviews.py --output-dir /absolute/path/outside-repository/meli
```

默认生成全部四例，输出目录须在源码仓库之外。输出包括原始 TextGrid、`*-source-range.wav`、16kHz `.f32` 输入、试听 `.wav` 和 `cases.local.json`。清单使用已有评测脚本的 `.cases` 格式，包含 `pcm_path`、`pcm_sha256`、`reference`、`language`（`chinese` / `english`）、`duration_seconds` 及详细出处、许可和处理记录。推理只应接收音频与语言；参考文本仅供推理结束后的评分器使用。

已有同名、哈希一致的本地缓存可直接复用。网络关闭验证及重建：

```bash
python scripts/benchmarks/prepare-meli-interviews.py --output-dir /absolute/path/outside-repository/meli --offline
```

仅检查参数、列出固定区间而不下载、不写文件：

```bash
python scripts/benchmarks/prepare-meli-interviews.py --output-dir /absolute/path/outside-repository/meli --dry-run
```

缓存损坏、源文件变更、区间不再标记为 Interview、参考清理变化或 PCM 哈希不匹配都会失败。不得通过重写固定哈希掩盖变化；有意改样本应作为明确的新评测版本，重新记录依据。

运行已有 SenseVoice 生产 WASM 评测时，本集合没有旧集合的 `zh-clean` 缓存验证样本，因此跳过该旧集合专用检查：

```bash
SKIP_CACHE_CHECK=1 node --experimental-vm-modules scripts/benchmarks/run-sensevoice-production.mjs dist /absolute/path/outside-repository/meli/cases.local.json /absolute/path/outside-repository/meli/results.json
```

这类 VM/WASM 检查不等同于真实手机浏览器、媒体解码或界面验证。

## 许可与保存

当前数据版本元数据标为 **[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)**；早期论文写的是拟采用 CC BY-NC 4.0，应遵循实际发布数据版本的 BY-NC-SA 条款。署名为：Suyuan Liu and Molly Babel, University of British Columbia, *MELI: Mandarin-English Language Interview*。

媒体、完整标注和包含参考全文的实验清单仅保存在本地实验目录，不提交 GitHub，不上传至远程转写服务，不用于训练。若发布参考摘录或相关数据衍生物，应保留来源署名及适用的 CC BY-NC-SA 4.0 许可，**不能套用项目 MIT 许可**。本页和准备脚本不包含采访参考全文；生成的数据有独立许可。

## 可选中文 holdout：新增受访者

为检验一项已经固定的全音频音量处理策略，另准备两位此前未用受访者的中文采访。**原四例默认集合不变**。这两例在查看其待测 ASR 输出之前选定，选样时也不计算或筛选 RMS。待评策略在选样前已规定：全音频 RMS 在 `1e-5 .. 0.01` 范围内时，以 `0.04` 为目标放大，增益最多 8 倍，并以峰值不超过 `0.95` 为限；RMS ≥ `0.01` 不放大。本页不报告该策略的实际识别结果，也不根据 holdout 调整阈值。准备脚本本身不执行上述增益，只生成原始输入。

| 样本 | 原录音区间（秒，按帧四舍五入） | 准备后时长 | 音频 ID | 标注 ID |
|---|---|---:|---:|---:|
| meli-holdout-f01a-zh | 249.572063–271.015941 | 21.443938 秒 | 1116059 | 1116037 |
| meli-holdout-m00b-zh | 1093.328617–1121.376327 | 28.047750 秒 | 1115895 | 1115887 |

固定选择顺序为 **F01A_man → M00B_man**。对每份官方标注，在 `Interview` 区间内按时间顺序枚举由采访者发言分隔的完整回答；整段含 `xxx`、语言/方言标记 `@` 或 `[REDACTED]` 的回答排除；去掉回答首尾仅非语音的标注区间后，选择首个长 20–40 秒的完整回答。回答内部自然停顿保留。M00B 这段含约 9.8 秒思考停顿，并非人为插入的静音，也没有拼接音频。F01A 的半词标记有紧贴中文的情形（如 `&n` 后直接跟汉字），清理仅删除标记中的拉丁字母，保留其后的完整汉字；原四例参考 SHA256 不受影响。

```bash
python scripts/benchmarks/prepare-meli-interviews.py --output-dir /absolute/path/outside-repository/meli --holdout
```

这条命令仅生成两例 holdout，写入 `holdout.local.json`；`--offline`、`--dry-run` 也可组合使用。新受访者的原始 TextGrid、原始音频范围、范围 WAV、最终 PCM 和参考 SHA256 同样被冻结。输出仍然必须在仓库之外，并适用上面的参考来源、声道、标点、版权和验证边界。
