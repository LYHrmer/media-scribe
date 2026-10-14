# Qwen3-ASR 浏览器可行性检查（2026-10-14）

状态：本轮已封版。真实 Web WASM 短句及fresh长句可运行，但2048/512连续测试仅完成8/31例，1280/512仅完成10/31例，两次均abort。降低KV未解决连续稳定性，确切abort原因未知；本轮不再推理、不接入生产。此检查代理只做来源/容量审查和工具准备，实际推理由root串行执行。

本记录区分三件事：官方原生 CPU 实验、浏览器形态 Node VM 中的真实 WebAssembly 推理，以及真实浏览器/手机端端到端测试。前两者均不能冒充第三者。

## 现有生产 runtime 不能直接加载 Qwen

`scripts/prepare-sensevoice.mjs` 使用固定 HF Space revision：

https://huggingface.co/spaces/k2-fsa/web-assembly-vad-asr-sherpa-onnx-zh-zipformer-ctc/tree/9d5fc71d88ab1222ed1af2274fb194592af48455

该脚本移除演示程序的 Zipformer 预加载、增加 ESM 包装、对同一模型和 WASM 做无损 gzip 传输；它不增加新的模型实现。

| 当前文件 | 实际检查 |
| --- | --- |
| `public/models-sensevoice/asr.mjs` | 47,422 B；无 `qwen3Asr` 配置，SHA256 `6686bf26631572b161fc2b6532302d8eeda91a774c32f3216eced57ec5769ff2` |
| `public/models-sensevoice/runtime.mjs` | 90,654 B；`getHeapMax=2147483648`，SHA256 `3a7e50f11a449f4b9fd2b9373fbb3f16fd487cce804ae6f51241d72c5f0dbcbe` |
| `.cache/sensevoice/sherpa.wasm` | 11,722,172 B；没有 qwen/Qwen 字符串，SHA256 `e4dead1d159c531282e635069fa9e028175dee71f3f90908186994655425b3ce` |

没有给现有 Worker 添加 Qwen 选项，也没有替换它的 API 或 WASM。匹配的 API JS、runtime JS、WASM 必须成套使用。

## 可取得的官方 Web runtime

包：`sherpa_onnx_web 1.13.8`。其 pubspec 指向官方 `k2-fsa/sherpa-onnx` 仓库，发布日期为 2026-09-11。包内包含通用 WebAssembly runtime，不需要运行 Flutter 才能使用其中的 JS/C API。

- 版本元数据：https://pub.dev/api/packages/sherpa_onnx_web
- 包版本页：https://pub.dev/packages/sherpa_onnx_web/versions/1.13.8
- 固定归档：https://pub.dev/api/archives/sherpa_onnx_web-1.13.8.tar.gz
- 归档大小：4,351,745 B。
- 归档 SHA256：`e25a3813eb080636280b23dd4b0098252902675158b66dceda1efba061adf5d7`。

已保存并验证归档为 `web-runtime/sherpa_onnx_web-1.13.8.tar.gz`，仅按精确成员名提取下列三个文件，未运行第三方安装脚本。

| 原归档成员（当前存于 `web-runtime/`） | 字节 | SHA256 |
| --- | ---: | --- |
| `assets/sherpa-onnx-wasm-web.js` | 93,039 | `28f909145d93018c90c181035a008880ceaa94a72b66603dc7bb7c619714c23c` |
| `assets/sherpa-onnx-wasm-web.wasm` | 15,133,855 | `e0d84744c39a28121f7738a161a21612788f4e8f07879a7224e74919e9831573` |
| `assets/sherpa-onnx-asr.js` | 53,867 | `d51ae8e8b756ee5e53423ffada0c9702973f154f561aca7984fe0b12f4060178` |

机器可读来源记录见 `web-runtime/provenance.json`。实际 `.wasm` 包含 Qwen 实现字符串，匹配的 `asr.js` 包含 `initSherpaOnnxOfflineQwen3AsrModelConfig`、`qwen3Asr` 配置和离线 `stream.setOption` API。

