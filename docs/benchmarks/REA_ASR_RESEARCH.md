# REA 与浏览器音视频转写源码对照（2026-10-14）

本轮采用官方 npm `rea-agents@6.4.0`，仅在实验目录本地安装（`--ignore-scripts`），未执行 `setup`、修改全局 MCP 配置、安装浏览器或运行被分析的应用。

## 实际执行结果

| 项目 | 固定源码提交 | REA 成功操作 | 结果边界 |
| --- | --- | --- | --- |
| [Whisper Web](https://github.com/xenova/whisper-web) | `81869ed62970ff4373509b6004a6c9a3f0c5b64d` | `import-reference-source` | 源码文件哈希、静态导入关系；不是程序运行或识别质量证明 |
| [Transcribe.js](https://github.com/TranscribeJs/transcribe.js) | `f3ad934d682ef57c7ff612de0382cc196ab7b6b2` | `import-reference-source` | JS/C++ 文件清单、可解析的导入关系；WASM 内部未反编译 |

Whisper Web 的 REA 输出为 42 个条目、34 个关系、0 个解析失败；`.git` 被默认排除，因此 REA 正确记录 `inventory_state=partial`。详细计数与文件 SHA-256 见 `REA_PROVENANCE.json`。

同时对两项目各实际执行两次 `analyze-javascript-application`。完整应用分析在启动 AST 分析子进程前，被宿主的 `procps ps` 错误 `fatal library error, lookup self` 阻断；未获得完整 feature/semantic trace。按官方 Linux prerequisite 核验，已存在 `/usr/bin/ps`（procps-ng 4.0.4），直接运行曾成功、曾失败，但 REA 重试仍失败。未伪造、关闭或修改进程归属检查。

官方主分支文档中的 `import-reference-source --detail summary` 在 npm 6.4.0 中尚不可用；改用该版本支持的完整 JSON 导入后成功。这一失败也保留在原始记录中。

可复现命令（将路径换为本地绝对路径）：

```bash
npm install --prefix ./tool --ignore-scripts --no-audit --no-fund rea-agents@6.4.0
./tool/node_modules/.bin/rea import-reference-source /absolute/whisper-web --json > whisper-web-source-import-full.json
./tool/node_modules/.bin/rea import-reference-source /absolute/transcribe.js --json > transcribe-js-source-import-full.json
./tool/node_modules/.bin/rea analyze-javascript-application /absolute/whisper-web --json > whisper-web-evidence.json
```

原始输出位于本报告同目录。`*-source-import-full.json` 是成功记录；`*-evidence.json` 与 `*-retry-evidence.json` 是失败及局部观察记录。不能将失败文件内的 partial_observation 宣称为完整分析成功。

## 逐行对照后可迁移的策略

以下结论来自 REA 定位/导入关系后的人工源码阅读；本报告不包含这些项目的运行测试，因此不声称其识别率优于听写匣。

| 机制 | 一手代码证据 | 对听写匣的判断 |
| --- | --- | --- |
| Whisper 滑窗及重叠 | [Whisper Web worker.js 151–172](https://github.com/xenova/whisper-web/blob/81869ed62970ff4373509b6004a6c9a3f0c5b64d/src/worker.js#L151-L172)：普通 Whisper 30 秒窗口、5 秒 stride，贪心解码；Distil 20 秒/3 秒 | 现有 `transcriber.worker.js` 已有 30 秒/5 秒。重复移植这一设置不能算本轮新改进。优先验证分段之前的静音裁切和正文/时间戳解码差异。 |
| 保留起音上下文 | [Transcribe.js StreamTranscriber.js 216–300](https://github.com/TranscribeJs/transcribe.js/blob/f3ad934d682ef57c7ff612de0382cc196ab7b6b2/src/StreamTranscriber.js#L216-L300)：实现默认 preRecordMs=1000、maxRecordMs=10000、minSilenceMs=700 | 可测试 SenseVoice 分段保留 0.8–1 秒左右上下文；不要原样采用 10 秒强制切断，采访需要完整短语。注释的默认值与实现不同，以上以实现为准。 |
| 保留句子，限制流式速度优化的使用范围 | [Transcribe.js shout.wasm.cpp 484–513](https://github.com/TranscribeJs/transcribe.js/blob/f3ad934d682ef57c7ff612de0382cc196ab7b6b2/shout.wasm/src/shout.wasm.cpp#L484-L513)：流式 `no_context=true`、`single_segment=true`、关闭温度回退、裁小 encoder context；[StreamTranscriber.js 152–159](https://github.com/TranscribeJs/transcribe.js/blob/f3ad934d682ef57c7ff612de0382cc196ab7b6b2/src/StreamTranscriber.js#L152-L159) 默认 max_tokens=32 | 这些主要服务低延迟。不能因为小程序响应快就照搬到离线采访，尤其不能给采访设置 32 token 上限造成漏词。 |
| VAD 能量/频谱滞回 | [Transcribe.js vad.js 101–217](https://github.com/TranscribeJs/transcribe.js/blob/f3ad934d682ef57c7ff612de0382cc196ab7b6b2/src/audio-worklets/vad.js#L101-L217)：能量、最大频率、谱平坦度投票及连续帧滞回 | 说明非神经算法确实参与了软件处理，但它判断说话区间而非识别文字。现有 Silero 不应未经录音实测换成该规则 VAD；背景音乐/风噪下存在误判风险。 |
| 基于失败证据的解码重试 | [OpenAI Whisper transcribe.py 184–224](https://github.com/openai/whisper/blob/main/whisper/transcribe.py#L184-L224)：高重复率/低平均 logprob 才触发温度 fallback；高 no_speech_prob 且低 logprob 视作静音，停止 fallback | 若当前导出模型/API 能提供相应证据才实现同义机制，不能捏造置信度。现阶段将“保留原文、明确另一解码方式、可恢复”作为底线，采访中优先测试局部上下文重识别。 |
| 双声道混音不是越响越准确 | [Whisper Web useTranscriber.ts 152–164](https://github.com/xenova/whisper-web/blob/81869ed62970ff4373509b6004a6c9a3f0c5b64d/src/hooks/useTranscriber.ts#L152-L164)：左右相加乘 sqrt(2)/2；[Transcribe.js utils.js 14–50](https://github.com/TranscribeJs/transcribe.js/blob/f3ad934d682ef57c7ff612de0382cc196ab7b6b2/src/utils.js#L14-L50)：浏览器 downmix | 听写匣已经处理反相信号抵消，不应退回简单相加。采访若一声道是采访者、另一声道是受访者，选择“最强声道”会漏人声，应维持保守混音，并在有证据时提供显式声道选择。 |
| 对齐和标点不是改正单词 | [Transcribe.js shout.wasm.cpp 177–190、315–337](https://github.com/TranscribeJs/transcribe.js/blob/f3ad934d682ef57c7ff612de0382cc196ab7b6b2/shout.wasm/src/shout.wasm.cpp#L177-L190)：token 概率和可选 DTW 时间戳 | DTW 改善定位，并不会自动改正人名/数字。标点模型只恢复标点，不应把错词洗成流畅而错误的句子。 |

## 本轮应优先实测的改动

1. **SenseVoice 边界上下文。** 当前每 26–30 秒找 40 ms 最安静窗口后完全分开；最小能量点未必是真正停顿，可能落在词内。候选方案是寻找持续低能量区间，或在每段前后加上下文，并按 CTC 时间戳保留中央负责区间。模型输入总长度继续控制在内存限额内。不要全局文本去重；采访中的真实重复必须保留。
2. **Whisper 文本解码/时间戳解码成对实验。** 相同录音、相同 PCM、相同模型，只改变解码模式；仅在 WER 改善且没有长段漏识别时采纳。不能按输出更长来自动选胜者。
3. **真实暂停和跨说话人衔接。** 用有问答转换、犹豫、口误、专名、数字的采访验证。Silero 的整文件无语音判断、静音裁切和分段应分别消融；不要把不稳定的 VAD 结果当成“这一段绝对没有说话”。
4. **多模型只标注分歧，不无条件投票覆盖。** SenseVoice 和 Whisper 可能同时误听同一人名；不同 tokenizer 的 token 概率不能直接横比。先保留候选、原始结果及原音时间，是否自动融合必须由独立带人工参考文本的测试支持。

评估必须同时记录：原始输出、规范化 CER/WER、数字等价分数、漏词数、分段重复、标点表现及实际运行开销。新增采访的参考文本不能进推理提示/字典；原有失败样本继续保留。将新增采访与原有回归集分开报告，不能用一段干净英语通过代替中文嘈杂号码问题解决。

## 工具和证据边界

REA 是本地软件结构分析工具，不是 ASR 模型或音频增强器；不会由前端自动获得商业云服务的模型权重。本次没有逆向商业服务、绕过访问控制或上传用户音视频。源码策略只有经过当前模型的真实录音消融实验，才能成为准确率改进结论。

官方参考：

- [REA README](https://github.com/morluto/rea/blob/main/README.md)
- [REA JavaScript workflows](https://github.com/morluto/rea/blob/main/docs/javascript-application-workflows.md)
- [REA Linux prerequisite](https://github.com/morluto/rea/blob/main/docs/installation.md#linux-owned-process-prerequisite)
- [REA CLI 与源码导入](https://github.com/morluto/rea/blob/main/docs/cli.md#import-historical-source)

