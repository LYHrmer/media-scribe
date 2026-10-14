# 参考文本驱动的正确性测试

工具只在本机运行，素材与 PCM 留在你指定的工作目录。仓库不包含用户视频、音轨或公共录音。参考文本只在推理完成后评分，绝不传给模型作为 prompt、热词或候选答案。

依赖 Python 3、ffmpeg、Node 20+，以及已经完成 `npm install` / `npm run build` 的站点目录。`run-production-wasm.mjs` 使用当前生产 Worker、构建后的 Transformers.js 浏览器 bundle、实际 ONNX WASM 与同源分块模型校验器；不是原生 ONNX 推理。Node VM 模拟 Worker / Cache API，模型 GET 从本机静态资源读取，WASM helper URL 映射为 `file:`。它不验证浏览器解码器、界面、华为真机或手机耗时。

## 准备素材

把获取的素材放在仓库外，例如 `$MEDIA_DIR`：

```
zh.wav
jfk.wav                         # 也接受 16 kHz 单声道 Float32 LE 的 jfk.f32
qwen-test-wavs/fast1.wav
qwen-test-wavs/noise2.wav
qwen-test-wavs/f1_noise.wav
qwen-test-wavs/transcript.txt
```

来源与校验值见 `docs/benchmarks/case-provenance.json`。中文短句来自 sherpa-onnx SenseVoice 官方示例，英文演讲来自 whisper.cpp 官方 samples 和 US National Archives 文稿，困难语音来自 Qwen3-ASR 官方发布的测试示例及 sherpa 转存的 transcript.txt。样本音频未单列许可，因此本仓库只保留来源、哈希与文本结果，不再分发音频。提供方的参考文本不是这里新增的独立人工金标准。

```sh
python scripts/benchmarks/prepare-cases.py --media-root "$MEDIA_DIR" --output "$BENCH_DIR"
node --experimental-vm-modules scripts/benchmarks/run-production-wasm.mjs . "$BENCH_DIR/cases.local.json" "$BENCH_DIR/results.json"
```

不传视频时准备 10 个用例：5 个独立公共录音、3 个派生语音控制、2 个合成无语音控制。音量变体、合成无歌词伴奏和静音间隔没有算作新的独立说话人。

需要加入私有视频时，显式给出该视频的已知参考文本；视频不会复制到输出目录，只生成本地 PCM。输入另一段视频时使用其真实参考，不能沿用别的歌词答案。

```sh
python scripts/benchmarks/prepare-cases.py --media-root "$MEDIA_DIR" --output "$BENCH_DIR" --user-video "$PRIVATE_VIDEO" --user-reference "$KNOWN_REFERENCE"
```

`$MEDIA_DIR`、`$BENCH_DIR` 和私有视频都应放在仓库外。不要把素材或 `pcm/` 加入 Git。

## 评分与记录

- 中文先 NFKC、转小写、去空格和标点，按 Unicode 码点算 Levenshtein 字错数 / 参考字数（CER）。CER 可能超过 100%，它不是准确率。
- 英文另算 WER。`score-transcripts.mjs` 可单独导入，给其他引擎的盲推理结果评分。
- 数字额外提供一个明确标注的等价分数：只将阿拉伯 0–9 换成零–九、幺换成一。严格原分数保留。
- 繁简差异保留在严格 CER，报告另说明已核验的纯书写差异，不把它们误说成语义错字。
- 标点单独计数和比较。只有文字一致时才比较标点位置；不同有效的停顿方式不一定是内容错误。
- 空参考不计算 CER，而记录是否捏造文字。静音和已知无语音噪声都应返回空文本。

结果逐个用例写盘，保存输入 PCM 哈希、来源、原始输出、模型资产访问数、标点分数和源文件 / 浏览器 bundle / WASM 哈希。它按仓库当前代码运行，新增 `src/` 内相对导入的辅助模块会自动加载；越出 `src/` 的源码导入会被拒绝。只允许预期的 Transformers 浏览器 bundle 与固定 WASM helper 动态导入。没有当前模型资产时如实报错，不暗中换模型。