配置支持 `convFrontend`、`encoder`、`decoder`、`tokenizer`、`maxTotalLen`、`maxNewTokens`、`temperature`、`topP`、`seed`、`hotwords`。应使用 16 kHz、128 维特征。语言由 `stream.setOption('language', 'Chinese'/'English')` 指定；不向模型提供参考答案。

这不代表 Transformers.js 3.8.1 支持 Qwen3-ASR，也不代表普通 Qwen 文本模型的 WebGPU 示例能识别音频。

## 实际内存上限证据

对已验证的 `.wasm` 按 WebAssembly 二进制格式解析 section 5（memory section），得到一块非共享 memory：

```json
{"flags":1,"initial_bytes":536870912,"maximum_bytes":2147483648}
```

即初始 **512 MiB**、最大 **2 GiB**。匹配 runtime JS 同时包含 `getHeapMax=2147483648`。这不是根据 native RSS 推测的限制。

Qwen0.6 INT8 模型和 tokenizer 另需 987,015,347 B。2048 长度 KV 缓存约 448 MiB；仍需额外考虑下载 ArrayBuffer、MEMFS、ORT 权重及工作区。当前 native 结果不能证明这些数据在 2 GiB WASM 堆中能稳定执行。即便短样本成功，也须检查长样本、多次连续运行和终止/重试后的资源释放。不要同时保留多个大型 ASR/OCR Worker。

若堆上限不足，只修改 JS 中的数字无效，因为 WASM 本体 memory section 也有限制。正式重建需要固定源码及编译工具，并共同生成匹配 JS/WASM。

## 官方重建路线（未执行）

- 固定 Sherpa 源码版本：`v1.13.8`。
- 官方脚本推荐 Emscripten **4.0.23**。
- 构建入口：https://github.com/k2-fsa/sherpa-onnx/blob/v1.13.8/build-wasm-simd-web.sh
- Web 目标：https://github.com/k2-fsa/sherpa-onnx/blob/v1.13.8/wasm/web/CMakeLists.txt
- 公共链接标志：https://github.com/k2-fsa/sherpa-onnx/blob/v1.13.8/wasm/wasm-common.cmake
- 配套 JS API：https://github.com/k2-fsa/sherpa-onnx/blob/v1.13.8/wasm/asr/sherpa-onnx-asr.js

脚本启用 `SHERPA_ONNX_ENABLE_WASM_WEB=ON`、C API，关闭 Python/GPU/PortAudio 等。默认公共标志为 `INITIAL_MEMORY=512MB`、`ALLOW_MEMORY_GROWTH=1`，未设置更大 `MAXIMUM_MEMORY`。需要更大堆时应记录加入 `-sMAXIMUM_MEMORY=4GB` 的源码差异并重编译，之后再次读取真实 memory section。当前未下载 Emscripten、编译或修改这些上游文件。

## 隔离实验 runner 与已保留的执行证据

`scripts/run-qwen-web-wasm.mjs` 使用三件套真实字节和匹配 API，在无 `process` 的浏览器形态 Node VM 中加载实际 WASM。仅增加 ESM 导出，不修改推理实现。输入为严格白名单、无参考字段的 PCM manifest，网络函数一律拒绝请求。模型和输入先做 SHA256 检查，报告记录实际 runtime 版本、源文件哈希、WASM 堆大小、Node 进程 RSS、Sherpa 引擎返回输出、耗时及失败阶段。模型初始化或推理失败不会被记为完成。

**输出语义限制：** 固定 Sherpa 1.13.8 的 Qwen 实现自带重复保护：当末尾 64 个 token 的种类过少时，它会停止解码并删除该低多样性尾部。因此 API 返回的 `text` / `tokens` 是引擎处理后的结果，不能叫作完整模型生成 token 或未经处理的声学输出。runner 在顶层及每例中明确标记了这点，保留引擎日志，不自行补回或清理返回内容。源码：https://github.com/k2-fsa/sherpa-onnx/blob/v1.13.8/sherpa-onnx/csrc/offline-recognizer-qwen3-asr-impl.cc 。

已完成 `node --check` 和 `--verify-only`。8 段参考隔离输入、6 个模型文件、3 个 runtime 文件均通过哈希检查。`--verify-only` 在创建 VM/WASM 前退出，没有产生推理结果。

