# dsh-client-voice-input

给 [DeepSeek Harness（dsh）](https://github.com/deepseek-ai/deepseek-harness) 加的**语音输入插件**：

- 在输入框右侧加一个 🎤 按钮（或按 **F9**），**按住说话、松开识别**，识别结果自动填进输入框。
- 识别在**浏览器内本地完成**（sherpa-onnx 编译成的 WebAssembly），**不联网、不上传音频、不需要后端**。
- 说话过程中边录边出**中间结果**，松手后替换为**最终准确结果**。

## 工作原理

```
按住 🎤/F9 → 浏览器录音（Web Audio API，16kHz 单声道）
         → 纯前端 wasm 流式识别（sherpa-onnx 中文模型，zipformer2-ctc）
         → 松开 → 最终结果写入输入框
```

- 首选：**wasm 本地识别**（无需后端，加载后完全离线）。
- 回退：若 wasm 尚未加载完成/失败，自动回退到本地后端 `http://127.0.0.1:8123/recognize`（开发环境用）。

## 安装（给使用者）

1. 把本插件放到 dsh 的插件目录，并在 `cordis.patch.yml` 里注册（参考 dsh 的 client 插件机制）。
2. 打开 dsh web 页面，输入框右侧出现 🎤 按钮即成功。

> 更详细的 dsh 静态 client 插件接入方式，见仓库里的 `开发避坑指南.md`（如果你保留了它）。

## 使用

| 操作 | 效果 |
| --- | --- |
| 按住 🎤 按钮 | 开始录音（按钮变 🔴） |
| 松开 🎤 按钮 | 停止并识别，结果填入输入框 |
| 按住 **F9** | 等价于按住 🎤（键盘快捷键） |
| 松开 **F9** | 等价于松开 🎤 |

- 说话过程中会实时显示中间结果；松手后替换为最终结果。
- 最长录音 60 秒，超时自动停止。

## 模型文件与分发（重要）

wasm 识别依赖 4 个文件（在 `wasm/` 目录）：

| 文件 | 大小 | 作用 |
| --- | --- | --- |
| `sherpa-onnx-asr.js` | ~53 KB | JS 封装（识别器 API） |
| `sherpa-onnx-wasm-main-asr.js` | ~81 KB | Emscripten 运行时胶水代码 |
| `sherpa-onnx-wasm-main-asr.wasm` | ~13 MB | WebAssembly 二进制 |
| `sherpa-onnx-wasm-main-asr.data` | ~26 MB | 中文语音模型（打包进虚拟文件系统） |

这些文件需要在 `lib/client.js` 顶部的 `WASM_SOURCES` 里指定浏览器能访问到的地址。

### 为什么 `.js/.wasm` 走 jsDelivr、`.data` 走 raw

两个 CDN 各有各的限制，必须**混搭**：

- **raw.githubusercontent.com** 把 `.js` 当 `text/plain` 返回、且带 `nosniff` 头，浏览器会**拒绝把 `.js` 当脚本执行**；但它单文件支持 100 MB，能放 26 MB 的 `.data`（`.data` 是 fetch 下载，不受 nosniff 影响）。
- **jsDelivr** 对 `.js` 返回正确的 `application/javascript`、对 `.wasm` 返回 `application/wasm`，能正常加载；但它**单文件上限 20 MB**，放不下 26 MB 的 `.data`。

所以：`.js` + `.wasm`（都 <20 MB）走 jsDelivr，`.data`（26 MB）走 raw。

### 分发方式：提交到 GitHub

1. 把 4 个文件直接**提交进 Git 仓库**（`wasm/` 目录，26 MB 远低于 GitHub 100 MB 限制）。
2. `lib/client.js` 顶部的 `WASM_SOURCES` 已按顺序配置好：

```js
const WASM_SOURCES = [
  {
    js:   "https://cdn.jsdelivr.net/gh/widesignal0208/dsh-voice-input@main/wasm/",
    data: "https://raw.githubusercontent.com/widesignal0208/dsh-voice-input/main/wasm/",
  },
  { js: "http://127.0.0.1:8123/wasm/", data: "http://127.0.0.1:8123/wasm/" }, // 本地开发兜底
];
```

浏览器会先试第一个源，失败自动切到第二个。推送后第一个源即可用，本地开发用第二个。

> 国内访问这两个 CDN 较慢时，可在对应地址前加 `https://gh-proxy.com/` 前缀加速。

## 发布步骤（给作者）

1. `package.json` 里 `author` 和 `repository` 已填好（用户名 `widesignal0208`）。
2. `lib/client.js` 里的 `WASM_SOURCES` 已填好 jsDelivr + raw 地址（`main` 分支）。
3. 在 GitHub 新建一个空仓库 `dsh-voice-input`（不要勾选 README），然后推送：

```bash
cd dsh-voice-input
git init
git add .
git commit -m "init: dsh voice input plugin (wasm)"
git branch -M main
git remote add origin https://github.com/widesignal0208/dsh-voice-input.git
git push -u origin main
```

4. 推送完成后，别人下载插件时浏览器会自动从 jsDelivr/raw 拉取模型，开箱即用。

## 本地开发（有后端回退）

本地开发时保留后端更省心：

```bash
python3 voice_server.py   # 提供 /recognize 后端识别 + /wasm/ 模型静态服务，默认 8123
```

此时 `WASM_SOURCES` 里的 `http://127.0.0.1:8123/wasm/` 会自动兜底生效（第一个源不可用时会切到它）。

## 目录结构

```
dsh-voice-input/
├── lib/
│   ├── index.js     # host 空入口（dsh 需要）
│   └── client.js    # 浏览器端插件逻辑（wasm 识别 + 后端回退）
├── wasm/            # sherpa-onnx wasm 编译产物 + 中文模型
├── package.json
├── LICENSE
└── README.md
```

## License

MIT
