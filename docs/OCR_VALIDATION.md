# 浏览器画面文字识别验证

此次加入的是真实 PP-OCRv4 中文文字检测、方向分类和 CTC 识别，运行在浏览器 Worker 的 OpenCV / ONNX WASM 中。它读取视频画面的像素，能识别可见字幕，不能从不存在或无法分辨的字形恢复完整歌词。

## 已完成的运行验证

2026-10-13 使用实际 Vite 构建产物 `video-ocr.worker-CiKI78o4.js`，实际 PP-OCRv4 mobile 权重及 `ort-wasm-simd-threaded.wasm` 验证了六种输入。Worker 在 Node VM 内运行：模型 HTTPS GET 与 Cache API 使用本地文件模拟，WASM helper 地址改为文件传输；推理与 OpenCV 图像计算使用实际 WASM，并非模型假返回。此测试没有运行浏览器的视频解码器、界面、华为真机或线上网络。

| 输入 | 实际原始文字输出 | 模型平均字符分数 | 单帧耗时 |
| --- | --- | --- | --- |
| 用户演唱会视频，0.5 秒，1080×1920 整帧 | 漫天红伞无人生还 | 0.9962 | 5.77 秒 |
| 用户演唱会视频，13.125 秒，1080×1920 整帧 | 我的遗是不能洁白的带你离开 | 0.8471 | 6.07 秒 |
| 人工生成的英文字幕 MP4，经 FFmpeg 解码取帧 | Meeting starts at 9:30. Bring notes! | 0.9981 | 2.80 秒 |
| 同一英文控制画面旋转 90°，方向分类再翻转 180° | Meeting starts at 9:30. Bring notes! | 0.9991 | 2.80 秒 |
| 人工生成的中文字幕 MP4，经 FFmpeg 解码取帧，两行 | 会议将在九点半开始。 / 请带上笔记本！ | 0.9993 / 0.9808 | 2.81 秒 |
| 640×360 纯黑画面 | 空文本 | 不适用 | 0.64 秒 |

这些分数是模型对保留字符的平均 softmax 值，**不是实测准确率，也不是整句正确概率**。耗时来自本次测试环境，不能作为手机性能承诺。英文画面、旋转画面、中文字幕和黑帧是合成控制，检验输入、几何变换、标点与空结果；它们不是四段独立真实拍摄的视频，不能据此宣称自然视频泛化能力。

可见英文的冒号、句号、感叹号和中文的句号、感叹号均由实际 OCR 直接保留。原画面没有标点时，OCR 原始结果不凭空生成标点；应用层添加的断句标点应与原始识别文字区分。

## 用户歌词样本的限制

- 用户提供的目标首字为“满”，视频可见字幕及本次识别为“漫”。仅凭同音的声音和画面证据，不能把此差异自动认定为识别修复成功。
- 后半句仍缺少“憾”字。这段字幕较小、移动且模糊；整句平均分数较高并不排除漏字和低分字符。
- 同一后半句整帧还识别出一个景物候选“17”（分数 0.5581）。原始 OCR 能把背景误读为文字，需要多帧与位置证据筛选。
- 更大的 PP-OCRv4 server 识别模型并未完整解决此样本：普通裁剪实际 WASM 输出“我的透娜是不能洁白的带你离开”；绿色通道的候选为“我的透憾是不能洁白的带你离开”，其中“透”“憾”字符分数只有约 0.225、0.340。它不能作为自动正确结果发布。
- **完整识别这段目标歌词的验收尚未通过。**没有把用户给定的答案写进模型、识别引擎或词替换表。

## 模型与算法

模型与字典由构建脚本下载并核验 SHA-256。检测约 4.7 MB、mobile 识别约 10.9 MB、方向分类约 0.6 MB，加字典共约 15.5 MiB。检测和识别使用 BGR、CHW、`像素 / 127.5 - 1`；检测执行 DB 阈值、轮廓、旋转矩形和扩框；裁剪采用透视变换及竖向旋转。识别高度 48，右侧补归一化后的 0；CTC 使用与实际模型一致的 6625 类字典，连续重复去除后删除 blank。相关预处理来自 RapidOCR/PaddleOCR，许可证为 Apache-2.0。

标准界面仅使用 mobile 模型。约 90.5 MB 的 server 识别模型是开发验证选项，需要显式准备及选择；它不会随标准识别自动下载。单通道去色同样只是开发候选实验，并未启用为默认自动纠错。

## 复现实际构建的 WASM 推理

要求 Node 20 或更高版本及 `--experimental-vm-modules`。先安装依赖并完成正常构建：

```bash
npm ci
npm run build
```

自行从待测视频解码出 RGBA 原始像素文件，创建私有清单。下例的文件不随仓库提供，不需要上传。

```json
[
  { "name": "caption", "rgba": "caption.rgba", "width": 1280, "height": 720 },
  { "name": "blank", "rgba": "blank.rgba", "width": 640, "height": 360 }
]
```

从 PNG 生成 RGBA 文件的示例（安装 Pillow 后）：

```python
from PIL import Image
from pathlib import Path
image = Image.open("caption.png").convert("RGBA")
Path("caption.rgba").write_bytes(image.tobytes())
print(image.width, image.height)
```

将真实宽高填入清单，然后运行：

```bash
node --experimental-vm-modules scripts/benchmarks/test-ocr-wasm.mjs \
  --frames ./private-frames.json \
  --assets ./public/models-ocr \
  --runtime ./public/vendor/ort \
  --output ./private-ocr-result.json
```

脚本默认自动定位 `dist/assets/video-ocr.worker-*.js`。可通过 `--worker 路径` 指定要验证的构建产物；`--assets`、`--runtime` 允许使用不同的本地资源目录。输出记录构建与 WASM 的 SHA-256、实际原始文字、字符分数和耗时，不包含像素数据。它不判断歌词是否正确，人工参考文本应由另一个评测步骤比对。

开发者验证增强候选时，先运行 `OCR_INCLUDE_ENHANCED=1 node scripts/prepare-ocr-models.mjs` 并使用 `--precision enhanced`；清单某项可加入 `"options": { "colorMode": "green" }`。该选项的模型体积和结果局限如上，不代表标准部署已提供增强模型。