已从既有 `data/controls-inference.json` 按固定 ID `zh-clean` 制作单例 `data/web-zh-clean-smoke.json`，选择依据为已存在的清晰短句对照，不根据本轮模型输出选择。该文件只含同一 PCM、SHA 与语言，不含参考文本。以下为复现命令示意，必须使用新的输出名，不能覆盖已保存的成功/失败报告：

```bash
cd research/qwen-20261014
node --experimental-vm-modules scripts/run-qwen-web-wasm.mjs \
  --cases data/web-zh-clean-smoke.json \
  --output web-qwen-zh-clean-smoke-new-run.json \
  --model-dir models/qwen3-asr-0.6B-int8 \
  --runtime-dir web-runtime \
  --max-total-len 2048 --max-new-tokens 512
```

`--repeat 2` 可在后续阶段验证同一 recognizer 连续重用；不自动将该测试算作新的独立录音样本。控制模型初始化和推理的只有 root，不与 native 模型并行。

## 补充审查：MEMFS、输入缓冲与释放边界

实际官方 runtime 的 `MEMFS.stream_ops.write` 对 `canOwn=true`、且输入不是 WASM heap 的 typed array，执行 `node.contents=buffer.subarray(offset,offset+length)`。因此本 runner 的 `FS.createDataFile(..., true, false, true)` 挂载模型时共享 JS ArrayBuffer，**不会仅因为挂载就再复制完整模型到 WASM 线性堆**。这不代表 ORT 创建 session 或执行推理没有内部堆内副本。

原写法 `new Uint8Array(await fs.readFile(...))` 会先取得 Node Buffer，再逐字节复制为新的 JS typed array。按照 root 在首次 WASM 推理前的授权，已仅将模型挂载改为共享视图：

```js
const sourceBuffer = await fs.readFile(filename);
mountedModelBuffers.push(sourceBuffer);
const bytes = new Uint8Array(
  sourceBuffer.buffer, sourceBuffer.byteOffset, sourceBuffer.byteLength,
);
```

`mountedModelBuffers` 明确保留 Node Buffer，直到同步 `OfflineRecognizer` 构造结束。之后对所有模型文件调用 `module.FS.unlink` 并清空该数组。该修改消除挂载准备时最多约 755.9 MB 的 decoder 源缓冲重复；没有改权重、特征、生成参数或 WASM 内存上限。GC何时回收、RSS是否立即下降不能保证。

共享视图修改后的历史 runner SHA256：`cd0370816788efa314a26f987c1e6378732cc832647f98e43a31420888b4c135`。首次执行随后暴露配置 TypeError；补齐同版官方配置默认值后的当前 runner SHA256 为 `51433db6d36340339124e61d134e700f0291f9e444701c6031ffea79d599025b`，`node --check` 已通过。推理实现和参数未因配置修复改变。

正式可用的释放动作与边界：

| 动作 | 有效范围与条件 |
| --- | --- |
| `FS.createDataFile(..., canOwn=true)` | 在当前输入为堆外 typed array 时避免 MEMFS 再复制；调用后不能修改或转移该 ArrayBuffer |
| `FS.unlink(path)` | 同步模型构造成功后移除本模型文件的 MEMFS 引用；当前0.6导出不需要额外外部 `.data` 权重文件 |
| 删除JS强引用 | 清空 `mountedModelBuffers`、本地下载缓存引用；只允许GC回收，不能承诺马上归还物理内存 |
| `stream.free()` | 每段结束后释放该 stream 的 C 对象；runner已有 `finally` |
| `recognizer.free()` | 不再复用识别器时释放三个 ORT session 等 C 对象；不得在 decode 尚未完成时调用 |
| `Worker.terminate()` | 真浏览器产品终止/重置时释放该 Worker 的整个 WASM 实例；VM runner退出Node进程是类似的测试隔离边界，不能冒充浏览器已验证 |

`FS.unlink` 不会缩小已增长的 WebAssembly.Memory，也不能消除模型构造内部发生过的峰值。官方 Qwen模型 C++ 构造器按路径顺序创建 conv、encoder、decoder 三个 `Ort::Session`；构造完成后再删除这份 MEMFS 输入是当前安全边界，不能在构造仍读取文件时提前删除。

