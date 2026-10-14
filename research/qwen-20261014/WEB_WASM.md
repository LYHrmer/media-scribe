# 官方 Web WASM 复现工具

此工具在浏览器形态的 Node VM 中运行真正的官方 WebAssembly，实现与 native Python runner 不同。它不包含浏览器界面、手机、文件选择、音视频解码或线上下载可用性测试，也不改变产品默认模型。

本轮已封版：2048/512短句与fresh长句成功，但连续测试仅完成8/31例；1280/512在同一顺序下仅完成10/31例，第11例 `meli-m00a-zh` abort。两种协议均未通过连续稳定性验收。8→10是执行完成数，不是准确率提升；容量证明未解决生命周期/工作区边界，确切abort原因未知，不能声称已确诊OOM。**本轮不再推理、不接入生产。** 依据与未来接入约束见 [BROWSER_READINESS.md](BROWSER_READINESS.md)。

## 准备固定资产

本轮使用 Node v24.19.0、Python3.12.14。JS runner没有 npm 依赖；Python下载器只用标准库。下列命令从本研究包目录执行：

```bash
cd research/qwen-20261014
python3 scripts/download-qwen-web-runtime.py
python3 scripts/download-qwen-int8.py
mkdir -p results
```

第一条下载官方 `sherpa_onnx_web 1.13.8` 的4,351,745字节归档，验证归档SHA-256后，仅提取精确白名单的三个普通文件，并再次校验各文件大小和SHA-256。不运行包内安装脚本。第二条下载固定revision的Qwen0.6B INT8，模型和tokenizer共987,015,347字节。下载器不接触用户媒体，也不启动WASM或ASR。

可改用已经取得的官方归档，仍必须匹配同一哈希：

```bash
python3 scripts/download-qwen-web-runtime.py \
  --archive /absolute/path/sherpa_onnx_web-1.13.8.tar.gz
```

`--output-dir`可指定runtime目录；默认是本包`web-runtime/`。来源与文件指纹见 [WEB_RUNTIME_PROVENANCE.json](WEB_RUNTIME_PROVENANCE.json)、[WEB_PACKAGE_PROVENANCE.json](WEB_PACKAGE_PROVENANCE.json)。runtime来源记录的`prepared_only`状态描述下载器的资产准备过程，不覆盖独立实验报告的实际执行状态。

## 先校验，不启动模型

按主README准备自己的16kHz单声道float32 PCM，以及不含参考答案的七字段输入清单`data/cases.local.json`。不要将歌词答案、字幕、期望输出或其他参考字段放进清单。

```bash
python3 scripts/download-qwen-web-runtime.py --verify-only
node --check scripts/run-qwen-web-wasm.mjs
node --experimental-vm-modules scripts/run-qwen-web-wasm.mjs \
  --cases data/cases.local.json \
  --output results/web-preflight-unused.json \
  --model-dir models/qwen3-asr-0.6B-int8 \
  --runtime-dir web-runtime \
  --verify-only
```

最后一条在创建VM/WASM前退出，核验6个模型文件、3个runtime文件及PCM哈希，不创建指定的结果文件。

## 显式运行资源诊断

原始2048/512与降低KV的1280/512必须用不同的输出路径。runner不自动读取协议，默认仍是2048/512，因此派生实验必须明确传参：

```bash
node --experimental-vm-modules scripts/run-qwen-web-wasm.mjs \
  --cases data/cases.local.json \
  --output results/web-kv1280-new-run.json \
  --model-dir models/qwen3-asr-0.6B-int8 \
  --runtime-dir web-runtime \
  --max-total-len 1280 --max-new-tokens 512 \
  > results/web-kv1280-new-run.log 2>&1
```

此runner会覆盖同名输出；每次使用新的文件名，并保留失败日志。它没有续跑参数，异常退出不算完成。`--repeat 2`是在同一recognizer内重复整份输入，不能计作新录音或新说话人。内存有限的机器上应与其他模型串行运行。

1280容量证明仅覆盖本轮31段、最长42.973625秒、固定tokenizer、显式Chinese/English及空hotwords。协议对每个输入保守预留额外100个Mel帧后，最坏上下文加512生成token只需1102位置；1280尚余178。该100帧是分析余量，未对音频添加静音。其他音频/模板必须重新核算，不能照搬1280保证任意时长。

降低KV只是资源诊断，不是修改识别文字：持久KV从448MiB减至280MiB，WASM本体2GiB上限不变。容量足够不保证连续稳定，也不保证512个生成token内达到EOS。不能在两套协议输出中逐例挑选较好文字。

## 输出含义与限制

- 报告包含固定资产、runner和输入清单哈希，真实C API版本、阶段、堆内存、Node RSS、耗时及失败；没有将native结果填进Web报告。
- 网络请求被VM拒绝；推理只读取已校验的本地PCM，不接受参考答案或远程媒体URL。
- `text`和`tokens`来自Sherpa引擎。固定版本含末64token低多样性重复保护，不是完整、未经处理的生成轨迹。
- 当前短句/长句结果的时间数组为空。仅有token不代表逐字时间，不能直接宣称支持精确字幕对齐。
- 实验输出可能包含完整媒体文字和本地路径，保存在已忽略的`results/`；不要随代码强制提交模型、媒体、参考或完整结果。

这些脚本没有接入生产Worker。1280最终失败报告SHA256为 `7504ed0e98f1fe9bb6c5b55b71e94092eb79818250afa0f81790df485894bd55`，失败时WASM堆2,147,483,648 B、进程RSS2,402,598,912 B。首次约1GB下载、连续内存行为、手机支持和真实浏览器的取消/恢复仍未满足发布验收。
