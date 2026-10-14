# Qwen3-ASR 研究复现工具

这里保存 2026-10-14 实验使用的下载器、固定协议、原生 CPU/WebAssembly 推理脚本和离线评分器。它们是开发者研究工具，不是浏览器产品的新默认模型，也不是手机端可用性证明。模型、私有媒体、参考答案和完整推理输出均不随仓库提供。

本包仅作代码整理，没有在打包时执行下载或模型推理。文件来源指纹和唯一的路径适配记录见 `PACKAGE_PROVENANCE.json`。`scripts/download-qwen-int8.py` 只将临时机器的绝对下载目录改成相对本包的 `models/qwen3-asr-0.6B-int8`，URL、revision、大小、SHA-256 与下载逻辑不变；其余五个实验文件逐字节复制。

## 环境与目录

以下命令从仓库根目录进入本包运行。脚本当前面向 **Linux、Python 3.12**：原生资源记录依赖 `/proc` 和 cgroup v2，官方推理监督器使用 `fcntl`。没有声称这些研究脚本已在 Windows/macOS 上验证。两种模型使用独立 Python 环境；同一台内存有限的机器一次只运行一个模型进程。

```bash
cd research/qwen-20261014
mkdir -p data results
```

`models/`、`data/`、`results/`、媒体、环境和日志等已排除出 Git；输出仍可能含完整识别文字及本地路径，不应强制加入仓库。

## 准备不含答案的七字段输入

先自行准备具有使用权的 **16 kHz、单声道、little-endian float32、无文件头** PCM，扩展名为 `.f32`。固定采样与处理流程后再比较模型，不能依据识别成绩更换片段或调整音频。若复现 MELI，应遵循实验记录的参与者左声道和重采样方案，不能随意改成双声道混音。

推理清单顶层仅允许 `cases`，每例使用以下七个字段：`id`、`language`、`pcm_path`、`pcm_sha256`、`sample_rate`、`audio_seconds`、`split`。官方 runner 严格要求七字段齐全；原生 runner 拒绝白名单外字段。不得添加 `reference`、提示词、歌词答案、参考字幕或热词。

下面用自己放在 `data/example.f32` 的音频生成清单；这是清单生成示例，没有附带实际音频或答案：

```bash
python3 - <<'PY'
from pathlib import Path
import hashlib, json
pcm = Path('data/example.f32').resolve()
size = pcm.stat().st_size
assert size > 0 and size % 4 == 0
with pcm.open('rb') as handle:
    digest = hashlib.file_digest(handle, 'sha256').hexdigest()
case = {
    'id': 'private-example',
    'language': 'chinese',
    'pcm_path': str(pcm),
    'pcm_sha256': digest,
    'sample_rate': 16000,
    'audio_seconds': size / 4 / 16000,
    'split': 'evaluation'
}
Path('data/cases.local.json').write_text(json.dumps({'cases': [case]}, indent=2) + '\n')
PY
```

英文样本将 `language` 设为 `english`。上面的 `private-example` 仅用于通用推理演示，不是 MELI 样本，不能直接交给下文的 MELI 专用评分器。不要把相同说话人的另一段录音当作独立新说话人。人工参考保存在单独的私有文件中，只能在推理终态确定后交给评分器；推理输出不含错误率评分。

## 原生 Sherpa Qwen 0.6B INT8

建立独立环境并安装固定版本。此路径不需要 PyTorch：

```bash
python3 -m venv .venv-native
.venv-native/bin/python -m pip install 'sherpa-onnx==1.13.8' 'numpy==2.5.4'
.venv-native/bin/python scripts/download-qwen-int8.py
```

下载器读取固定 revision，逐文件核验大小和 SHA-256，模型加 tokenizer 共约 941.3 MiB。下载到本机不等于上传媒体；此脚本只取得模型文件。

先核验模型和 PCM，不加载模型：