以下不应作为低风险补救：提前 unlink、清空/转移仍由MEMFS使用的ArrayBuffer、手工 `_free` 由ORT拥有的权重、关闭保护后复用越界内存、只修改JS `getHeapMax`、将任意模型挂到 `Module.MountedFiles` 并假定它会自动绕过MEMFS。`MountedFiles` 的代码只证明存在外部数据读取桥，当前runner没有采用该路径，也未证明当前嵌入式ONNX文件能从中受益。`FS.createLazyFile` 会引入同步XHR/Range与额外生命周期，不是这里已验证的本地替换方式。

模型加载源码：https://github.com/k2-fsa/sherpa-onnx/blob/v1.13.8/sherpa-onnx/csrc/offline-qwen3-asr-model.cc 。

## 补充审查：上下文容量的最小条件

下列公式来自固定 Sherpa 1.13.8 的 `FeatToAudioTokensLen`、`BuildSourceIds` 和 `GenerateText`，不读取参考答案，不依据转写效果调整参数。

设 `F` 为特征提取器实际生成的128维Mel帧数。导出前端以100帧为块，每块经三次stride=2卷积。预期音频token数量为：

```text
A(F) = 13 * floor(F / 100) + ceil((F mod 100) / 8)
```

余数为0时第二项为0。实际源码再取预期值与conv输出帧数的较小者，之后可能裁去没有有效内容的尾部特征；估计容量时使用未裁剪的 `A(F)`，不要借裁剪减少预算。这里的 `F` 应由相同特征流程取得，不能将示例中的整秒帧数视为任意输入的精确值。

设 `B` 是音频前prompt的token数，`E` 是音频后prompt和显式语言前缀的token数，`a` 是 `<|audio_pad|>` 编码长度，则prefill上下文长度：

```text
C = B + a*A + E
M = min(导出模型允许的KV长度, max_total_len参数)
```

本0.6导出的KV维度为动态，模型本体不会将参数再固定为512。只为核对固定模板做了无神经网络的tokenizer计算：官方HF tokenizer的普通词表与Sherpa导出的 `vocab.json` 全部一致；空热词模板 `B=9`，音频后固定模板6个token，显式English/Chinese各2个token，再加 `<asr_text>`1个token，因此本协议 `a=1`、`E=9`、`C=A+18`。自动语言不加显式前缀，对应 `C=A+15`。这些数值不应用到其他热词、其他模板或其他tokenizer版本。

- **不截音频的最低条件：** `C <= M`。否则此版本源码会截断音频placeholder和audio_features。
- **允许生成最多G个token而不因KV容量提前退出：** `C + G - 1 <= M`。原因是prefill直接给出第一个token，后续每步才把前一个生成token写入KV。
- **易检查的保守预算：** `M >= C + G`，多留一个slot。`G`需同时覆盖文字、标点、自动语言标签及结束token；是否真的到达EOS仍须看引擎停止原因，容量足够不等于识别正确。
- **独立生成上限：** `max_new_tokens`仍会终止输出，不能只增大KV而保持过短生成上限。反之只增大生成上限也不能解决KV耗尽。

例子只说明结构容量，不是音频实测输出：若 `F=3000`，`A=390`、`C=408`，预留512个生成token的保守预算为920；若 `F=4500`，`A=585`、`C=603`，预算为1115。多一个Mel帧可令后一项再增1。因此对于本轮最长约45秒采访，预先冻结的2048/512比512/128有明确容量依据，而非根据答案选择。

当前decoder是28层、8个KV头、每头128维、缓存FP32。因此只计算持久KV张量，不含任何工作区：

```text
KV_bytes = 2 * 28 * M * 8 * 128 * 4
M=512  -> 112 MiB
M=2048 -> 448 MiB
```

该公式只解释基础KV占用，不是Web总峰值内存估算，也不能证明2GiB堆一定够用。

## 历史浏览器证据的缺口

`docs/FAILED_ASR_EXPERIMENTS.md` 和 `results-qwen06-followup.json` 曾提到一次 WEB-WASM 跑通。当前可见仓库中没有能与之对应的 Qwen WASM 指纹、完整 runner、准确率输出或重复运行证据。上述新包是一个可复现的官方候选，不能宣称已恢复或重复了历史执行。


