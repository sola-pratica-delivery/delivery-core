export interface UploadPageOptions {
  uploadPath: string;
}

const CDN_TUS_FALLBACK =
  "https://cdn.jsdelivr.net/npm/tus-js-client@latest/dist/tus.min.js";

export function renderUploadPage(options: UploadPageOptions): string {
  const config = JSON.stringify({ uploadPath: options.uploadPath });
  return `<!DOCTYPE html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Delivery Core Ingestion</title>
    <style>
      :root {
        --bg: #0f172a;
        --surface: #1e293b;
        --surface-2: #26334d;
        --border: #334155;
        --text: #e2e8f0;
        --text-dim: #94a3b8;
        --accent: #6366f1;
        --accent-2: #8b5cf6;
        --success: #10b981;
        --danger: #ef4444;
        --warning: #f59e0b;
      }
      * { box-sizing: border-box; }
      html, body {
        margin: 0;
        padding: 0;
        background: var(--bg);
        color: var(--text);
        font-family: "Inter", -apple-system, "Segoe UI", system-ui, sans-serif;
        font-size: 15px;
        line-height: 1.5;
      }
      header {
        display: flex;
        align-items: center;
        gap: 16px;
        flex-wrap: wrap;
        padding: 16px 24px;
        background: var(--surface);
        border-bottom: 1px solid var(--border);
        position: sticky;
        top: 0;
        z-index: 10;
      }
      header h1 {
        margin: 0;
        font-size: 17px;
        letter-spacing: 0.3px;
        font-weight: 700;
      }
      header h1 span { color: var(--accent-2); }
      .status-pill {
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.8px;
        color: #064e3b;
        background: var(--success);
        border-radius: 999px;
        padding: 3px 10px;
        text-transform: uppercase;
      }
      .spacer { flex: 1; }
      .token-row { display: flex; align-items: center; gap: 8px; }
      .token-row input {
        background: var(--bg);
        color: var(--text);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 8px 12px;
        font-size: 13px;
        font-family: "SFMono-Regular", Consolas, monospace;
        min-width: 260px;
      }
      .token-row input:focus { outline: 2px solid var(--accent); border-color: transparent; }
      .token-row input.invalid { border-color: var(--danger); outline: 2px solid rgba(239,68,68,0.35); }
      button {
        cursor: pointer;
        border: 1px solid transparent;
        border-radius: 8px;
        font-weight: 600;
        font-size: 13px;
        padding: 9px 16px;
        transition: transform 0.06s ease, filter 0.15s ease, opacity 0.15s ease;
        background: var(--accent);
        color: #fff;
      }
      button:hover { filter: brightness(1.1); }
      button:active { transform: translateY(1px); }
      button:disabled { opacity: 0.45; cursor: not-allowed; }
      button.ghost {
        background: transparent;
        border-color: var(--border);
        color: var(--text);
      }
      button.danger { background: var(--danger); }
      main { max-width: 860px; margin: 0 auto; padding: 24px; }
      .card {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 14px;
        padding: 20px;
        margin-bottom: 18px;
      }
      .card h2 {
        margin: 0 0 14px;
        font-size: 13px;
        font-weight: 700;
        letter-spacing: 1px;
        text-transform: uppercase;
        color: var(--text-dim);
      }
      #dropzone {
        border: 2px dashed var(--border);
        border-radius: 14px;
        padding: 36px 20px;
        text-align: center;
        cursor: pointer;
        transition: border-color 0.2s ease, background 0.2s ease;
      }
      #dropzone.dragover,
      #dropzone:hover { border-color: var(--accent); background: rgba(99,102,241,0.08); }
      #dropzone .dz-icon {
        font-size: 34px;
        margin-bottom: 8px;
        color: var(--accent-2);
      }
      #dropzone p { margin: 4px 0; color: var(--text-dim); }
      #dropzone p strong { color: var(--text); }
      .file-meta { display: none; margin-top: 14px; text-align: left; }
      .file-meta.visible { display: block; }
      .file-meta .meta-row {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        padding: 8px 12px;
        background: var(--surface-2);
        border-radius: 8px;
        font-size: 13px;
      }
      .file-meta .meta-row span:first-child { color: var(--text-dim); }
      .file-warning {
        display: none;
        margin-top: 10px;
        padding: 10px 12px;
        background: rgba(239,68,68,0.12);
        border: 1px solid var(--danger);
        border-radius: 8px;
        color: #fecaca;
        font-size: 13px;
      }
      .file-warning.visible { display: block; }
      .progress-shell { display: none; margin-top: 16px; }
      .progress-shell.visible { display: block; }
      .progress-top {
        display: flex;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 8px;
        font-size: 12px;
        color: var(--text-dim);
        margin-bottom: 6px;
      }
      .progress-track {
        height: 14px;
        background: var(--bg);
        border-radius: 999px;
        overflow: hidden;
        border: 1px solid var(--border);
      }
      #progress-bar {
        height: 100%;
        width: 0%;
        border-radius: 999px;
        background: linear-gradient(90deg, var(--accent), var(--accent-2), var(--success));
        background-size: 200% 100%;
        transition: width 0.2s ease;
      }
      .progress-stats {
        display: flex;
        flex-wrap: wrap;
        gap: 8px 20px;
        margin-top: 10px;
        font-size: 13px;
      }
      .progress-stats .stat b { color: var(--text); }
      .upload-id { font-family: "SFMono-Regular", Consolas, monospace; }
      .actions {
        display: none;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 16px;
      }
      .actions.visible { display: flex; }
      #job-status-badge {
        display: none;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.6px;
        padding: 4px 12px;
        border-radius: 999px;
        text-transform: uppercase;
      }
      #job-status-badge.visible { display: inline-block; }
      .timeline { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
      .step {
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        padding: 5px 10px;
        border-radius: 999px;
        border: 1px solid var(--border);
        color: var(--text-dim);
        background: var(--bg);
      }
      .step.done { color: #064e3b; background: var(--success); border-color: var(--success); }
      .step.active { color: #fff; background: linear-gradient(90deg, var(--accent), var(--accent-2)); border-color: transparent; }
      .step.failed { color: #fff; background: var(--danger); border-color: var(--danger); }
      #event-log {
        list-style: none;
        margin: 12px 0 0;
        padding: 0;
        max-height: 220px;
        overflow-y: auto;
        font-size: 13px;
        font-family: "SFMono-Regular", Consolas, monospace;
      }
      #event-log li { padding: 3px 0; border-bottom: 1px solid rgba(51,65,85,0.4); }
      #event-log li .ts { color: var(--text-dim); margin-right: 8px; }
      #event-log li.ok { color: var(--success); }
      #event-log li.err { color: #fecaca; }
      #event-log li.warn { color: var(--warning); }
      #validation-report { display: none; margin-top: 12px; }
      #validation-report.visible { display: block; }
      .report-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
        margin-top: 10px;
      }
      .report-grid .cell {
        background: var(--surface-2);
        border-radius: 8px;
        padding: 8px 12px;
        font-size: 13px;
      }
      .report-grid .cell span { display: block; color: var(--text-dim); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
      #validation-report pre {
        background: var(--bg);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 12px;
        overflow-x: auto;
        color: var(--text-dim);
        font-size: 12px;
      }
      .error-banner {
        display: none;
        margin-top: 12px;
        padding: 10px 12px;
        background: rgba(239,68,68,0.12);
        border: 1px solid var(--danger);
        border-radius: 8px;
        color: #fecaca;
        font-size: 13px;
      }
      .error-banner.visible { display: block; }
      .toast {
        position: fixed;
        right: 18px;
        bottom: 18px;
        max-width: 340px;
        background: var(--surface-2);
        border: 1px solid var(--border);
        border-left: 4px solid var(--warning);
        border-radius: 10px;
        padding: 12px 16px;
        font-size: 13px;
        box-shadow: 0 8px 30px rgba(0,0,0,0.45);
        opacity: 0;
        transform: translateY(8px);
        pointer-events: none;
        transition: opacity 0.2s ease, transform 0.2s ease;
      }
      .toast.show { opacity: 1; transform: translateY(0); }
      .toast.danger { border-left-color: var(--danger); }
      .toast.success { border-left-color: var(--success); }
      footer { text-align: center; color: var(--text-dim); font-size: 12px; padding: 12px 0 28px; }
      @media (max-width: 640px) {
        .token-row input { min-width: 0; flex: 1; }
        .report-grid { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <script id="app-config" type="application/json">${config}</script>
    <header>
      <h1>Delivery <span>Core</span> Ingestion</h1>
      <span class="status-pill" id="service-status">Online</span>
      <div class="spacer"></div>
      <div class="token-row">
        <input
          id="token-input"
          type="password"
          autocomplete="off"
          placeholder="API Token (Bearer)"
          spellcheck="false"
        />
        <button id="save-token" type="button">Salvar Token</button>
        <span id="token-status" class="status-pill" style="background: rgba(148,163,184,0.3); color: var(--text-dim);">Não configurado</span>
      </div>
    </header>

    <main>
      <section class="card">
        <h2>1 &middot; Seleção de vídeo</h2>
        <div id="dropzone" tabindex="0" role="button" aria-label="Selecionar vídeo">
          <input id="file-input" type="file" accept=".mp4,.mkv,.mov,video/mp4,video/x-matroska,video/quicktime" hidden />
          <div class="dz-icon">&#11021;</div>
          <p><strong>Arraste e solte</strong> um vídeo aqui ou <strong>clique para selecionar</strong></p>
          <p>Formatos aceitos: <strong>.mp4</strong>, <strong>.mkv</strong>, <strong>.mov</strong></p>
        </div>
        <div class="file-meta" id="file-meta">
          <div class="meta-row"><span>Arquivo</span><span id="file-name">-</span></div>
          <div class="meta-row"><span>Tamanho</span><span id="file-size">-</span></div>
          <div class="meta-row"><span>Tipo</span><span id="file-type">-</span></div>
        </div>
        <div class="file-warning" id="file-warning"></div>
        <div class="error-banner" id="token-warning">
          Configure e salve o API Token acima antes de iniciar o upload.
        </div>
      </section>

      <section class="card">
        <h2>2 &middot; Sessão TUS (upload resumível)</h2>
        <div class="progress-shell" id="progress-shell">
          <div class="progress-top">
            <span>Progresso</span>
            <span id="upload-id-label">Upload-ID: <b class="upload-id" id="upload-id">-</b></span>
          </div>
          <div class="progress-track">
            <div id="progress-bar"></div>
          </div>
          <div class="progress-stats">
            <span class="stat"><b id="progress-percent">0%</b></span>
            <span class="stat"><b id="stat-sent">0 B</b> / <b id="stat-total">0 B</b></span>
            <span class="stat">Velocidade: <b id="stat-speed">-</b></span>
            <span class="stat">ETA: <b id="stat-eta">-</b></span>
          </div>
        </div>
        <div class="actions" id="upload-actions">
          <button id="start-upload" type="button">Iniciar Upload</button>
          <button id="pause-upload" class="ghost" type="button" disabled>Pausar</button>
          <button id="resume-upload" class="ghost" type="button" disabled>Retomar</button>
          <button id="cancel-upload" class="danger" type="button" disabled>Cancelar / Novo Envio</button>
        </div>
      </section>

      <section class="card">
        <h2>3 &middot; Live Tracker do Job</h2>
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <span id="job-status-badge">-</span>
          <span class="upload-id" style="color:var(--text-dim);font-size:12px;" id="job-id-label"></span>
        </div>
        <div class="timeline" id="live-tracker">
          <span class="step" data-step="UPLOADING">Uploading</span>
          <span class="step" data-step="UPLOAD_COMPLETED">Upload OK</span>
          <span class="step" data-step="PROCESSING">Processing</span>
          <span class="step" data-step="COMPLETED">Concluído</span>
          <span class="step" data-step="FAILED">Falhou</span>
        </div>
        <div class="error-banner" id="job-error"></div>
        <div id="validation-report">
          <h3 style="font-size:12px;letter-spacing:1px;text-transform:uppercase;color:var(--text-dim);margin:0;">Relatório de Validação Técnica</h3>
          <div class="report-grid" id="validation-grid"></div>
          <div id="validation-error"></div>
        </div>
        <ul id="event-log"></ul>
      </section>
    </main>

    <footer>Delivery Core &middot; TUS 1.0.0 &middot; Ingestão Resumível de Mídia</footer>

    <script src="/tus.min.js"></script>
    <script>
      if (typeof tus === "undefined") {
        document.write('<script src="${CDN_TUS_FALLBACK}"><\\/script>');
      }
    </script>
    <script>
      (function () {
        "use strict";

        var appConfig = {};
        try {
          appConfig = JSON.parse(document.getElementById("app-config").textContent || "{}");
        } catch (e) { appConfig = {}; }
        var UPLOAD_PATH = appConfig.uploadPath || "/uploads";
        var TOKEN_KEY = "delivery-core.apiToken";
        var ALLOWED_EXT = [".mp4", ".mkv", ".mov"];
        var POLL_INTERVAL_MS = 1500;

        var els = {
          tokenInput: document.getElementById("token-input"),
          saveToken: document.getElementById("save-token"),
          tokenStatus: document.getElementById("token-status"),
          dropzone: document.getElementById("dropzone"),
          fileInput: document.getElementById("file-input"),
          fileMeta: document.getElementById("file-meta"),
          fileName: document.getElementById("file-name"),
          fileSize: document.getElementById("file-size"),
          fileType: document.getElementById("file-type"),
          fileWarning: document.getElementById("file-warning"),
          tokenWarning: document.getElementById("token-warning"),
          progressShell: document.getElementById("progress-shell"),
          progressBar: document.getElementById("progress-bar"),
          progressPercent: document.getElementById("progress-percent"),
          statSent: document.getElementById("stat-sent"),
          statTotal: document.getElementById("stat-total"),
          statSpeed: document.getElementById("stat-speed"),
          statEta: document.getElementById("stat-eta"),
          uploadId: document.getElementById("upload-id"),
          actions: document.getElementById("upload-actions"),
          startUpload: document.getElementById("start-upload"),
          pauseUpload: document.getElementById("pause-upload"),
          resumeUpload: document.getElementById("resume-upload"),
          cancelUpload: document.getElementById("cancel-upload"),
          jobStatusBadge: document.getElementById("job-status-badge"),
          jobIdLabel: document.getElementById("job-id-label"),
          liveTracker: document.getElementById("live-tracker"),
          jobError: document.getElementById("job-error"),
          validationReport: document.getElementById("validation-report"),
          validationGrid: document.getElementById("validation-grid"),
          validationError: document.getElementById("validation-error"),
          eventLog: document.getElementById("event-log"),
          toast: document.getElementById("toast")
        };

        var state = {
          file: null,
          upload: null,
          uploadUrl: null,
          uploadId: null,
          completed: false,
          uploadStartedAt: null,
          lastBytes: 0,
          lastTime: 0,
          speed: 0,
          pollTimer: null,
          lastJobStatus: null,
          pollStopped: false
        };

        function showToast(message, kind) {
          if (!els.toast) {
            var t = document.createElement("div");
            t.id = "toast";
            t.className = "toast";
            document.body.appendChild(t);
            els.toast = t;
          }
          els.toast.textContent = message;
          els.toast.className = "toast " + (kind || "");
          els.toast.classList.add("show");
          clearTimeout(els.toast._timer);
          els.toast._timer = setTimeout(function () {
            els.toast.classList.remove("show");
          }, 4200);
        }

        function formatBytes(bytes) {
          if (typeof bytes !== "number" || !isFinite(bytes) || bytes < 0) return "-";
          if (bytes === 0) return "0 B";
          var units = ["B", "KB", "MB", "GB", "TB"];
          var i = Math.floor(Math.log(bytes) / Math.log(1024));
          if (i >= units.length) i = units.length - 1;
          var value = bytes / Math.pow(1024, i);
          return (i === 0 ? Math.round(value) : value.toFixed(1)) + " " + units[i];
        }

        function formatEta(seconds) {
          if (typeof seconds !== "number" || !isFinite(seconds) || seconds < 0) return "-";
          seconds = Math.round(seconds);
          if (seconds < 60) return seconds + "s";
          var m = Math.floor(seconds / 60);
          var s = seconds % 60;
          if (m < 60) return m + "m " + s + "s";
          var h = Math.floor(m / 60);
          m = m % 60;
          return h + "h " + m + "m";
        }

        function now() {
          var d = new Date();
          function pad(n) { return (n < 10 ? "0" : "") + n; }
          return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
        }

        function logEvent(message, kind) {
          var li = document.createElement("li");
          if (kind) {
            li.className = kind;
          }
          var ts = document.createElement("span");
          ts.className = "ts";
          ts.textContent = "[" + now() + "]";
          li.appendChild(ts);
          li.appendChild(document.createTextNode(message));
          els.eventLog.appendChild(li);
          while (els.eventLog.children.length > 200) {
            els.eventLog.removeChild(els.eventLog.firstChild);
          }
          els.eventLog.scrollTop = els.eventLog.scrollHeight;
        }

        function getToken() {
          return (els.tokenInput.value || "").trim();
        }

        function saveToken() {
          var token = getToken();
          if (token.length === 0) {
            localStorage.removeItem(TOKEN_KEY);
            els.tokenInput.value = "";
            els.tokenStatus.textContent = "Não configurado";
            els.tokenStatus.style.background = "rgba(148,163,184,0.3)";
            els.tokenStatus.style.color = "var(--text-dim)";
            els.tokenInput.classList.remove("invalid");
            els.tokenWarning.classList.remove("visible");
            showToast("API Token removido.");
            return;
          }
          localStorage.setItem(TOKEN_KEY, token);
          els.tokenStatus.textContent = "Token configurado";
          els.tokenStatus.style.background = "var(--success)";
          els.tokenStatus.style.color = "#064e3b";
          els.tokenInput.classList.remove("invalid");
          els.tokenWarning.classList.remove("visible");
          showToast("API Token salvo e persistido no navegador.", "success");
        }

        function loadToken() {
          try {
            var urlParams = new URLSearchParams(window.location.search);
            var queryToken = urlParams.get("token");
            if (queryToken && queryToken.trim().length > 0) {
              localStorage.setItem(TOKEN_KEY, queryToken.trim());
            }
          } catch (e) {
            // Ignora se não tiver suporte a URLSearchParams
          }
          var stored = localStorage.getItem(TOKEN_KEY);
          if (stored) {
            els.tokenInput.value = stored;
            els.tokenStatus.textContent = "Token configurado";
            els.tokenStatus.style.background = "var(--success)";
            els.tokenStatus.style.color = "#064e3b";
          }
        }

        function isAllowed(file) {
          var name = (file.name || "").toLowerCase();
          return ALLOWED_EXT.some(function (ext) { return name.endsWith(ext); });
        }

        function resetFileSelector() {
          state.file = null;
          state.uploadUrl = null;
          state.uploadId = null;
          state.completed = false;
          state.uploadStartedAt = null;
          state.lastBytes = 0;
          state.lastTime = 0;
          state.speed = 0;
          els.fileInput.value = "";
          els.fileMeta.classList.remove("visible");
          els.fileWarning.classList.remove("visible");
          els.progressShell.classList.remove("visible");
          els.actions.classList.remove("visible");
          els.progressBar.style.width = "0%";
          els.progressPercent.textContent = "0%";
          els.statSent.textContent = "0 B";
          els.statTotal.textContent = "0 B";
          els.statSpeed.textContent = "-";
          els.statEta.textContent = "-";
          els.uploadId.textContent = "-";
          els.jobStatusBadge.classList.remove("visible");
          els.jobError.classList.remove("visible");
          els.validationReport.classList.remove("visible");
          els.validationGrid.innerHTML = "";
          els.validationError.innerHTML = "";
          stopPolling();
          setControls();
        }

        function selectFile(file) {
          if (!file) return;
          if (!isAllowed(file)) {
            els.fileWarning.textContent = "Formato não permitido: " + file.name + ". Aceitos: .mp4, .mkv, .mov";
            els.fileWarning.classList.add("visible");
            els.fileMeta.classList.remove("visible");
            state.file = null;
            els.actions.classList.remove("visible");
            return;
          }
          els.fileWarning.classList.remove("visible");
          state.file = file;
          els.fileName.textContent = file.name;
          els.fileSize.textContent = formatBytes(file.size);
          els.fileType.textContent = file.type || "desconhecido";
          els.fileMeta.classList.add("visible");
          els.actions.classList.add("visible");
          els.startUpload.disabled = false;
          showToast("Arquivo selecionado: " + file.name, "success");
        }

        function setControls() {
          var hasFile = state.file !== null;
          var active = state.upload !== null && !state.completed;
          var pauseable = active && els.pauseUpload.dataset.paused !== "true";
          els.startUpload.disabled = !hasFile || active;
          els.pauseUpload.disabled = !pauseable;
          els.resumeUpload.disabled = !(active && els.pauseUpload.dataset.paused === "true");
          els.cancelUpload.disabled = !(hasFile || active);
        }

        function startUpload() {
          var token = getToken();
          if (token.length === 0) {
            els.tokenInput.classList.add("invalid");
            els.tokenWarning.classList.add("visible");
            els.tokenInput.focus();
            showToast("Configure o API Token antes de iniciar o upload.", "danger");
            return;
          }
          if (!state.file) return;
          if (typeof tus === "undefined" || !tus.Upload) {
            showToast("Biblioteca tus-js-client não carregada do CDN. Verifique a conexão.", "danger");
            return;
          }
          els.tokenInput.classList.remove("invalid");
          els.tokenWarning.classList.remove("visible");

          var chunkSize = 10 * 1024 * 1024;
          state.uploadStartedAt = Date.now();
          state.lastBytes = 0;
          state.lastTime = state.uploadStartedAt;
          state.speed = 0;

          var upload = new tus.Upload(state.file, {
            endpoint: UPLOAD_PATH,
            chunkSize: chunkSize,
            retryDelays: [0, 1000, 3000, 5000],
            headers: { authorization: "Bearer " + token },
            metadata: {
              filename: state.file.name,
              filetype: state.file.type || "video"
            },
            onError: function (error) {
              logEvent("Erro no upload: " + error.message, "err");
              if (error && error.originalResponse && error.originalResponse.getStatus() === 401) {
                handleUnauthorized(false);
              } else {
                showToast("Falha no upload: " + error.message, "danger");
              }
              setControls();
            },
            onProgress: function (bytesSent, bytesTotal) {
              if (bytesTotal <= 0) return;
              var percent = Math.floor((bytesSent / bytesTotal) * 100);
              els.progressBar.style.width = percent + "%";
              els.progressPercent.textContent = percent + "%";
              els.statSent.textContent = formatBytes(bytesSent);
              els.statTotal.textContent = formatBytes(bytesTotal);
              var elapsed = (Date.now() - state.lastTime) / 1000;
              if (elapsed >= 1) {
                state.speed = (bytesSent - state.lastBytes) / elapsed;
                state.lastBytes = bytesSent;
                state.lastTime = Date.now();
              }
              var nowMs = Date.now();
              var totalElapsed = (nowMs - state.uploadStartedAt) / 1000;
              if (totalElapsed > 0 && bytesSent > 0) {
                var avg = bytesSent / totalElapsed;
                var remaining = bytesTotal - bytesSent;
                els.statSpeed.textContent = (avg / (1024 * 1024)).toFixed(2) + " MB/s";
                els.statEta.textContent = formatEta(remaining / avg);
              }
            },
            onChunkComplete: function (chunkSize2, bytesAccepted, bytesTotal) {
              logEvent("Chunk completo: +" + formatBytes(bytesAccepted) + " (total " + formatBytes(bytesTotal) + ")");
            },
            onUploadStart: function () {
              state.uploadUrl = upload.url || null;
              if (state.uploadUrl) {
                state.uploadId = state.uploadUrl.split("/").pop();
                els.uploadId.textContent = state.uploadId;
                els.progressShell.classList.add("visible");
                logEvent("Sessão TUS criada: " + state.uploadUrl);
              }
            },
            onSuccess: function () {
              state.completed = true;
              state.upload = null;
              els.progressBar.style.width = "100%";
              els.progressPercent.textContent = "100%";
              els.statTotal.textContent = formatBytes(state.file.size);
              els.statSent.textContent = formatBytes(state.file.size);
              els.progressShell.classList.add("visible");
              var url = upload.url || state.uploadUrl;
              if (!state.uploadId && url) {
                state.uploadId = url.split("/").pop();
                els.uploadId.textContent = state.uploadId;
              }
              logEvent("Upload concluído: 100% (" + formatBytes(state.file.size) + ")", "ok");
              showToast("Upload concluído! Iniciando monitoramento do job.", "success");
              setControls();
              if (state.uploadId) {
                startPolling(state.uploadId);
              }
            }
          });

          state.upload = upload;
          els.pauseUpload.dataset.paused = "false";
          els.actions.classList.add("visible");
          els.progressShell.classList.add("visible");
          setControls();
          logEvent("Iniciando upload de " + state.file.name + " (" + formatBytes(state.file.size) + ")");
          upload.start();
        }

        function pauseUpload() {
          if (!state.upload || state.completed) return;
          state.upload.abort();
          els.pauseUpload.dataset.paused = "true";
          setControls();
          logEvent("Upload pausado. Offset preservado no servidor.", "warn");
        }

        function resumeUpload() {
          if (!state.upload || state.completed) return;
          els.pauseUpload.dataset.paused = "false";
          state.lastBytes = 0;
          state.lastTime = Date.now();
          state.upload.start();
          setControls();
          logEvent("Retomando upload a partir do offset confirmado (HEAD).");
        }

        function cancelUpload() {
          var wasActive = state.upload !== null && !state.completed;
          if (wasActive) {
            var url = state.upload.url || state.uploadUrl;
            state.upload.abort(true);
            if (url) {
              logEvent("Upload cancelado com DELETE TUS em " + url, "warn");
            } else {
              logEvent("Upload abortado antes da criação da sessão.", "warn");
            }
          }
          state.upload = null;
          stopPolling();
          resetFileSelector();
          showToast("Upload cancelado. Selecione um novo arquivo.");
        }

        function handleUnauthorized(isPoll) {
          if (state.pollTimer) {
            stopPolling();
          }
          els.tokenInput.classList.add("invalid");
          els.tokenWarning.classList.add("visible");
          if (isPoll) {
            logEvent("Resposta 401 (token inválido/expirado). Monitoramento suspenso.", "err");
          } else {
            logEvent("Resposta 401 (token inválido/expirado).", "err");
          }
          showToast("Token rejeitado pela API (401). Revise o API Token salvo.", "danger");
          setControls();
        }

        function authHeaders() {
          return { Authorization: "Bearer " + getToken() };
        }

        function startPolling(uploadId) {
          stopPolling();
          state.pollStopped = false;
          logEvent("Monitoramento do job iniciado para " + uploadId + ".");
          pollJob(uploadId);
          pollValidation(uploadId);
          state.pollTimer = setInterval(function () {
            if (state.pollStopped) return;
            pollJob(uploadId);
            pollValidation(uploadId);
          }, POLL_INTERVAL_MS);
        }

        function stopPolling() {
          state.pollStopped = true;
          if (state.pollTimer) {
            clearInterval(state.pollTimer);
            state.pollTimer = null;
          }
        }

        function pollJob(uploadId) {
          fetch(UPLOAD_PATH + "/" + encodeURIComponent(uploadId) + "/job", { headers: authHeaders() })
            .then(function (res) {
              if (res.status === 401) {
                handleUnauthorized(true);
                return null;
              }
              return res.json();
            })
            .then(function (job) {
              if (job) renderJob(job);
            })
            .catch(function (e) {
              logEvent("Erro ao consultar o job: " + (e && e.message ? e.message : e), "err");
            });
        }

        function pollValidation(uploadId) {
          fetch(UPLOAD_PATH + "/" + encodeURIComponent(uploadId) + "/validation", { headers: authHeaders() })
            .then(function (res) {
              if (res.status === 401) {
                handleUnauthorized(true);
                return null;
              }
              if (res.status === 404) return null;
              return res.json();
            })
            .then(function (report) {
              if (report) renderValidation(report);
            })
            .catch(function (e) {
              logEvent("Erro ao consultar a validação: " + (e && e.message ? e.message : e), "err");
            });
        }

        function renderJob(job) {
          if (!job || !job.status) return;
          if (state.lastJobStatus !== job.status) {
            logEvent("Job " + job.uploadId + " -> " + job.status);
            state.lastJobStatus = job.status;
          }
          var badge = els.jobStatusBadge;
          badge.textContent = job.status;
          badge.classList.add("visible");
          badge.style.background = "var(--text-dim)";
          badge.style.color = "#0f172a";
          if (job.status === "FAILED" || job.status === "COMPLETED") {
            stopPolling();
            logEvent("Monitoramento encerrado (estado terminal: " + job.status + ").");
          }
          if (job.status === "FAILED") {
            badge.style.background = "var(--danger)";
            badge.style.color = "#fff";
            if (job.error) {
              els.jobError.textContent = "Falha: [" + (job.error.code || "") + "] " + (job.error.message || "");
              els.jobError.classList.add("visible");
            }
          } else if (job.status === "COMPLETED") {
            badge.style.background = "var(--success)";
            badge.style.color = "#064e3b";
          } else {
            badge.style.background = "linear-gradient(90deg, var(--accent), var(--accent-2))";
            badge.style.color = "#fff";
          }
          els.jobIdLabel.textContent = "Job-ID: " + (job.jobId || "-");
          var steps = els.liveTracker.querySelectorAll(".step");
          var order = ["UPLOADING", "UPLOAD_COMPLETED", "PROCESSING", "COMPLETED", "FAILED"];
          order.forEach(function (name) {
            var el = null;
            for (var i = 0; i < steps.length; i++) {
              if (steps[i].getAttribute("data-step") === name) {
                el = steps[i];
              }
            }
            if (!el) return;
            el.classList.remove("done", "active", "failed");
            if (name === "FAILED" && job.status === "FAILED") {
              el.classList.add("failed");
            } else if (job.status === "COMPLETED" && name !== "FAILED") {
              el.classList.add("done");
            } else if (job.status === name) {
              el.classList.add("active");
            } else if (
              job.status !== "FAILED" &&
              job.transitions &&
              job.transitions.some(function (t) { return t.to === name; })
            ) {
              el.classList.add("done");
            }
          });
        }

        function renderValidation(report) {
          if (!report) return;
          if (report.status === "VALID" && report.metadata) {
            els.validationReport.classList.add("visible");
            var meta = report.metadata;
            var rows = [
              ["Resolução", meta.resolution ? meta.resolution.width + " x " + meta.resolution.height : "-"],
              ["Codec de vídeo", meta.videoCodec || "-"],
              ["Framerate", meta.framerate ? meta.framerate + " fps" : "-"],
              ["Duração", (typeof meta.duration === "number" ? meta.duration.toFixed(1) + "s" : "-")],
              ["Áudio", meta.hasAudio ? "Sim (" + (meta.audioChannels || 0) + " ch)" : "Não"],
              ["Codec de áudio", meta.audioCodec || "-"],
              ["Container", meta.containerFormat || "-"],
              ["Bitrate", meta.bitrate ? Math.round(meta.bitrate / 1000) + " kbps" : "-"]
            ];
            var html = "";
            rows.forEach(function (row) {
              html += '<div class="cell"><span>' + row[0] + '</span>' + row[1] + '</div>';
            });
            els.validationGrid.innerHTML = html;
            els.validationError.innerHTML = "";
            logEvent("Relatório de validação recebido: VALID");
          } else if (report.status === "REJECTED" || report.error) {
            els.validationReport.classList.add("visible");
            els.validationError.innerHTML = '<div class="error-banner visible">Validação rejeitada: [' +
              (report.error && report.error.code ? report.error.code : "?") + "] " +
              (report.error && report.error.message ? report.error.message : "recusada pelo probe") + '</div>';
            logEvent("Relatório de validação recebido: REJECTED", "err");
          }
        }

        els.saveToken.addEventListener("click", saveToken);
        els.tokenInput.addEventListener("keydown", function (e) {
          if (e.key === "Enter") saveToken();
        });
        els.dropzone.addEventListener("click", function (e) {
          if (e.target !== els.fileInput) els.fileInput.click();
        });
        els.dropzone.addEventListener("keydown", function (e) {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            els.fileInput.click();
          }
        });
        els.fileInput.addEventListener("change", function () {
          if (els.fileInput.files && els.fileInput.files.length > 0) {
            selectFile(els.fileInput.files[0]);
          }
        });
        ["dragenter", "dragover"].forEach(function (name) {
          els.dropzone.addEventListener(name, function (e) {
            e.preventDefault();
            els.dropzone.classList.add("dragover");
          });
        });
        ["dragleave", "drop"].forEach(function (name) {
          els.dropzone.addEventListener(name, function (e) {
            e.preventDefault();
            els.dropzone.classList.remove("dragover");
          });
        });
        els.dropzone.addEventListener("drop", function (e) {
          var files = e.dataTransfer.files;
          if (files && files.length > 0) {
            selectFile(files[0]);
          }
        });
        els.startUpload.addEventListener("click", startUpload);
        els.pauseUpload.addEventListener("click", pauseUpload);
        els.resumeUpload.addEventListener("click", resumeUpload);
        els.cancelUpload.addEventListener("click", cancelUpload);

        loadToken();
        logEvent("Interface carregada. Pronta para ingestão.");
      })();
    </script>
  </body>
</html>
`;
}