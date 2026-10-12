// Cloudflare Pages Functions：サイト全体にBasic認証（ユーザー名・パスワード）をかけます。
// ユーザー名・パスワードはコードに書かず、Cloudflareの「Environment variables（暗号化）」に
// CHECKER_USER / CHECKER_PASS として設定してください（README参照）。
//
// 未設定のまま公開してしまうと誰でも開けてしまうため、未設定のときは「必ず拒否」します。

export async function onRequest(context) {
  const { request, env, next } = context;

  const validUser = env.CHECKER_USER;
  const validPass = env.CHECKER_PASS;

  if (!validUser || !validPass) {
    return new Response(
      "認証用の環境変数（CHECKER_USER / CHECKER_PASS）が未設定です。Cloudflareの設定を確認してください。",
      { status: 503, headers: { "Content-Type": "text/plain; charset=UTF-8" } }
    );
  }

  const authHeader = request.headers.get("Authorization");
  if (authHeader && authHeader.startsWith("Basic ")) {
    let decoded = "";
    try {
      // 日本語のユーザー名・パスワードにも対応できるようUTF-8として復号する
      const bin = atob(authHeader.slice(6));
      decoded = new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
    } catch (e) {
      decoded = "";
    }
    const sep = decoded.indexOf(":");
    const user = decoded.slice(0, sep);
    const pass = decoded.slice(sep + 1);

    if (sep >= 0 && timingSafeEqual(user, validUser) & timingSafeEqual(pass, validPass)) {
      return next();
    }
  }

  return new Response("認証が必要です", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="taikenki-image-tool", charset="UTF-8"',
      "Content-Type": "text/plain; charset=UTF-8"
    }
  });
}

// 文字列比較で処理時間の差から推測されにくくする（長さが違っても全文字を走査する）
function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(String(a)), y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0 ? 1 : 0;
}
