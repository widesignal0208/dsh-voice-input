// DSH 语音输入 client-plugin（静态 client bundle）
// 输入框 🎤 按钮 / F9：按住录音 → 松开识别
// 优先用浏览器内 sherpa-onnx WebAssembly 本地识别（纯前端、无需后端）；
// 若 wasm 尚未就绪/加载失败，则自动回退到本地后端 http://127.0.0.1:8123/recognize。
window.__ModuleLoader__.load({
  id: "dsh-client-voice-input",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");

    const VOICE_URL = "http://127.0.0.1:8123/recognize"; // 后端回退

    // ===== wasm 模型文件地址（按顺序尝试，前面的失败自动用下一个）=====
    // .js/.wasm 走 jsDelivr（返回正确 MIME + CORS，单文件 <20MB，能被 <script> 和 instantiateStreaming 正常加载）
    // .data(26MB) 走 raw.githubusercontent.com（jsDelivr 单文件限 20MB 放不下；raw 的 text/plain+nosniff 只拦 <script>，不影响 fetch 下载 .data）
    // 本地开发：voice_server.py 提供所有文件，用第二个源兜底。
    const WASM_SOURCES = [
      {
        js: "https://cdn.jsdelivr.net/gh/widesignal0208/dsh-voice-input@main/wasm/",
        data: "https://raw.githubusercontent.com/widesignal0208/dsh-voice-input/main/wasm/",
      },
      {
        js: "http://127.0.0.1:8123/wasm/",
        data: "http://127.0.0.1:8123/wasm/",
      },
    ];

    const TARGET_SR = 16000;
    const MAX_RECORD_MS = 60000; // 最长录音 60 秒，自动停止

    // 合并多段 Float32 采样为一个连续数组
    function mergeSamples(chunks) {
      let total = 0;
      for (let i = 0; i < chunks.length; i++) total += chunks[i].length;
      const out = new Float32Array(total);
      let off = 0;
      for (let i = 0; i < chunks.length; i++) { out.set(chunks[i], off); off += chunks[i].length; }
      return out;
    }

    // 任意采样率的 Float32 → 16kHz Float32（最近邻抽值，与后端 wav 编码一致）
    function resample16k(samples, fromRate) {
      if (fromRate === TARGET_SR) return samples;
      const step = fromRate / TARGET_SR;
      const outLen = Math.floor(samples.length / step);
      const out = new Float32Array(outLen);
      for (let i = 0; i < outLen; i++) {
        out[i] = samples[Math.min(samples.length - 1, Math.floor(i * step))];
      }
      return out;
    }

    // 任意采样率的 Float32 采样 → 16kHz 16bit 单声道 wav Blob（供后端回退用）
    function float32ToWav16k(samples, sampleRate) {
      const out = resample16k(samples, sampleRate);
      const n = out.length;
      const ab = new ArrayBuffer(44 + n * 2);
      const dv = new DataView(ab);
      const ws = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
      ws(0, "RIFF"); dv.setUint32(4, 36 + n * 2, true); ws(8, "WAVE");
      ws(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
      dv.setUint16(22, 1, true); dv.setUint32(24, TARGET_SR, true);
      dv.setUint32(28, TARGET_SR * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
      ws(36, "data"); dv.setUint32(40, n * 2, true);
      for (let i = 0; i < n; i++) {
        const s = Math.max(-1, Math.min(1, out[i]));
        dv.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      }
      return new Blob([ab], { type: "audio/wav" });
    }

    // 发送 wav 到后端识别，返回识别文本（空串表示未听清）
    async function recognizeWav(wav) {
      const res = await fetch(VOICE_URL, { method: "POST", body: wav });
      const j = await res.json();
      return (j.text || "").trim();
    }

    // ---------- 纯前端 wasm 识别（sherpa-onnx 浏览器版） ----------
    let wasmPromise = null;
    let wasmFailed = false;
    let wasmBaseIndex = 0;

    function loadScript(src) {
      return new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = src;
        s.async = true;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error("脚本加载失败: " + src));
        document.head.appendChild(s);
      });
    }

    // 懒加载 wasm 运行时 + 模型，成功后返回一个可复用的 OnlineRecognizer 实例。
    // 首次调用会下载 ~39MB（.wasm 13MB + .data 26MB），之后缓存复用。
    // 按 WASM_SOURCES 顺序尝试，某个源加载失败自动切到下一个。
    function loadWasmRecognizer() {
      if (wasmFailed) return Promise.reject(new Error("wasm 不可用，已回退后端"));
      if (wasmPromise) return wasmPromise;
      const src = WASM_SOURCES[wasmBaseIndex];
      if (!src) {
        wasmFailed = true;
        return Promise.reject(new Error("所有 wasm 地址都不可用，已回退后端"));
      }
      wasmPromise = new Promise((resolve, reject) => {
        const M = {};
        window.Module = M;
        // .data(26MB) 走 raw，.wasm 走 jsDelivr；其余按 js 源
        M.locateFile = (path) => (path.endsWith(".data") ? src.data : src.js) + path;
        M.setStatus = () => {};
        M.onRuntimeInitialized = () => {
          try {
            resolve(window.createOnlineRecognizer(M));
          } catch (e) {
            reject(e);
          }
        };
        const timeout = setTimeout(() => reject(new Error("wasm 初始化超时（模型下载较慢）")), 120000);
        loadScript(src.js + "sherpa-onnx-asr.js")
          .then(() => loadScript(src.js + "sherpa-onnx-wasm-main-asr.js"))
          .catch(reject)
          .finally(() => clearTimeout(timeout));
      }).catch((e) => {
        // 当前源失败 → 尝试下一个源；全部失败才标记 wasm 不可用
        wasmPromise = null;
        wasmBaseIndex += 1;
        if (wasmBaseIndex < WASM_SOURCES.length) return loadWasmRecognizer();
        wasmFailed = true;
        throw e;
      });
      return wasmPromise;
    }

    function VoiceDock(props) {
      // props: { shell, notify }（slot 系统另有保留的 session/input 注入，故用 shell 避免冲突）
      // phase: idle(🎤) → recording(🔴) → busy(⏳) → idle(🎤)
      const [phase, setPhase] = React.useState("idle");
      const [wasmReady, setWasmReady] = React.useState(false);
      const recRef = React.useRef(null);       // { ac, source, processor, sampleRate }（Web Audio 录音状态）
      const streamRef = React.useRef(null);    // MediaStream
      const samplesRef = React.useRef([]);     // Float32Array[] 累积音频采样（后端回退用）
      const wantRef = React.useRef(false);     // 是否仍期望录音中（处理 getUserMedia 竞态）
      const timerRef = React.useRef(null);
      const baseRef = React.useRef("");            // 语音开始前的草稿，partial/final 都基于它追加
      const partialTimerRef = React.useRef(null);  // 后端回退时边说话边出中间结果的定时器
      const wasmRecRef = React.useRef(null);       // OnlineRecognizer 实例（wasm）
      const wasmStreamRef = React.useRef(null);    // 当前录音的 OnlineStream（wasm）
      const lastPartialRef = React.useRef("");     // 上次写进输入框的中间结果

      // 组件挂载即后台预加载 wasm（用户首次按住时大概率已就绪；未就绪则回退后端）
      React.useEffect(() => {
        let alive = true;
        loadWasmRecognizer()
          .then((rec) => { if (alive) { wasmRecRef.current = rec; setWasmReady(true); } })
          .catch(() => { /* 静默：回退后端 */ });
        return () => { alive = false; };
      }, []);

      const writeDraft = React.useCallback((text) => {
        if (!text) return;
        const base = baseRef.current;
        const sep = base && !base.endsWith(" ") ? " " : "";
        props.shell && props.shell.setDraft(base + sep + text);
      }, [props]);

      const stopRecording = React.useCallback(async () => {
        wantRef.current = false;
        if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
        if (partialTimerRef.current) { clearInterval(partialTimerRef.current); partialTimerRef.current = null; }
        const rec = recRef.current;
        recRef.current = null;
        const wstream = wasmStreamRef.current;
        wasmStreamRef.current = null;
        if (!rec) {
          // 录音还没真正建立（getUserMedia 尚未返回）——直接回到 idle
          setPhase("idle");
          return;
        }
        setPhase("busy");
        // 停止采集：先摘掉回调，再断开节点、释放麦克风与 AudioContext
        rec.processor.onaudioprocess = null;
        try { rec.source.disconnect(); rec.processor.disconnect(); } catch (e) {}
        if (streamRef.current) { streamRef.current.getTracks().forEach((t) => t.stop()); streamRef.current = null; }
        try { rec.ac.close().catch(() => {}); } catch (e) {}

        // wasm 流式：收尾 → 吐最终结果
        if (wstream && wasmRecRef.current) {
          try {
            wstream.inputFinished();
            const recognizer = wasmRecRef.current;
            while (recognizer.isReady(wstream)) recognizer.decode(wstream);
            const text = (recognizer.getResult(wstream).text || "").trim();
            if (text) {
              writeDraft(text);
            } else {
              props.shell && props.shell.setDraft(baseRef.current);
              props.notify("error", "（未听清，请靠近麦克风、放慢语速再说一次）");
            }
          } catch (e) {
            props.notify("error", "语音识别失败: " + e.message);
          } finally {
            setPhase("idle");
          }
          return;
        }

        // 后端回退：合并采样 → wav → 后端识别
        try {
          const merged = mergeSamples(samplesRef.current);
          samplesRef.current = [];
          if (merged.length === 0) {
            props.shell && props.shell.setDraft(baseRef.current);
            props.notify("info", "（没录到声音，请按住 🎤 或 F9 说话）");
            return;
          }
          const wav = float32ToWav16k(merged, rec.sampleRate);
          const text = await recognizeWav(wav);
          if (text) {
            writeDraft(text);
          } else {
            props.shell && props.shell.setDraft(baseRef.current);
            props.notify("error", "（未听清，请靠近麦克风、放慢语速再说一次）");
          }
        } catch (e) {
          props.notify("error", "语音识别失败: " + e.message);
        } finally {
          setPhase("idle");
        }
      }, [props, writeDraft]);

      const startRecording = React.useCallback(async () => {
        wantRef.current = true;
        setPhase("recording");
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          if (!wantRef.current) {
            // 等待麦克风期间用户已取消
            stream.getTracks().forEach((t) => t.stop());
            setPhase("idle");
            return;
          }
          // 用 Web Audio API 采集（WebKit2GTK 无 MediaRecorder，浏览器/桌面两端通用）
          const AC = window.AudioContext || window.webkitAudioContext;
          let ac;
          try { ac = new AC({ sampleRate: TARGET_SR }); } catch (e) { ac = new AC(); }
          const source = ac.createMediaStreamSource(stream);
          const processor = ac.createScriptProcessor(4096, 1, 1);
          samplesRef.current = [];
          baseRef.current = props.shell && props.shell.snapshot ? props.shell.snapshot.draft : "";
          const recognizer = wasmRecRef.current;

          if (recognizer) {
            // —— wasm 流式：边说话边出中间结果，松手后 inputFinished 出最终结果 ——
            const wstream = recognizer.createStream();
            wasmStreamRef.current = wstream;
            lastPartialRef.current = "";
            processor.onaudioprocess = (e) => {
              let samples = new Float32Array(e.inputBuffer.getChannelData(0));
              if (ac.sampleRate !== TARGET_SR) samples = resample16k(samples, ac.sampleRate);
              wstream.acceptWaveform(TARGET_SR, samples);
              while (recognizer.isReady(wstream)) recognizer.decode(wstream);
              const text = (recognizer.getResult(wstream).text || "").trim();
              if (text && text !== lastPartialRef.current) {
                lastPartialRef.current = text;
                writeDraft(text);
              }
            };
          } else {
            // —— 后端回退：采集样本，每秒发后端识别实时写草稿 ——
            processor.onaudioprocess = (e) => {
              samplesRef.current.push(new Float32Array(e.inputBuffer.getChannelData(0)));
            };
            partialTimerRef.current = setInterval(async () => {
              const r = recRef.current;
              if (!r || samplesRef.current.length === 0) return;
              try {
                const merged = mergeSamples(samplesRef.current);
                const wav = float32ToWav16k(merged, r.sampleRate);
                const text = await recognizeWav(wav);
                if (text && recRef.current === r) writeDraft(text);
              } catch (e) {
                // partial 失败忽略，松手后的 final 会兜底
              }
            }, 1000);
          }

          source.connect(processor);
          processor.connect(ac.destination);  // ScriptProcessor 必须连到 destination 才会触发回调
          streamRef.current = stream;
          recRef.current = { ac, source, processor, sampleRate: ac.sampleRate };
          timerRef.current = setTimeout(() => { if (recRef.current) stopRecording(); }, MAX_RECORD_MS);
        } catch (e) {
          wantRef.current = false;
          recRef.current = null;
          setPhase("idle");
          props.notify("error", "无法使用麦克风: " + e.message);
        }
      }, [stopRecording, props, writeDraft]);

      const onPointerDown = React.useCallback((e) => {
        e.preventDefault();
        if (phase !== "idle") return;
        startRecording();
      }, [phase, startRecording]);

      const onPointerUp = React.useCallback((e) => {
        e.preventDefault();
        if (phase === "recording") stopRecording();
      }, [phase, stopRecording]);

      const onPointerLeave = React.useCallback(() => {
        if (phase === "recording") stopRecording();
      }, [phase, stopRecording]);

      const onPointerCancel = React.useCallback(() => {
        if (phase === "recording") stopRecording();
      }, [phase, stopRecording]);

      // 全局快捷键：按住 F9 开始录音，松开停止识别（与按钮等效）
      // 用 F9 单个键：避开 Ctrl+Alt+Z 可能被系统/输入法抢占的问题；
      // keyup 只认物理键、不认修饰键状态，避免松开顺序导致漏触发。
      React.useEffect(() => {
        const isTrigger = (e) => e.code === "F9";
        const onKeyDown = (e) => {
          if (!isTrigger(e)) return;
          e.preventDefault();
          if (e.repeat) return;
          if (phase === "idle") startRecording();
        };
        const onKeyUp = (e) => {
          if (!isTrigger(e)) return;
          e.preventDefault();
          if (phase === "recording") stopRecording();
        };
        window.addEventListener("keydown", onKeyDown);
        window.addEventListener("keyup", onKeyUp);
        return () => {
          window.removeEventListener("keydown", onKeyDown);
          window.removeEventListener("keyup", onKeyUp);
        };
      }, [phase, startRecording, stopRecording]);

      const base = {
        border: "none",
        background: "transparent",
        cursor: "pointer",
        fontSize: "16px",
        lineHeight: 1,
        padding: "4px 6px",
        borderRadius: "6px",
        userSelect: "none",
        WebkitUserSelect: "none",
        touchAction: "none",
      };
      const style = phase === "recording"
        ? { ...base, background: "rgba(255,80,80,.30)" }
        : phase === "busy"
          ? { ...base, opacity: 0.55, cursor: "default" }
          : base;

      const title = phase === "recording"
        ? "松开识别"
        : phase === "busy"
          ? "识别中…"
          : (wasmReady ? "按住说话，松开识别（本地识别，快捷键 F9）" : "按住说话，松开识别（快捷键 F9）");

      const label = phase === "recording" ? "🔴" : phase === "busy" ? "⏳" : "🎤";

      return React.createElement("button", {
        type: "button",
        title,
        "aria-label": "语音输入",
        style,
        onPointerDown,
        onPointerUp,
        onPointerLeave,
        onPointerCancel,
        children: label,
      });
    }

    function apply(ctx) {
      ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
        name: "conversation.input.right",
        id: "voice",
        order: 10,
        inject: (sessionId) => {
          const actx = ctx.sessions.scope(sessionId);
          if (actx === void 0) throw new Error("voice input: session \"" + sessionId + "\" resolved no scope");
          const conversation = actx.get("conversation");
          if (conversation === void 0) throw new Error("voice input: conversation service unavailable");
          const shell = conversation.input.for(actx);
          return {
            shell,
            notify: (level, text) => shell.notify(level, text),
          };
        },
      }, VoiceDock));
    }

    exports.apply = apply;
    exports.inject = ["slots", "conversation", "sessions"];
    return module.exports;
  }
});
