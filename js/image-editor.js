/**
 * image-editor.js  ―  画像処理のコア部分（画面には一切触らない）
 * ---------------------------------------------------------
 * マニュアル③「画像編集」をブラウザ内で完結させるための部品集。
 * クロップ・拡大縮小・ファイルサイズ調整・ファイル名生成は AI 不使用（Canvas API のみ）。
 * 背景ぼかしだけは、初回クリック時に軽量な人物セグメンテーションモデルを CDN から読み込む
 * （読み込み後はブラウザ内で完結。画像を外部へ送信することはない）。
 *
 * 【規格を変えたいとき】 下の SPECS だけ編集すればOKです。
 * ---------------------------------------------------------
 */

const ImageEditor = (() => {

  /* ============================================================
     規格（2026マニュアル ③-5「画素数変更」・「画像確認」より）
       小画像：正方形／肩まで写す／50KB前後
       大画像：3:2／賞状が映りきる・頭が切れない／100KB前後
       ※ 切り取った時点で 小画像 15〜50KB／大画像 30〜100KB ならサイズ変更は不要
          → minKB〜maxKB がこの「そのままでOK」の範囲。maxKB を超えるときだけ targetKB まで小さくする。
       ※ 禁止事項：小さい写真を大きくして規定サイズに合わせること（水増し）
          → 元画像のファイルサイズより大きくなるようには書き出さない。
     ============================================================ */
  /* w,h   : 作業用キャンバスの大きさ（ここから規定KBに収まるまで縮小する。マニュアルの
              「高解像度のまま切り取り → 規定サイズになるまで%を小さくする」手順に相当）
     rw:rh : 縦横比（縮小しても必ずこの比率を保つ）
     refW  : これより粗く引き伸ばすと画質が落ちる、という目安の幅（過拡大の注意に使用）  */
  const SPECS = {
    small: { key: "small", label: "小画像", suffix: "s", w: 720, h: 720, rw: 1, rh: 1, refW: 480,
             targetKB: 50,  minKB: 15, maxKB: 50,  ratioText: "正方形（1:1）" },
    large: { key: "large", label: "大画像", suffix: "l", w: 960, h: 640, rw: 3, rh: 2, refW: 480,
             targetKB: 100, minKB: 30, maxKB: 100, ratioText: "3:2" }
  };

  // 頭上の余白ガイド（こぶし1個分＝フレーム上端から約12%）。表示専用でキャンバスには描かない
  const HEAD_GUIDE_RATIO = 0.12;

  /* 元画像のファイルサイズによる扱い（2026マニュアル ③-5 注意事項）
       20KB未満 → 処理対象外 ／ 20KB代 → 広報部コメント（短文）に書き、切り取りだけ行う
       30KB以上 → 切り取ってサイズを合わせる
     ※ 旧マニュアル（作業前チェックポイント）には「10KB以下は処理対象外」という記載もあり、
        10〜20KBの間は資料によって扱いが異なるため「要確認」として警告する。 */
  const SOURCE_RULES = { rejectKB: 10, confirmKB: 20, cropOnlyKB: 30 };

  /* ============================================================
     ファイル名（元データURL末尾の数字 + s / l）
     ============================================================ */
  function extractIdFromUrl(url) {
    // 全角数字・前後の空白/改行を吸収
    const raw = String(url || "").trim()
      .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
    // 1) クエリの id=数字（例：detail.php?id=86692）を最優先
    const q = raw.match(/[?&#]id=(\d{4,6})(?=$|[&#\s])/i);
    if (q) return q[1];
    // 2) 従来形式：パス末尾の数字（例：.../86692 や .../86692/）
    const s = raw.replace(/[?#].*$/, "").replace(/\/+$/, "");
    const m = s.match(/(\d{4,6})$/);
    return m ? m[1] : "";
  }
  function buildFileName(id, kind) {
    return (id || "untitled") + SPECS[kind].suffix + ".jpg";
  }

  /* ============================================================
     画像の読み込み
     ============================================================ */
  function loadImageFromFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => resolve({ img, url });
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error(
          "画像を読み込めませんでした。HEIC など一部の形式はブラウザで開けません。JPEG または PNG で保存し直してください。"
        ));
      };
      img.src = url;
    });
  }

  /** 元画像のチェック。問題があれば日本語の警告文を配列で返す */
  function inspectSource(file, img) {
    const warnings = [];
    const kb = file.size / 1024;
    const R = SOURCE_RULES;
    if (kb <= R.rejectKB) {
      warnings.push({ level: "error",
        text: `元画像が ${kb.toFixed(1)}KB しかありません（${R.rejectKB}KB以下）。マニュアルの「処理対象外」の基準に該当します。` });
    } else if (kb < R.confirmKB) {
      warnings.push({ level: "error",
        text: `元画像が ${kb.toFixed(1)}KB です。2026マニュアルでは「${R.confirmKB}KB未満は処理対象外」ですが、旧マニュアルでは「${R.rejectKB}KB以下」とされています。リーダーに確認してください。` });
    } else if (kb < R.cropOnlyKB) {
      warnings.push({ level: "warn",
        text: `元画像が ${kb.toFixed(1)}KB（20KB代）です。広報部コメント（短文）にその旨を書き、小画像・大画像とも「切り取りだけ」行ってください（元画像より大きくなる調整はしません）。` });
    }
    const shortSide = Math.min(img.naturalWidth, img.naturalHeight);
    if (shortSide < 480) {
      warnings.push({ level: "warn",
        text: `解像度が低めです（短辺 ${shortSide}px）。拡大すると粗く見えるので、仕上がりを必ず目視で確認してください。` });
    }
    return { kb, width: img.naturalWidth, height: img.naturalHeight, warnings };
  }

  /* ============================================================
     クロップ・パン・ズームを担当するステージ
     ※ キャンバスには「画像だけ」を描く。ガイド線などの補助表示は HTML 側に重ねる。
        → 書き出し・背景ぼかしに補助線が写り込まない。
     ============================================================ */
  class CropStage {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.img = null;
      this.scale = 1;
      this.baseScale = 1;   // 「フレームを隙間なく覆う倍率（cover）」＝ 100%
      this.offsetX = 0;
      this.offsetY = 0;
      this.frozen = false;
      this.onChange = null; // 描画のたびに呼ばれる（スライダー同期用）
      this.MIN_RATIO = 0.1; // 10%
      this.MAX_RATIO = 6;   // 600%
      this._bind();
    }

    get zoomPercent() { return (this.scale / this.baseScale) * 100; }

    loadImage(img) {
      this.img = img;
      const { width: fw, height: fh } = this.canvas;
      this.baseScale = Math.max(fw / img.naturalWidth, fh / img.naturalHeight);
      this.fitCover();
    }

    /** フレームを隙間なく覆う（初期状態） */
    fitCover() {
      if (!this.img) return;
      this.frozen = false;
      this._setScaleCentered(this.baseScale);
    }

    /** 画像全体をフレームに収める（余り部分は白い余白になる＝マニュアル「余白のつけ方」） */
    fitContain() {
      if (!this.img) return;
      const { width: fw, height: fh } = this.canvas;
      this.frozen = false;
      this._setScaleCentered(Math.min(fw / this.img.naturalWidth, fh / this.img.naturalHeight));
    }

    _setScaleCentered(scale) {
      const { width: fw, height: fh } = this.canvas;
      this.scale = scale;
      this.offsetX = (fw - this.img.naturalWidth * scale) / 2;
      this.offsetY = (fh - this.img.naturalHeight * scale) / 2;
      this.render();
    }

    render() {
      const { ctx, canvas, img, scale, offsetX, offsetY } = this;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (img) ctx.drawImage(img, offsetX, offsetY, img.naturalWidth * scale, img.naturalHeight * scale);
      if (this.onChange) this.onChange();
    }

    zoomAt(cx, cy, factor) {
      if (this.frozen || !this.img) return;
      const prev = this.scale;
      const next = Math.min(this.baseScale * this.MAX_RATIO,
                   Math.max(this.baseScale * this.MIN_RATIO, prev * factor));
      this.scale = next;
      this.offsetX = cx - (cx - this.offsetX) * (next / prev);
      this.offsetY = cy - (cy - this.offsetY) * (next / prev);
      this.render();
    }

    setZoomPercent(percent) {
      if (!this.img || this.frozen) return;
      const factor = (this.baseScale * (percent / 100)) / this.scale;
      this.zoomAt(this.canvas.width / 2, this.canvas.height / 2, factor);
    }

    freeze()   { this.frozen = true; }
    unfreeze() { this.frozen = false; }

    _bind() {
      const c = this.canvas;
      let drag = null;
      c.addEventListener("pointerdown", e => {
        if (this.frozen || !this.img) return;
        drag = { x: e.clientX, y: e.clientY };
        c.setPointerCapture(e.pointerId);
        c.classList.add("grabbing");
      });
      c.addEventListener("pointermove", e => {
        if (!drag) return;
        const r = c.getBoundingClientRect();
        this.offsetX += (e.clientX - drag.x) * (c.width / r.width);
        this.offsetY += (e.clientY - drag.y) * (c.height / r.height);
        drag.x = e.clientX; drag.y = e.clientY;
        this.render();
      });
      const end = () => { drag = null; c.classList.remove("grabbing"); };
      c.addEventListener("pointerup", end);
      c.addEventListener("pointercancel", end);
      c.addEventListener("wheel", e => {
        if (this.frozen || !this.img) return;
        e.preventDefault();
        const r = c.getBoundingClientRect();
        this.zoomAt((e.clientX - r.left) * (c.width / r.width),
                    (e.clientY - r.top) * (c.height / r.height),
                    e.deltaY < 0 ? 1.06 : 0.94);
      }, { passive: false });
    }
  }

  /* ============================================================
     背景ぼかし：人物セグメンテーション（初回のみモデルを読み込む）
     ============================================================ */
  function loadScriptOnce(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) return resolve();
      const s = document.createElement("script");
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(`ライブラリの読み込みに失敗しました（ネットワーク接続を確認してください）: ${src}`));
      document.head.appendChild(s);
    });
  }

  let segmenterPromise = null;
  function getSegmenter() {
    if (segmenterPromise) return segmenterPromise;
    segmenterPromise = (async () => {
      await loadScriptOnce("https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-core@4.20.0/dist/tf-core.min.js");
      await loadScriptOnce("https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-converter@4.20.0/dist/tf-converter.min.js");
      await loadScriptOnce("https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-webgl@4.20.0/dist/tf-backend-webgl.min.js");
      await loadScriptOnce("https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/selfie_segmentation.js");
      await loadScriptOnce("https://cdn.jsdelivr.net/npm/@tensorflow-models/body-segmentation@1.0.2/dist/body-segmentation.min.js");
      return await bodySegmentation.createSegmenter(
        bodySegmentation.SupportedModels.MediaPipeSelfieSegmentation,
        { runtime: "mediapipe", solutionPath: "https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation" }
      );
    })().catch(err => { segmenterPromise = null; throw err; }); // 失敗したら次回やり直せるようにする
    return segmenterPromise;
  }

  /** いまのクロップ結果をくっきり版/ぼかし版に分けて返す */
  async function makeBlurLayers(canvas) {
    const sharp = document.createElement("canvas");
    sharp.width = canvas.width; sharp.height = canvas.height;
    sharp.getContext("2d").drawImage(canvas, 0, 0);

    const segmenter = await getSegmenter();
    const people = await segmenter.segmentPeople(sharp);

    const blurred = document.createElement("canvas");
    blurred.width = canvas.width; blurred.height = canvas.height;
    await bodySegmentation.drawBokehEffect(blurred, sharp, people,
      0.5,  // foregroundThreshold
      9,    // backgroundBlurAmount
      3);   // edgeBlurAmount
    return { sharp, blurred };
  }

  /* ブラシで「くっきり戻す／ぼかしを戻す」を微調整する */
  class BlurRefiner {
    constructor(outputCanvas, sharpCanvas, blurredCanvas) {
      this.canvas = outputCanvas;
      this.ctx = outputCanvas.getContext("2d");
      this.sharp = sharpCanvas;
      this.blurred = blurredCanvas;
      this.mode = "reveal-sharp"; // "reveal-sharp"=くっきり戻す／"restore-blur"=ぼかしを戻す
      this.brushSize = 25;
      this._ac = new AbortController();
      this.ctx.drawImage(blurredCanvas, 0, 0);
      this.canvas.classList.add("brushing");
      this._bind();
    }
    setMode(mode) { this.mode = mode; }
    setBrushSize(size) { this.brushSize = size; }
    dispose() {
      this._ac.abort();
      this.canvas.classList.remove("brushing");
    }

    _dab(x, y) {
      const src = this.mode === "reveal-sharp" ? this.sharp : this.blurred;
      const c = this.ctx;
      c.save();
      c.beginPath();
      c.arc(x, y, this.brushSize, 0, Math.PI * 2);
      c.clip();
      c.drawImage(src, 0, 0);
      c.restore();
    }
    // 速くドラッグしても線が途切れないよう、2点間を補間して塗る
    _stroke(from, to) {
      const dist = Math.hypot(to.x - from.x, to.y - from.y);
      const step = Math.max(1, this.brushSize / 3);
      const n = Math.max(1, Math.ceil(dist / step));
      for (let i = 1; i <= n; i++) {
        this._dab(from.x + (to.x - from.x) * i / n, from.y + (to.y - from.y) * i / n);
      }
    }
    _bind() {
      const c = this.canvas, opt = { signal: this._ac.signal };
      let last = null;
      const pos = e => {
        const r = c.getBoundingClientRect();
        return { x: (e.clientX - r.left) * (c.width / r.width), y: (e.clientY - r.top) * (c.height / r.height) };
      };
      c.addEventListener("pointerdown", e => {
        c.setPointerCapture(e.pointerId);
        last = pos(e); this._dab(last.x, last.y);
      }, opt);
      c.addEventListener("pointermove", e => {
        if (!last) return;
        const p = pos(e); this._stroke(last, p); last = p;
      }, opt);
      const end = () => { last = null; };
      c.addEventListener("pointerup", end, opt);
      c.addEventListener("pointercancel", end, opt);
    }
  }

  /* ============================================================
     目標ファイルサイズへの自動圧縮
     「目標KB以下で最も高い品質」を二分探索で求める（毎回同じ結果になる）。
     品質を下げても収まらない場合だけ、縦横比を保ったまま少しずつ縮小する。
     ============================================================ */
  function canvasToBlob(canvas, quality) {
    return new Promise((resolve, reject) =>
      canvas.toBlob(b => b ? resolve(b) : reject(new Error("画像の書き出しに失敗しました")), "image/jpeg", quality));
  }
  function resizeCanvas(canvas, w, h) {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(canvas, 0, 0, w, h);
    return c;
  }

  /**
   * @param {HTMLCanvasElement} sourceCanvas  クロップ済みの画像（作業用キャンバス）
   * @param {object} spec                     SPECS.small / SPECS.large
   * @param {number} [sourceKB]               元画像のファイルサイズ（KB）。これより大きくは書き出さない（水増し禁止）
   *
   * 方針（2026マニュアル ③-5 に準拠）：
   *   1. まず標準品質(0.92)・縮小なしで保存。上限以内ならそのまま採用（＝「サイズ変更しない」）
   *   2. 上限を超えるときだけ、縦横比を保ったまま縮小して上限以内で最も大きいサイズを二分探索
   *      （マニュアルの「%を小さくして規定のサイズにする」に相当。毎回同じ結果になる）
   *   3. 上限は min(規定の上限, 元画像のKB)。元画像より大きくなる水増しはしない
   *   4. 下限(minKB)に届かないときは、水増しせず status:"under" で知らせる
   */
  async function compressToSpec(sourceCanvas, spec, sourceKB) {
    const Q_KEEP = 0.92, Q_SHRINK = 0.85;
    const capKB = (sourceKB && isFinite(sourceKB)) ? Math.min(spec.targetKB, sourceKB) : spec.targetKB;
    const toKB = b => b.size / 1024;

    const sizeAt = factor => {
      const unit = Math.max(1, Math.round(spec.w * factor / spec.rw));
      return { w: spec.rw * unit, h: spec.rh * unit };
    };

    // 1) 縮小なし
    const full = await canvasToBlob(sourceCanvas, Q_KEEP);
    if (toKB(full) <= capKB) return finish(full, Q_KEEP, sourceCanvas.width, sourceCanvas.height);

    // 2) 縮小して探す（lo: 上限以内に収まる倍率 / hi: 収まらない倍率）
    let lo = 0.05, hi = 1, best = null;
    for (let i = 0; i < 10; i++) {
      const mid = (lo + hi) / 2;
      const { w, h } = sizeAt(mid);
      const c = resizeCanvas(sourceCanvas, w, h);
      const b = await canvasToBlob(c, Q_SHRINK);
      if (toKB(b) <= capKB) { lo = mid; best = { b, w, h }; } else { hi = mid; }
    }
    if (!best) {                                   // それでも収まらない（極端なケース）
      const { w, h } = sizeAt(0.05);
      best = { b: await canvasToBlob(resizeCanvas(sourceCanvas, w, h), Q_SHRINK), w, h };
    }
    return finish(best.b, Q_SHRINK, best.w, best.h);

    function finish(blob, quality, width, height) {
      const kb = blob.size / 1024;
      return {
        blob, quality, kb, width, height,
        downscaled: width < sourceCanvas.width,
        cappedBySource: capKB < spec.targetKB,     // 元画像より大きくならないよう上限を下げた
        inBand: kb >= spec.minKB && kb <= spec.maxKB,
        status: kb > spec.maxKB ? "over" : (kb < spec.minKB ? "under" : "ok")
      };
    }
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000); // 直後に解放すると保存に失敗するブラウザがある
  }

  return {
    SPECS, HEAD_GUIDE_RATIO, SOURCE_RULES,
    extractIdFromUrl, buildFileName,
    loadImageFromFile, inspectSource,
    CropStage, BlurRefiner, makeBlurLayers,
    compressToSpec, downloadBlob
  };
})();
