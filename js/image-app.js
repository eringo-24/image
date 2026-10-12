/**
 * image-app.js  ―  画面操作（DOM）担当
 * 画像処理そのものは image-editor.js（ImageEditor）に任せ、ここでは
 * 「読み込み → 小画像/大画像カードの操作 → 書き出し結果の確認」だけを扱う。
 */
(function () {
  "use strict";
  const { SPECS, HEAD_GUIDE_RATIO } = ImageEditor;

  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ---------- 共有状態 ---------- */
  const state = { img: null, objectUrl: null, fileName: "", sourceKB: null };

  const urlInput   = $("#recordUrl");
  const idPreview  = $("#idPreview");
  const fileInput  = $("#imgFile");
  const dropZone   = $("#dropZone");
  const sourceInfo = $("#sourceInfo");
  const cardsEl    = $("#cards");
  const exportAllBtn = $("#exportAllBtn");
  const exportAllStatus = $("#exportAllStatus");

  /* ============================================================
     小画像／大画像カード
     ============================================================ */
  class Card {
    constructor(spec) {
      this.spec = spec;
      this.refiner = null;
      this.resultUrl = null;
      this.root = document.createElement("section");
      this.root.className = "panel card";
      this.root.innerHTML = `
        <h2>${spec.label}（${spec.ratioText}・${spec.targetKB}KB前後）</h2>

        <div class="crop-stage">
          <canvas width="${spec.w}" height="${spec.h}" aria-label="${spec.label}のクロップ画面"></canvas>
          <div class="crop-guide" style="top:${HEAD_GUIDE_RATIO * 100}%" aria-hidden="true"><span>頭上の余白（こぶし1個分）</span></div>
          <div class="crop-empty">画像を読み込むとここに表示されます</div>
        </div>

        <label class="check"><input type="checkbox" class="guide-toggle" checked>
          頭上ガイド線を表示する（表示専用・書き出した画像には入りません）</label>

        <div class="note upscale" hidden>元画像の解像度を超えて拡大しています（粗く見える原因になります）。位置取りや拡大率を見直すか、元画像を確認してください。</div>

        <div class="ctl">
          <label>拡大率</label>
          <input type="range" class="zoom" min="10" max="400" value="100" disabled>
          <span class="zoom-val">100%</span>
        </div>
        <div class="runbar tight">
          <button type="button" class="run secondary btn-cover" disabled>フレームを埋める</button>
          <button type="button" class="run secondary btn-contain" disabled>全体を収める（余白あり）</button>
        </div>
        <div class="hint">ドラッグで位置調整、ホイールまたはスライダーで拡大縮小。全体を収めると、余った部分は白い余白になります。</div>

        <div class="sep"></div>

        <div class="runbar tight">
          <button type="button" class="run secondary btn-blur" disabled>背景をぼかす（任意）</button>
          <button type="button" class="run secondary btn-unblur" hidden>ぼかしを取り消す</button>
          <span class="status blur-status" aria-live="polite"></span>
        </div>
        <div class="runbar tight brush" hidden>
          <label>ブラシ</label>
          <select class="brush-mode">
            <option value="reveal-sharp">くっきり戻す</option>
            <option value="restore-blur">ぼかしを戻す</option>
          </select>
          <label>サイズ</label>
          <input type="range" class="brush-size" min="5" max="80" value="25">
        </div>

        <div class="sep"></div>

        <div class="runbar">
          <button type="button" class="run btn-export" disabled>${spec.label}を書き出し</button>
          <span class="status export-status" aria-live="polite"></span>
        </div>
        <div class="result"></div>
      `;
      this.canvas = $("canvas", this.root);
      this.stage = new ImageEditor.CropStage(this.canvas);
      this.stage.onChange = () => this._syncZoom();
      this.stage.render(); // 白地を描いておく
      this._wire();
    }

    /* ----- 部品の取得 ----- */
    q(sel) { return $(sel, this.root); }

    _wire() {
      const zoom = this.q(".zoom");
      zoom.addEventListener("input", () => this.stage.setZoomPercent(Number(zoom.value)));
      this.q(".btn-cover").addEventListener("click", () => this.stage.fitCover());
      this.q(".btn-contain").addEventListener("click", () => this.stage.fitContain());

      const guide = $(".crop-guide", this.root);
      this.q(".guide-toggle").addEventListener("change", e => { guide.hidden = !e.target.checked; });

      this.q(".btn-blur").addEventListener("click", () => this.applyBlur());
      this.q(".btn-unblur").addEventListener("click", () => this.removeBlur());
      this.q(".brush-mode").addEventListener("change", e => this.refiner && this.refiner.setMode(e.target.value));
      this.q(".brush-size").addEventListener("input", () => this.refiner && this.refiner.setBrushSize(this._brushPx()));
      this.q(".btn-export").addEventListener("click", () => this.exportImage());
    }

    // ブラシの大きさ（スライダー値は表示幅480px基準 → 作業用キャンバスの画素数に換算）
    _brushPx() { return Number(this.q(".brush-size").value) * (this.canvas.width / 480); }

    _syncZoom() {
      const z = Math.round(this.stage.zoomPercent);
      this.q(".zoom").value = Math.min(400, Math.max(10, z));
      this.q(".zoom-val").textContent = z + "%";
      // 元画像を「基準の幅(refW)」より粗く引き伸ばしている間は注意を出す
      const refScale = this.stage.scale * (this.spec.refW / this.canvas.width);
      this.q(".upscale").hidden = !(this.stage.img && refScale > 1.0001);
    }

    /* ----- 新しい画像を受け取る ----- */
    setImage(img) {
      this._clearBlurUi();
      this.stage.loadImage(img);
      this.q(".crop-empty").hidden = true;
      this.q(".zoom").disabled = false;
      this.q(".btn-cover").disabled = false;
      this.q(".btn-contain").disabled = false;
      this.q(".btn-blur").disabled = false;
      this.q(".btn-export").disabled = false;
      this._clearResult();
      this.q(".export-status").textContent = "";
    }

    /* ----- 背景ぼかし ----- */
    async applyBlur() {
      if (!state.img) return;
      const btn = this.q(".btn-blur"), st = this.q(".blur-status");
      btn.disabled = true;
      st.textContent = "背景ぼかしモデルを読み込み中…（初回のみ数十秒かかる場合があります）";
      try {
        this.stage.freeze();
        const { sharp, blurred } = await ImageEditor.makeBlurLayers(this.canvas);
        if (this.refiner) this.refiner.dispose();
        this.refiner = new ImageEditor.BlurRefiner(this.canvas, sharp, blurred);
        this.refiner.setMode(this.q(".brush-mode").value);
        this.refiner.setBrushSize(this._brushPx());
        this.q(".brush").hidden = false;
        this.q(".btn-unblur").hidden = false;
        this.q(".zoom").disabled = true;
        this.q(".btn-cover").disabled = true;
        this.q(".btn-contain").disabled = true;
        st.textContent = "人物以外を自動でぼかしました。必要ならブラシで微調整してください（位置・拡大率はぼかしを取り消すと変更できます）。";
      } catch (err) {
        this.stage.unfreeze();
        st.textContent = "背景ぼかしに失敗しました：" + (err.message || err);
        btn.disabled = false;
      }
    }
    removeBlur() {
      this._clearBlurUi();
      this.stage.unfreeze();
      this.stage.render();
      this.q(".zoom").disabled = false;
      this.q(".btn-cover").disabled = false;
      this.q(".btn-contain").disabled = false;
    }
    _clearBlurUi() {
      if (this.refiner) { this.refiner.dispose(); this.refiner = null; }
      this.q(".brush").hidden = true;
      this.q(".btn-unblur").hidden = true;
      this.q(".blur-status").textContent = "";
      this.q(".btn-blur").disabled = !state.img;
    }

    /* ----- 書き出し ----- */
    _clearResult() {
      if (this.resultUrl) { URL.revokeObjectURL(this.resultUrl); this.resultUrl = null; }
      this.q(".result").innerHTML = "";
    }

    async exportImage() {
      if (!state.img) { this.q(".export-status").textContent = "先に画像を選択してください。"; return false; }
      const btn = this.q(".btn-export"), st = this.q(".export-status");
      btn.disabled = true;
      st.textContent = "指定サイズに調整中…";
      try {
        const spec = this.spec;
        const r = await ImageEditor.compressToSpec(this.canvas, spec, state.sourceKB);
        const id = ImageEditor.extractIdFromUrl(urlInput.value);
        const filename = ImageEditor.buildFileName(id, spec.key);

        ImageEditor.downloadBlob(r.blob, filename);
        this._showResult(r, filename, !!id);
        st.textContent = "ダウンロードしました。";
        return true;
      } catch (err) {
        this.q(".result").innerHTML = `<div class="raw-error">${esc(err.message || err)}</div>`;
        st.textContent = "エラーが発生しました。";
        return false;
      } finally {
        btn.disabled = false;
      }
    }

    _showResult(r, filename, hasId) {
      this._clearResult();
      this.resultUrl = URL.createObjectURL(r.blob);
      const spec = this.spec;

      // 自動で判定できる項目
      const ratioOk = Math.abs(r.width / r.height - spec.w / spec.h) < 0.005;
      const range = `規定 ${spec.minKB}〜${spec.maxKB}KB`;
      const sizeLine = r.status === "ok"
        ? `<li class="ok">✔ ファイルサイズ ${r.kb.toFixed(1)}KB（${range}${r.downscaled ? "" : "／サイズ調整不要の範囲"}）</li>`
        : r.status === "over"
          ? `<li class="ng">✖ ファイルサイズ ${r.kb.toFixed(1)}KB は大きすぎます（${range}）。解像度を縮小しても収まりませんでした。元画像を確認してください</li>`
          : `<li class="ng">✖ ファイルサイズ ${r.kb.toFixed(1)}KB は規定の下限未満です（${range}）。元画像が小さい可能性があります。小さい写真を大きくして合わせることは禁止です。リーダーに確認してください</li>`;
      const capLine = r.cappedBySource
        ? `<li class="warn">！ 元画像（${state.sourceKB.toFixed(0)}KB）より大きくならないよう調整しました</li>`
        : "";
      const ratioLine = ratioOk
        ? `<li class="ok">✔ ${spec.ratioText}（${r.width}×${r.height}px）</li>`
        : `<li class="ng">✖ 縦横比が ${spec.ratioText} になっていません（${r.width}×${r.height}px）</li>`;
      const idLine = hasId
        ? ""
        : `<li class="ng">✖ 元データURLからIDを取得できなかったため、ファイル名が「${esc(filename)}」になっています。上のURL欄を確認して書き出し直してください</li>`;
      const scaleLine = r.downscaled
        ? `<li class="info">規定のKBに収めるため ${r.width}×${r.height}px に縮小しました（縦横比はそのまま）</li>`
        : "";

      // 人の目で確認する項目（マニュアル「画像確認」）
      const manual = spec.key === "small"
        ? ["肩まで写っているか", "元画像と同じ生徒であるか"]
        : ["賞状が映りきっているか", "頭が切れていないか"];
      const manualHtml = manual.map(t => `<li><label class="check"><input type="checkbox"> ${t}</label></li>`).join("");

      this.q(".result").innerHTML = `
        <div class="result-block">
          <h3>書き出し結果</h3>
          <div class="result-body">
            <img src="${this.resultUrl}" alt="書き出した${spec.label}" class="result-img">
            <div>
              <div class="fname">${esc(filename)}</div>
              <ul class="checks">${idLine}${sizeLine}${ratioLine}${capLine}${scaleLine}</ul>
              <div class="hint" style="margin-top:8px;">左の画像が実際に保存された内容です。目視で確認してください：</div>
              <ul class="checks manual">${manualHtml}</ul>
            </div>
          </div>
        </div>`;
    }
  }

  /* ---------- カードを生成して並べる ---------- */
  const cards = Object.values(SPECS).map(spec => {
    const c = new Card(spec);
    cardsEl.appendChild(c.root);
    return c;
  });

  /* ============================================================
     元画像の読み込み（ファイル選択／ドラッグ＆ドロップ／貼り付け）
     ============================================================ */
  async function handleFile(file) {
    if (!file) return;
    if (!file.type.startsWith("image/") && !/\.(jpe?g|png|webp|gif|bmp)$/i.test(file.name)) {
      sourceInfo.innerHTML = `<div class="raw-error">画像ファイルを選択してください（${esc(file.name)}）。</div>`;
      return;
    }
    try {
      const { img, url } = await ImageEditor.loadImageFromFile(file);
      if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
      state.img = img; state.objectUrl = url; state.fileName = file.name || "貼り付けた画像";
      state.sourceKB = file.size / 1024;

      const info = ImageEditor.inspectSource(file, img);
      const warn = info.warnings.map(w => `<div class="${w.level === "error" ? "warn" : "note"}">${esc(w.text)}</div>`).join("");
      sourceInfo.innerHTML = `
        <div class="src-line"><strong>${esc(state.fileName)}</strong>
          <span>${info.width}×${info.height}px ／ ${info.kb.toFixed(0)}KB</span></div>${warn}`;

      cards.forEach(c => c.setImage(img));
      exportAllBtn.disabled = false;
      exportAllStatus.textContent = "";
    } catch (err) {
      sourceInfo.innerHTML = `<div class="raw-error">${esc(err.message || err)}</div>`;
    }
  }

  fileInput.addEventListener("change", () => handleFile(fileInput.files[0]));

  ["dragenter", "dragover"].forEach(ev => dropZone.addEventListener(ev, e => {
    e.preventDefault(); dropZone.classList.add("over");
  }));
  ["dragleave", "drop"].forEach(ev => dropZone.addEventListener(ev, e => {
    e.preventDefault(); dropZone.classList.remove("over");
  }));
  dropZone.addEventListener("drop", e => handleFile(e.dataTransfer.files[0]));
  // 画面のどこにドロップしてもブラウザが画像を開いてしまわないようにする
  window.addEventListener("dragover", e => e.preventDefault());
  window.addEventListener("drop", e => e.preventDefault());

  // Ctrl+V / ⌘+V で、コピーした画像をそのまま貼り付け
  document.addEventListener("paste", e => {
    const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith("image/"));
    if (item) handleFile(item.getAsFile());
  });

  /* ---------- 元データURL → ファイル名プレビュー ---------- */
  function updateIdPreview() {
    const id = ImageEditor.extractIdFromUrl(urlInput.value);
    if (!urlInput.value.trim()) {
      idPreview.className = "hint";
      idPreview.textContent = "URLの id=数字（または末尾の数字、4〜6桁）をファイル名にします。例：12345 → 12345s.jpg ／ 12345l.jpg";
    } else if (id) {
      idPreview.className = "hint ok-text";
      idPreview.textContent = `ファイル名：${id}s.jpg（小）／ ${id}l.jpg（大）`;
    } else {
      idPreview.className = "hint ng-text";
      idPreview.textContent = "URLから4〜6桁のID（id=数字）が見つかりません。このままだと「untitled」で保存されます。";
    }
  }
  urlInput.addEventListener("input", updateIdPreview);
  updateIdPreview();

  /* ============================================================
     小・大をまとめて書き出し
     ============================================================ */
  exportAllBtn.addEventListener("click", async () => {
    exportAllBtn.disabled = true;
    exportAllStatus.textContent = "書き出し中…";
    let okCount = 0;
    for (const c of cards) {
      if (await c.exportImage()) okCount++;
      await new Promise(r => setTimeout(r, 300)); // 連続ダウンロードをブラウザに拒否されにくくする
    }
    exportAllStatus.textContent = okCount === cards.length
      ? "2枚ともダウンロードしました。ブラウザに「複数ファイルのダウンロード」の許可を求められた場合は許可してください。"
      : "一部の書き出しに失敗しました。各カードのメッセージを確認してください。";
    exportAllBtn.disabled = false;
  });
})();
