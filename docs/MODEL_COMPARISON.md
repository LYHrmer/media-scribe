# Whisper 模型对照（真实浏览器 bundle + ONNX WASM）

相同输入 PCM、相同 16 kHz 处理、同一个生产 Worker 生成选项、相同 WASM 和浏览器 bundle。Small q4f16 与 Tiny q8 为生产支持的路径。Base q8 仅在 scratch 扩展模型允许名单与对应文件路径，Small q8 消融仅改 dtype / ONNX 精确文件名，不冒充已部署功能。参考文本只在推理完成后评分。

| 用例 | Small q4f16 部署基线 | Tiny q8 部署引擎 | Base q8 实验 | Small q8 量化消融 |
|---|---:|---:|---:|---:|
| zh-clean | 0.0% | 7.7% | 46.2% | 0.0% |
| zh-fast | 100.0% | 100.0% | 35.4% | 99.2% |
| zh-noisy-digits | 100.0% | 522.6% | 535.8% | 98.1% |
| user-lyrics | 100.0% | 2509.1% | 未跑 | 未跑 |
| noise | 错误捏造文字 | 错误捏造文字 | 未跑 | 未跑 |

分数为严格字符错误率 CER（不含标点、保留繁简与数字格式），不是准确率。重复输出会使 CER 超过 100%。Base clean 的输出只有一个新增 於，其余严格差异为繁简字；把 46.2% 当成语义错误比例会误导。Tiny clean 新增 于；该处是真实词语插入。标点与数字等价评分保留在各个原始结果 JSON。

Tiny 在快速中文和噪声中文也出现大幅幻觉 / 重复，不能用“更轻”的模型替换来宣称准确性问题已修复。Base 对快速中文有所改善但仍有许多词错，号码用例仍严重重复。不同模型大小的比较不能单独证明 Small q4f16 量化是原因。同一个 Small 升级到 q8 后，快速中文和噪声中文仍分别达到 99.2% 与 98.1% CER，说明只把 q4f16 换成 q8 仍不足以修复这些失败。

## 复现与文件

- Small q4f16 部署基线：`results-small-production.json`，完成；源文件、bundle、WASM SHA-256 均在结果内。
- Tiny q8 部署引擎：`results-tiny-production.json`，完成；源文件、bundle、WASM SHA-256 均在结果内。
- Base q8 实验：`results-base-wasm.json`，完成；源文件、bundle、WASM SHA-256 均在结果内。
- Small q8 量化消融：`results-small-q8-wasm.json`，完成；源文件、bundle、WASM SHA-256 均在结果内。

完整 Small 11 用例来源、错误文本、标点和时间轴核查见 `ACCURACY_BENCHMARK.md`。没有增加下载的新模型；所有候选权重来自已经保存在 scratch 的原缓存。用户视频和全部音轨不提交 Git。

## 原生引擎对照（不是浏览器发布或耗时比较）

另一组诊断使用同一 PCM 和同一后评分规则，运行 sherpa-onnx 1.13.8 原生 CPU、2 线程。SenseVoice / Paraformer / Qwen 的原始输出见 `benchmarks/results-native-alternatives-scored.json` 与 `benchmarks/results-native-qwen-scored.json`。快速中文的严格 CER 分别为 17.7%、15.4%、13.1%，明显优于当前 Small WASM；但嘈杂号码和无语音负例仍有问题。原生耗时不能代替浏览器或手机的速度验证。SenseVoice 的英语对照强制使用中文语言配置，结果已标记无效，不能用于英语排名。

Qwen 嘈杂号码结果出现提供方参考中未收录的额外文字；未人工核验录音前，不能断言它全部是幻觉，保留自动评分与这项参考不完整的可能性。
