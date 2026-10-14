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