模型默认 `Xenova/whisper-small`；可用 `BENCHMARK_MODEL` 指定当前 Worker 已支持并已准备资产的模型。`BENCHMARK_MODEL_ASSET_ROOT` 可用于另一个本地静态模型目录，仍必须经过生产分片校验。`BENCHMARK_EXPERIMENT_NOTE` 用于记录明确的试验改动，不能替代源文件哈希。

`BENCHMARK_DECODING=text` 可验证生产 Worker 的仅正文重试；默认 `timestamps`。仅正文的时间段是原始声音范围，不是逐句声学对齐。这个脚本单独测语音 Worker，尚不自动串联画面、人声检查或标点；这些层的独立验证及边界见各自报告，不将声学 CER 改写成流水线准确率。

## 历史基线

`docs/ACCURACY_BENCHMARK.md` 的 11 用例是 2026-10-13 完成的版本 0.3.2、提交 `afcff5a10372ed3d54ff14f84ed963d6a4c75563` 实测，包含当时用户私有视频音轨。报告没有声称当前版本重新跑出了同样结果；新的运行应输出新的 JSON 并核对 source / bundle / WASM 哈希。

`docs/MODEL_COMPARISON.md` 同时保留 Tiny、Base 和 Small q8 的实际 WASM 对照。实验模型的允许名单 / dtype 变化写在结果里，不冒充生产已发布功能。小规模诊断套件不提供可泛化的整体准确率，也没有声称已覆盖均衡男女声音、课堂、会议、多种口音与真实手机环境。

## v0.5.0：实际 SenseVoice、VAD 与标点 Worker

```sh
node --experimental-vm-modules scripts/benchmarks/run-sensevoice-production.mjs dist /absolute/path/cases.local.json /absolute/path/results.json
BENCHMARK_DECODING=text CASES=zh-clean,zh-fast,zh-noisy-digits,zh-with-pause SKIP_CACHE_CHECK=1 node --experimental-vm-modules scripts/benchmarks/run-sensevoice-production.mjs dist /absolute/path/cases.local.json /absolute/path/retry.json
```

脚本执行实际 Vite 构建产物和 WASM，不使用原生推理替代。HTTP、Cache API、Worker 消息传输在 Node VM 中模拟；这不是手机浏览器 UI 测试。记录实际输出、CER/WER、文件哈希和缓存复用。参考答案只参与推理后评分。`process_rss_mib` 包含同进程多个模拟 Worker、测试缓存及下载缓冲，不是浏览器标签页或手机内存测量。

## v0.5.1：真实中英文采访

见 [MELI 固定输入和许可](../../docs/benchmarks/MELI_INTERVIEWS.md) 与 [采访实验](../../docs/INTERVIEW_VALIDATION.md)。

```sh
python scripts/benchmarks/prepare-meli-interviews.py --output-dir /absolute/outside-repo/meli
python scripts/benchmarks/prepare-meli-interviews.py --output-dir /absolute/outside-repo/meli --holdout
SKIP_CACHE_CHECK=1 BENCHMARK_DECODING=text node --experimental-vm-modules scripts/benchmarks/run-sensevoice-production.mjs dist /absolute/outside-repo/meli/cases.local.json /absolute/outside-repo/meli/retry.json
```

默认识别省略 BENCHMARK_DECODING；中文/英文应分别选择产品对应模型。现有 Whisper 运行器通过 BENCHMARK_DECODING=text 调用真实英文重试；text和timestamps均保留30秒/5秒，20秒/3秒候选因一段采访退化而未采用。媒体和参考清单不要提交；公开结果记录参考SHA、实际输出、模式和模型指纹，MELI标点不评分。顺序运行大模型以避免测试容器并行内存耗尽，不把退出137记为识别错字。

