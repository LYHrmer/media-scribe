# 本地中文标点模型验证

验证日期：2026-10-13。标点模型只插入标点，保留原文字、大小写、空格、换行及已有标点；不能补回没有识别到的字。

## 模型与可复现裁剪

- 官方模型：[`iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch`](https://modelscope.cn/models/iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch/summary)，模型卡声明 Apache License 2.0。
- [Sherpa 官方 ONNX int8 发布与说明](https://k2-fsa.github.io/sherpa/onnx/punctuation/pretrained_models.html)。原模型 75,519,198 字节，输入 embedding `[272727, 256]` 占 69,818,112 字节。
- 保留原词表全部 8,404 个单 Unicode 字符、长度不超过 3 的 ASCII token 和特殊 token，共 16,292 个 token。只重排 embedding 行和对应词表元数据，其他算子、权重及量化参数不变。
- 裁剪模型 7,637,864 字节，词表 JSON 97,004 字节，合计约 7.38 MiB。`node scripts/prepare-punctuation.mjs` 从官方归档生成，使用系统 `tar`，无需 Python 或新 npm 依赖。
- 官方归档 SHA-256：`c0d5aa5f8eeb686032345e180bedf39319dc2e0556781c6264bcadba8328a6e1`。
- 原模型 SHA-256：`65a3fb9f5ad7bfb96bf69e0dc4481df97f6ee60513c1d94ce981ba6effd524b1`。
- 裁剪模型 SHA-256：`807302f35c81326bd2a0e3f0b1b99077dbd270a9776d22d0b2080bdd6b9c0dae`。

独立 Python ONNX 裁剪和生产构建脚本输出的模型 SHA-256 相同。对 21 组保留 token 输入（长度分别为 1、2、5、13、20、64、200，每长度 3 组），原模型与裁剪模型的全部输出 logits 逐值相同，最大绝对差为 0。该结论只适用于相同、已保留的 token 输入；不表示裁剪前后的英文词表等效。

## 真实 WebAssembly 推理

使用生产标点引擎的浏览器 bundle 和实际 ONNX Runtime Web 1.22 标准 WASM，运行 14 个输入。测试宿主为 Node Worker 风格 VM，模拟 HTTP / Cache API 并映射 WASM 本地路径；这验证了模型与 WebAssembly 推理，**没有验证 Chrome / 华为浏览器 UI 或音视频解码兼容性**。一次初始化加 14 个短输入约 0.36 秒，不能据此承诺手机耗时。

| 输入来源 / 内容 | 实际 WASM 输出与观察 |
| --- | --- |
| 清晰中文音频 ASR：开放时间早上9点至下午5点 | 开放时间早上9点至下午5点。 |
| 同音频低音量 ASR：开放时间早上九点至下午五点 | 开放时间，早上九点至下午五点。 |
| 配乐版本 ASR：開放時間早上9點至下午5點 | 開放時間早上9點至下午5點。 |
| 两次清晰中文 ASR，中间换行 | 两行各补句号，原换行保留。 |
| 独立句：今天下雨了出门的时候记得带伞 | 今天下雨了，出门的时候记得带伞。 |
| 独立问句：请问这趟车几点出发在哪里检票 | 请问这趟车几点出发，在哪里检票？ |
| 步骤说明句 | 正确插入部分逗号和句号；与 Sherpa 的 20-token 流式包装存在一处逗号差异。 |
| 独立句：他说这个方案还需要讨论我们明天再决定 | 他说这个方案还需要讨论，我们明天再决定。 |
| 视频真实 OCR 首句 | 漫天红伞，无人生还。 |
| 视频真实 OCR 后句，缺少“憾” | 仍缺少“憾”；模型插入逗号、句号，不能修复漏字。 |
| 将两段 OCR 强行连接为一句 | 标点不足，不能替代字幕时序分段。 |
| 中文与短英文 API 混合 | 保留 API，正确添加句末问号。 |
| 中文与 OpenAI / Windows 混合 | 原英文保留；裁剪后一个逗号位置与完整词表模型不同。 |
| 纯英语句 | 跳过中文标点处理，原文完全保留。 |

生产包装逐段落处理，窗口上限 200 token，并在长文本窗口边界保留 20 token 右侧上下文。它不复制 Sherpa 的 20-token 流式切分，因此不能把“相同 token 输入的 logits 等效”误写成“所有端到端文本输出相同”。模型预测标点也可能不合语境，需要校对。

随后对实际 Vite 产物 `punctuation.worker-Ch2hTEJS.js` 进行了独立验证：真实 worker 与 WASM helper 均放在没有 Node `process` / `require` 的 Worker 风格 VM 中，模型资源映射到实际 `dist`。5 个断言全部通过：清晰中文补句号、独立陈述句补逗号、问句补问号、保留输入的已有句号、纯英语完全不变。第二个独立 worker 重新校验并复用了 Cache API 中的模型和词表，没有再次请求这两个资源。该轮总耗时约 0.65 秒，仍不是手机浏览器性能数据。

实际产物验证命令（先完成构建）：

```sh
node --experimental-vm-modules scripts/verify-punctuation-wasm.mjs dist
```

脚本自动查找当前构建的 worker 哈希文件名，不依赖上述单次构建文件名。HTTP 和 Cache API 是测试替身，模型字节、SHA 校验、生产 worker 代码、WASM 推理与标点输出均实际执行。

## 内容和故障保护

正文中的新增标点按相同字符边界映射到字幕，保留原时间戳。字符序列不一致时保留原时间轴并提示；不允许通过标点步骤替换、删掉或编造原文字。纯英语不加载模型。

模型资源使用独立 `tingxie-punctuation-v1` Cache API 缓存。目录限定两个文件名、精确字节数和 SHA-256；每次读取缓存也校验摘要。坏缓存先删除，再尝试网络获取；HTML 拦截页、403、内容不完整均不进入缓存。存储权限被拒绝时可以直接下载识别。标点加载或推理失败保留原结果并提示，停止会终止 worker。

相关回归测试：`node --test tests/punctuation.test.mjs tests/punctuation-assets.test.mjs`。这些测试检查内容保护、字幕映射和缓存故障行为；不是语音识别准确率基准。