```bash
.venv-native/bin/python scripts/run-native-qwen.py \
  --cases data/cases.local.json \
  --output results/native-06.json \
  --model-dir models/qwen3-asr-0.6B-int8 \
  --verify-only
```

本轮主实验使用 `native-protocol-frozen.json` 中的 2048/512 限额；runner 不会自动读取这个协议，所以命令中显式传入。不要依赖其不同的 CLI 默认值：

```bash
.venv-native/bin/python scripts/run-native-qwen.py \
  --cases data/cases.local.json \
  --output results/native-06.json \
  --model-dir models/qwen3-asr-0.6B-int8 \
  --num-threads 2 --max-total-len 2048 --max-new-tokens 512 \
  > results/native-06.log 2>&1
native_exit_code=$?
```

历史六例复现另用 512/128，必须使用另一个结果文件，不能与主实验混合选优。此 runner 会重新写入指定结果文件，继续工作前应使用新的输出名或另行保存已有结果。

Sherpa 的 `text`/`tokens` 是引擎返回值。固定版本包含低多样性重复尾部保护，不能将其称为未经任何处理的全部生成 token。该路径没有加载强制对齐器，不应凭返回字段的存在就认定拥有可靠逐词时间轴。

## 官方 Qwen 0.6B / 1.7B BF16

使用另一个环境，并从 CPU wheel 索引安装 PyTorch，避免无意下载 GPU 栈。版本取自本轮运行环境；以下只是复现准备命令，不代表所有机器都能容纳 1.7B：

```bash
python3 -m venv .venv-official
.venv-official/bin/python -m pip install \
  --index-url https://download.pytorch.org/whl/cpu 'torch==2.14.1+cpu'
.venv-official/bin/python -m pip install \
  'transformers==5.19.0' 'numpy==2.5.4' 'librosa==1.0.0' \
  'soundfile==0.14.0' 'scipy==1.18.1' 'packaging==26.3'
.venv-official/bin/python download-official.py
```

`download-official.py` 下载协议中固定 revision 的 **两个**官方模型，逐文件核验并生成 `verified-assets.json`。运行下载器会占用相应网络和磁盘空间，不在后台自动执行。下载完成后串行运行：

```bash
.venv-official/bin/python scripts/run-official-qwen.py \
  --cases data/cases.local.json \
  --output results/official-06.json \
  --model-dir models/Qwen3-ASR-0.6B-hf \
  --protocol protocol-frozen.json --num-threads 2 \
  > results/official-06.log 2>&1
official06_exit_code=$?

.venv-official/bin/python scripts/run-official-qwen.py \
  --cases data/cases.local.json \
  --output results/official-17.json \
  --model-dir models/Qwen3-ASR-1.7B-hf \
  --protocol protocol-frozen.json --num-threads 2 \
  > results/official-17.log 2>&1
official17_exit_code=$?
```

官方 runner 只从本地加载固定资产，禁用 remote code，并在模型 worker 中禁止网络连接。它使用 CPU BF16、batch size 1、greedy 解码及 512 个新 token 上限。监督器记录子进程终态；异常退出、内存失败或缺失样本必须按失败报告，不能删除后只报成功子集。

若明确需要续跑同一输入、协议、脚本和模型目录，可在原命令加 `--resume`。指纹不匹配会拒绝续跑；成功样本保持原结果，失败和重试记录保留。已存在输出而未指定 `--resume` 时不会覆盖。

主评分字段为新生成 token 后缀的 `text`，跳过特殊 token，不做重复修复或空格清理。`official_processed_text` 是官方后处理诊断，不能根据参考答案挑选更好的一版替换主结果。`status=complete` 只证明执行完成，不代表转写正确。

## 独立离线评分

评分只读取已结束的结果 JSON 和单独保存的人工参考，不加载模型、不访问媒体、不发起网络请求。需要 Node.js 20 以上，并保留本研究目录在完整仓库内的位置：评分器引用仓库原有的 `scripts/benchmarks/score-transcripts.mjs`。源码来源和哈希见 `SCORER_PROVENANCE.json`。