## 新增五位受访者：地区语言与英语学习背景

`prepare-meli-interviews.py --accent` 是独立预设，默认四例和 `--holdout` 两例保持不变。它准备五位此前未用受访者的自然采访回答，总计 **125.3329375 秒**；三个英文片段、两个中文片段。预设名称用于组织实验，**不代表已经人工评定为明显或重口音**。

| 固定样本 | 语言 / 时长 | 可核实的公开语言背景 | 官方音频 / TextGrid ID |
|---|---|---|---|
| meli-accent-f02a-en | 英文 / 35.5074375 秒 | 普通话1岁、英语3岁开始，属于早期双语者 | 1115810 / 1115835 |
| meli-accent-m01a-en | 英文 / 21.943875 秒 | 从小使用普通话与山西话，英语13岁开始 | 1115877 / 1115795 |
| meli-accent-f02b-zh | 中文 / 21.5330625 秒 | 从小使用普通话与河南话 | 1116033 / 1116009 |
| meli-accent-m01b-zh | 中文 / 19.3924375 秒 | 从小使用普通话与徐州话 | 1115898 / 1115899 |
| meli-accent-f89a-en | 英文 / 26.956125 秒 | 普通话0岁、英语8岁开始 | 1115802 / 1115833 |

来源为 Suyuan Liu、Molly Babel（University of British Columbia）的 [MELI 1.2](https://doi.org/10.5683/SP3/5WMRUO)（2026-10-07发布）；参见[官方论文](https://aclanthology.org/2026.lrec-1.468/)、[录音与声道说明](https://borealisdata.ca/api/access/datafile/1115444)、[人工校正流程](https://borealisdata.ca/api/access/datafile/1115404)与[语言背景表](https://borealisdata.ca/api/access/datafile/1115395)。上表每个文件的固定下载地址是 `https://borealisdata.ca/api/access/datafile/<ID>`。

最初选样顺序为 F02A、M01A、F02B、M01B；先固定参与者，再按官方 `Interview` 标记枚举由采访者发言分隔的完整回答，排除含 `xxx`、`@` 或 `[REDACTED]` 的整个回答，去掉首尾只有非语音的标注区间，取首个18–40秒回答。内部停顿、口头语和重复保留。发现F02A属于早期双语者后，仅依据语言背景追加F89A，使集合包含两位明确后学英语的受访者；**没有替换原四例，也没有按识别结果、RMS或录音质量挑选**。选择顺序、选样前冻结时间、全部原始区间和SHA256写入脚本。

英语学习年龄可支持“后学英语”分类，但不能单独判定具体口音强度。河南话、徐州话背景也不能直接证明这两段普通话“口音明显”。这些是自然采访候选，不是经过口音强度听审的重口音数据集。

### 获取与复现

固定PCM生成环境为Python 3.12、NumPy 2.3.5、SciPy 1.17.0。音频、标注和生成的清单必须放在仓库之外：

```sh
python -m pip install numpy==2.3.5 scipy==1.17.0
python scripts/benchmarks/prepare-meli-interviews.py --output-dir /absolute/outside-repo/meli-accent --accent
```

输出 `accent.local.json`，使用与现有运行器相同的 `.cases` 格式，并记录参与者、来源、语言背景及其校验值。`--accent`、`--accent-final`、`--merge-holdout` 与 `--holdout` 互斥。仅检查参数、不下载或写文件：

```sh
python scripts/benchmarks/prepare-meli-interviews.py --output-dir /absolute/outside-repo/meli-accent --accent --dry-run
```

缓存已有五份原始TextGrid、五份 `*-source-range.wav` 和 `MELI_metadata_LBQ.tsv` 时，可完全离线重新生成PCM：

```sh
python scripts/benchmarks/prepare-meli-interviews.py --output-dir /absolute/outside-repo/meli-accent --accent --offline
```

若要在另一新目录验证复现，将上述**原始缓存**复制过去即可；不必复制已生成的 `.f32`。脚本将从原始音频范围重新计算PCM，核对每例PCM与规范化参考SHA。现有缓存损坏、上游标注变更或处理产生不同字节会明确失败，不能为让实验通过而改哈希。首轮下载通过HTTP Range获取原始WAV的必要区间，不会下载完整数百MB录音；完整原WAV的发布方MD5仍明确标注为本地未验证。

参考来自官方 `utterance-corrected` 层：Whisper-large-v3起稿后经双语研究助理手工校正，不是待测模型输出，也不是纯人工从零起稿。清理只移除非语音与拉丁半词标记；参考仅在推理完成后评分，不送入ASR。片段采用原始左侧受访者声道和44.1kHz→16kHz重采样，不调增益、不降噪、不变速、不拼接回答；因此不验证整场双人转写或说话人区分。原标注省略多数标点，不用它计算标点准确率。

所有MELI媒体、完整标注、参考全文与语言背景表继续适用 **[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)**，不是项目MIT许可。生成数据只留在本地实验目录，不提交GitHub、不上传远程ASR。仓库仅提供获取方法、固定ID/哈希和必要来源说明；对外发布数据衍生内容须保留相应署名和许可。本节不包含任何识别实验结果。

### 独立最终留出：两位后学英语者

上述 `--accent` 五例后来已用于开发与诊断，**不能再称为30秒窗口守卫的最终未参与调参留出**。在规则“只有实际音频范围超过30秒才缩短解码窗口，≤30秒保持原单窗”冻结后，另外独立选定F94A、M99A两位此前未用受访者，作为该规则的最终留出。选定时尚未查看这两例推理结果；没有更换之前任何样本。本节只说明数据划分与复现，不宣称识别实验通过。

| 固定最终样本 | 原录音区间（秒，未取整） | 最终PCM时长 | 官方音频 / TextGrid ID |
|---|---|---:|---|
| meli-accent-final-f94a-en | 332.0182927729368–374.99190106798557 | 42.973625 秒 | 1115800 / 1115858 |
| meli-accent-final-m99a-en | 199.93480489777647–238.32363111692334 | 38.388875 秒 | 1115805 / 1115839 |

合计81.3625秒。两人公开元数据均记英语6岁开始。选择顺序预先固定为F94A → M99A：按原始语言背景表顺序，在此前未用且英语开始年龄≥6岁的参与者中选前两人；仍在官方 `Interview` 区间内，按前述完整回答规则，取首个30–45秒的合格回答，保留内部自然停顿。未读取ASR结果，也未按RMS或录音质量挑选。声学口音强度仍未单独分级。

```sh
python scripts/benchmarks/prepare-meli-interviews.py --output-dir /absolute/outside-repo/meli-final --accent-final
```

输出 `accent-final.local.json`。`--accent-final`、`--accent`、`--merge-holdout`、`--holdout` 四个开关互斥；默认四例、中文holdout两例及accent五例的样本、区间和哈希均保持不变。

已经缓存这两份TextGrid、两份原始立体声范围WAV和同一份语言背景TSV时，可以离线重新计算并验证：

```sh
python scripts/benchmarks/prepare-meli-interviews.py --output-dir /absolute/outside-repo/meli-final --accent-final --offline
```

`--dry-run` 可检查固定区间而不下载或写文件；与前一预设一样，复制原始缓存到新目录后不复制 `.f32`，即可验证从头重算的PCM与参考SHA是否一致。所有来源、许可、参考仅后评分、声道与标点边界沿用前文；媒体与参考清单不进入Git。若以后根据最终两例的结果继续调整策略，须明确把它们改记为开发/诊断数据，不能继续宣称它们未参与调参。

### 合并候选的独立留出：F95A / F96A

`--merge-holdout` 另准备两位未出现过的英语受访者，**仅用于闭合正文的窗口合并候选验证**。它与前7例用途不同：前5例已用于开发与诊断，F94A / M99A 两例只针对之前的30秒时长守卫；不能用这7例代替新的合并候选留出，也不能把本预设的存在当成候选通过证明。

| 固定样本 | 原录音区间（秒，未取整） | 最终PCM时长 | 官方音频 / TextGrid ID |
|---|---|---:|---|
| meli-merge-holdout-f95a-en | 1181.0242999510554–1221.4004798838896 | 40.3761875 秒 | 1115826 / 1115797 |
| meli-merge-holdout-f96a-en | 281.74797480907495–315.7377744305617 | 33.9898125 秒 | 1115791 / 1115834 |

合计74.366秒，来自同一 MELI 1.2 官方语料，下载地址仍为 `https://borealisdata.ca/api/access/datafile/<ID>`。在查看这两人的推理结果之前，先排除此前全部12位受访者、13段录音，再按固定语言背景表顺序选英语开始年龄≥6岁的前两人 F95A → F96A（分别6岁、12岁开始）。沿用首个30–45秒完整连续回答的筛选规则，仅排除含不完整或隐私隐藏标记的整段回答，不按RMS、音质或ASR表现选择，不替换旧样本。实际口音强度仍未分级。

参与者冻结文件 SHA256 为 `28784cd641b26beb5884be4d2623c583f53d846849e2e0d45dcdc4f942e88b78`，音频下载前的区间选择文件 SHA256 为 `ef98347cc7daf51a170013801c56bd5a2125372d25e13137001afe03a27784a5`；原始评测清单 SHA256 为 `7917753ec04a6e1ead6b7e12cf6a9dad3c91cbe633bdd7ceca9ce6fc8678331b`。脚本固定两例 TextGrid、源音频范围、最终PCM和规范化参考SHA。新脚本清单会增加复现说明，因此不要求清单JSON字节与最初临时清单相同，要求每例PCM与参考SHA完全一致。

```sh
python scripts/benchmarks/prepare-meli-interviews.py --output-dir /absolute/outside-repo/meli-merge --merge-holdout
```

输出 `merge-holdout.local.json`，仍为标准 `.cases` 格式；该开关与其他三个预设互斥。缓存两份TextGrid、两份 `*-source-range.wav` 和 `MELI_metadata_LBQ.tsv` 后，可以使用新目录离线重算：

```sh
python scripts/benchmarks/prepare-meli-interviews.py --output-dir /absolute/outside-repo/meli-merge --merge-holdout --offline
```

`--dry-run` 只检查参数和固定区间。依赖、左侧受访者声道、重采样、哈希失败处理、标点N/A、参考仅推理后评分及 **CC BY-NC-SA 4.0** 许可均与上文相同；媒体、完整标注和参考全文只保留本地。此预设不改变默认4例、`--holdout` 2例、`--accent` 5例或 `--accent-final` 2例。若后续根据这两例结果调参，应改记其为开发/诊断用例，不再声称独立未参与调参。

## 编译后的 Whisper Worker

`npm run build` 后，可直接运行实际 Vite Worker 与真实 WASM（传输与 Cache 仍是 Node VM 替身）：

```bash
BENCHMARK_MODEL=Xenova/whisper-small BENCHMARK_DECODING=timestamps \
node --experimental-vm-modules scripts/benchmarks/run-compiled-production-wasm.mjs \
  . /tmp/meli/cases.local.json /tmp/meli/compiled-results.json
```

只读观察器会记录进入真实解码器的 tokens、stride 和返回值；参考仅在推理完成后评分。`BENCHMARK_RAW_DIAGNOSTICS` 与 `BENCHMARK_EXPECTED_REPLAY` 可选地接收本地观察/回放 JSON 做逐值检查，不作为模型输入。运行前一次只启动一个模型进程。本轮 F00A 的构建产物验证与限制见 [口音报告](../../docs/ACCENT_VALIDATION.md)。