## 2026-10-14 实际 Web WASM 执行记录

执行环境是浏览器形态 Node VM，加载上述未修改的官方 Web WASM，并非 native Sherpa。实际 C API 报告版本1.13.8、Git `8b5a9990`、ONNX Runtime1.28.2；没有发生网络请求。这些结果不包含真实浏览器界面、手机内存、视频解码或网络下载验收。

| 已保留报告 | 协议及结果 | 解释 |
| --- | --- | --- |
| `web-qwen-zh-clean-smoke.json` | 2048/512；构造配置时 TypeError，0例推理 | API第1558行直接将未定义的 `config.tokens` 传给 `stringToUTF8`。修复为明确空字符串并补同版默认值；不是内存失败 |
| `web-qwen-zh-clean-smoke-v2.json` | 2048/512；5.592s输入，5.446s解码，完成1例 | 模型加载后RSS2,462,683,136 B；解码后WASM堆1,748,172,800 B；只能证明该短例实际可运行 |
| `web-qwen-all-v2.json` | 2048/512；原顺序前8例完成，首MELI `meli-f01b-zh` 时abort | 失败前WASM堆已到2,147,483,648 B，但日志没有明确OOM原因，不能直接写成已证实OOM；其余23例未完成，不能算通过 |
| `web-qwen-fresh-long-v2.json` | 新进程、同2048/512；同一25.620625s MELI完成，解码28.019s | 解码后堆达到2GiB；排除“这段长句在此配置一定装不下”的断言，提示连续顺序/资源状态可能相关，尚未确定根因 |
| `web-qwen-all-kv1280-v2.json` | 1280/512；原顺序10/31例完成，第11例 `meli-m00a-zh` 时abort | 失败时堆2,147,483,648 B、进程RSS2,402,598,912 B；1例中止、20例未到达，连续稳定性未通过 |

原始四份成功/失败报告的指纹写入冻结前的 `web-kv1280-protocol-frozen.json`，该协议不因结果改变。1280最终报告SHA256为 `7504ed0e98f1fe9bb6c5b55b71e94092eb79818250afa0f81790df485894bd55`。短句和fresh长句返回的 `timestamps`、`durations`、`words` 均为空；有token不代表有逐字对齐时间。

**最终结论：** 8→10只是不同资源协议下的连续执行完成数，不是准确率提升。容量证明只排除了该上下文预算不足，未解决生命周期/工作区边界；当前日志只有 `Aborted()`，不能确定内存碎片、工作区申请或其他具体原因，不能声称已确诊OOM。该路径本轮不接入生产，也不增加模型运行。

## 1280/512派生协议：不依赖答案的容量证明

`web-kv1280-protocol-frozen.json` SHA256：`a6a15fe96a2b07c7706f4a7cf3d74ee3edabb2906f92487c8ffc74f999edd895`。这是看到连续失败后才设立的资源诊断，使用同31例、同顺序和同一个recognizer；不得算作新的独立测试集，也不在2048和1280输出之间挑更好的文字。

读取全部31个PCM的实际文件字节数，最长为687,578个sample，即42.973625秒。固定官方源码中Qwen使用 `WhisperTag`、128维特征并将 `align_to_stft_center=true`；`offline-stream.cc` 的10ms帧步长为160个sample，`GetFrames()`最多保留 `floor(N/160)` 帧。为保守起见，协议另外加100帧纯分析余量，**没有向音频补任何静音**：

```text
F_bound = ceil(687578 / 160) + 100 = 4398
A_bound = 13*43 + ceil(98/8) = 572
C_bound = A_bound + 18 = 590
C_bound + max_new_tokens = 590 + 512 = 1102 <= 1280
余量 = 178 slots
```

因此1280不会因KV容量裁剪本轮任何音频，且仍预留完整512个生成token。较精确的帧上界更小，但不需要依赖它消耗余量。固定词表、显式Chinese/English、无hotwords是该证明的条件；变更模板/热词或超过本轮时长必须重新计算。生成预算仍可能先于EOS耗尽，不能由容量证明推断准确率。