每次推理结束后，立即像上例一样保存实际 `$?`。评分命令的退出码参数必须来自该次运行，不能因 JSON 中写了 `complete` 就填入 0；调用者提供的退出码与结果内嵌退出码冲突会拒绝评分。缺失或失败的批次保留完成子集诊断，但全组 CER/WER 为 `null`，不能删掉失败样本后宣称整组通过。达到 token 上限的输出照实计分，保留截断标记，不删除重复或缺失尾部。

### MELI 采访

这部分专用于本轮 MELI 分组，不是任意音频的通用排行榜。自行依法取得相同素材和标注，按 [验证报告](../../docs/QWEN_ACCURACY_VALIDATION.md) 与 [公开指纹/来源](../../docs/benchmarks/qwen-accuracy-20261014.json) 重建输入。参考与媒体不随源码发布，所以仅克隆仓库不能重现包含私人歌词的完整 31 例。

准备 `data/meli-cases.local.json`：仍是上述七字段白名单，`split` 只能为 `development` 或 `holdout`，ID 使用实际 MELI 参与者和语言，例如 `meli-next-holdout-f99a-en`，不能给自己的录音套用一个 MELI ID。私有 `data/meli-scorer.local.json` 顶层含 `cases`；每例含匹配的 `id`、`language`、`split`、`reference` 和 `reference_sha256`，最后一项是参考字符串原始 UTF-8 的 SHA-256。参考文件只交给评分器。

若推理清单只含这 23 例，可以直接评分该终态结果。若使用完整 31 例清单 `data/all-cases.local.json` 和结果 `results/native-all.json`，先机械提取预先规定的全部 MELI ID：

```bash
python3 scripts/select-meli-result-subset.py \
  --results results/native-all.json \
  --source-input data/all-cases.local.json \
  --scope-input data/meli-cases.local.json \
  --output results/native-meli.json

node scripts/score-next-accuracy.mjs \
  --input data/meli-cases.local.json \
  --scorer data/meli-scorer.local.json \
  --results results/native-meli.json \
  --output results/native-meli-scored.json \
  --result-format native --runner-exit-code "$native_exit_code"
```

其中 `native_exit_code` 必须在生成 `native-all.json` 的模型命令后立即记录；提取器自身的退出码不能替代它。提取器校验原始清单哈希和每例七字段一致性，不按输出好坏筛选，保留失败、缺失和截断信息，并记录来源指纹；输出存在时拒绝覆盖。

官方 0.6B/1.7B 结果同样使用 `--result-format native`，因为它们的主输出在每例 `text` 中；分别传入对应的结果、输出路径和已保存的实际退出码。`official_processed_text` 不参与主评分。其他格式只用于相应的既有真实 Worker/基线结果，不能为通过校验而改写运行状态或捏造来源。

### 八项固定控制

`score-controls-only.mjs` 单独处理清晰语音、快速语音、噪声、已见私人歌词和空语音；它严格要求以下顺序的八个 ID：`zh-clean`、`en-jfk`、`zh-fast`、`zh-noisy-digits`、`en-noisy-dialogue`、`silence`、`noise`、`user-lyrics`。这不代表允许获取或传播私人视频；没有该素材使用权时，不能宣称复现此完整固定控制集。

准备 `data/controls-cases.local.json` 的七字段输入，以及包含匹配 `id`、`pcm_sha256`、`language`、`split`、`reference` 的私有 `data/controls-scorer.local.json`。还需要 `data/controls-baseline.local.json`：相同八例、`status=complete`、真实 `assembly_provenance`，每例保留 `source_inference.source_result_sha256`。缺少基线证据应另行产生真实结果，不能用参考答案补成基线输出。

```bash
node scripts/score-controls-only.mjs \
  --input data/controls-cases.local.json \
  --source-input data/all-cases.local.json \
  --scorer data/controls-scorer.local.json \
  --results results/native-all.json \
  --baseline data/controls-baseline.local.json \
  --output results/native-controls-scored.json \
  --runner-exit-code "$native_exit_code"
```

`--source-input` 指向该结果实际使用的完整推理清单，用于核验结果中的输入哈希。若只跑八项控制则改为那次实际清单，不能拿不同内容的清单替代。已知静音和噪声参考为空，报告是否产生字词的误报，不把分母为零的 CER/WER 写成 0%。

两个评分器沿用既有 NFKC、小写、标点及空白处理，额外分解替换/删除/插入并断言总距离一致。中文 CER 与英文 WER 分开，按开发/新说话人分组，报告加权错误率和说话人等权均值；控制集不冒充独立说话人抽样。中文数字等价 CER 只是另列的次指标，不替代严格 CER，也不折叠繁简体。MELI 普通标点没有可靠金标准，应记为 N/A。

不需要模型和媒体即可运行评分逻辑回归：

```bash
node --test scripts/score-next-accuracy.test.mjs scripts/score-controls-only.test.mjs
```

## WebAssembly 与结果边界

Web runtime 下载器、真实 WASM runner、冻结低 KV 协议和来源指纹已单独纳入本包。环境、预检与完整运行命令见 [WebAssembly 复现说明](WEB_WASM.md)，资源和功能边界见 [浏览器可行性记录](BROWSER_READINESS.md)。2048/512 连续批次为 8/31 完成后失败，独立 1280/512 诊断为 10/31 完成后失败；同配置新进程的单例成功没有消除整批失败。请保留两次失败的完整记录，不把模型命令跑完或已完成例数增加称为准确率通过。

原生 CPU、Node VM 中实际 WASM、真实桌面浏览器和真实手机是不同验证层级。模型在原生环境正常返回，不能证明手机加载、长视频、缓存、取消或重试已通过。Qwen 没有接入产品默认流程；实际 WebAssembly 成功与失败记录见 [验证报告](../../docs/QWEN_ACCURACY_VALIDATION.md)。

MELI 参考来自 Whisper-large-v3 草稿经双语研究助理校正，不是从零独立生成的完美金标准；已反复用于开发的旧样本继续标为开发/回归集。每种语言只有 4 名新说话人，地区与语言经历不等于人工评定的口音强度。本包没有微调代码，没有声称完成口音训练，没有上传媒体到外部 ASR。研究结果中的模型候选改善尚未成为浏览器产品能力。

## v0.5.4 继续实验

本轮使用相同录音做生命周期、固定分段、人声分离和字幕图像对照，已经使用过的 8 名说话人现在也只算开发/回归数据。实际结果及范围见 [继续验证报告](../../docs/LIFECYCLE_LYRICS_VALIDATION.md)。为保留真实执行时的相对文件位置和字节指纹，下面提供精简源码归档，解压后阅读各包 README；不包含权重、媒体、参考全文或实际转写。

- [生命周期和分段源码](lifecycle-source.zip)：v1、v2、v3 协议、原 runner、串行监督器、采样点覆盖检查及合成自测。各版独立，不覆盖失败历史。
- [分段结果独立评分源码](scoring-source.zip)：验证父文件/子段完整性、退出证据和精确拼接，再使用既有 CER/WER 口径评分；附 19 项合成控制测试。
- [人声分离研究源码](vocal-source.zip)：官方单模型 HTDemucs CPU 研究方案、配对重采样控制、执行监督、枚举适配、事后评分及实际结果。权重不是本产品资产，不能从代码许可推定权重使用范围。

- [字幕像素对照源码](caption-source.zip)：四组固定图像实验、隔离 Worker、几何匹配评分与合成测试；不含实际帧、参考全文或 OCR 输出。

这些归档保存的是冻结的实验环境快照，部分路径和清单哈希绑定原环境。跨机器需要明确记录仅修改路径的派生协议，并重新验证源码/模型/媒体指纹；不能通过移除完整性检查冒充原实验。准备阶段 README 的状态不能替代外部终态结果报告，也不能仅凭源码和无模型自测声称识别通过。