28层、8个KV头、128维、FP32的持久KV从448MiB降为280MiB，减少168MiB。它没有保证ORT临时工作区、内存碎片或连续运行稳定性。1280全31例的最终报告为失败：只完成10例，第11例abort。因此降低持久KV没有满足连续稳定性的验收条件；容量证明不能当成通过声明。

源码固定URL：
- https://github.com/k2-fsa/sherpa-onnx/blob/v1.13.8/sherpa-onnx/csrc/offline-recognizer-qwen3-asr-impl.cc （SHA256 `d9daad0eafcd066fa088eb06d858ecfd394fef35ce1e6f595ab934e6e5525824`）
- https://github.com/k2-fsa/sherpa-onnx/blob/v1.13.8/sherpa-onnx/csrc/offline-stream.cc （SHA256 `03ec1bbd50ff0a1d7d83bb952ee0d9d4020f49e850af08ea1892158163c98f98`）

## 接入现有产品的最小可靠范围（只读评估，尚未实施）

最终决定：本轮仅保留研究复现工具，不作为可选桌面功能发布，也不替换手机默认模型。以下为未来解决稳定性后才能推进的接入约束，不是本轮实施计划；识别准确率仍须独立评分。最低接入成本不止一个模型下拉选项，还包括以下边界：

1. **单独runtime与资产加载器。** 当前SenseVoice runtime没有Qwen。需要固定官方三件套、新Qwen Worker和对应同源资产清单；6个模型/tokenizer文件为987,015,347 B，加runtime约1.00GB未压缩静态资产。实际gzip传输体积尚未测量。现有SenseVoice加载器限制每文件最多32个16MiB分片，755,914,231 B的Qwen decoder至少需46片，直接复用会拒绝；Whisper加载器也有512MiB上限和模型路径白名单。应为Qwen明确新的已知上限/白名单和逐片SHA校验，不能把全局限制随意取消。
2. **下载与设备门槛。** UI应先显示约1GB首次下载及可取消进度，使用可重试的分片缓存，检查可用缓存配额；配额不足时不应重复下载到崩溃。WASM SIMD和Worker支持只能证明指令能力，不能证明剩余内存。观测到约2.46GB进程RSS与2GiB线性堆已说明手机风险；8GB桌面RAM可作为保守产品建议而非通过门槛，不能用 `deviceMemory` 或UA宣称手机一定可用。真实华为/Android/iOS浏览器仍须实机验证。
3. **只有一个大型模型驻留。** `src/main.js` 已按worker种类切换时terminate，OCR前后也有释放边界，可扩展这个分派到Qwen；不要仅在SenseVoice Worker内另建Qwen session。切换/取消/加载失败后terminate整个Qwen Worker，下一次新建；同步C++ decode不能靠普通postMessage及时中断。模型构造成功再unlink MEMFS，逐段stream.free，保持原稿可恢复。释放recognizer不代表WASM堆收缩。
4. **保留音频和诚实时间轴。** 现有 `splitSenseRanges` 在26–30s附近找安静边界且所有样本恰好覆盖一次，可作为候选分段器，但本轮31例以整段推理，尚未证明分段后不漏字/重复。Qwen返回时间数组为空，初版只能用输入分段的真实起止时间并标明粗略范围；不能将BPE token当逐字时标。精确字幕需要另测对齐器和额外内存，不能假装已经支持。
5. **维持现有人声门控和歌词保护。** 全31的前8例已显示Qwen对静音/噪声生成非空文字，因此仍需 `vad-client.js` 的前置检测；检测完成先终止VAD Worker再加载大模型。现有歌词/未知内容及用户强制识别会保留原音，这一保护不能被强行语音裁切替代。VAD只用于已验证的无语音误报控制，不能作为听不准时删除段落的捷径。歌词画面OCR仍是独立证据流程，不能将字幕或给定答案塞进声学模型评测。

进入生产前最少补做：真实浏览器下载/缓存中断恢复、设备内存失败与取消后重试、长文件连续分段、模型切换原稿保留及分段后的CER/WER回归。这里没有修改任何生产代码。
