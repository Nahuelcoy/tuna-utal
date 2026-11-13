// Envía al celular los avisos de la app (Cloudflare Pages Functions, gratis).
// Necesita la variable secreta FIREBASE_SA en Cloudflare (la clave de la cuenta de servicio de Firebase, JSON completo).
// Seguridad: solo acepta a quien inició sesión en Firebase, y solo envía avisos que esa misma persona acaba de crear.
const enc = new TextEncoder();
const b64u = s => { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return s; };
const bytes = s => Uint8Array.from(atob(b64u(s)), c => c.charCodeAt(0));
const json = s => JSON.parse(new TextDecoder().decode(bytes(s)));
const toB64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const res = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { "Content-Type": "application/json" } });

let JWKS = null, JWKS_AT = 0, TOKEN = null, TOKEN_EXP = 0;

async function verificarUsuario(t, project) {
  const [h, p, s] = (t || "").split(".");
  if (!s) throw new Error("sin sesión");
  const head = json(h), pay = json(p), now = Date.now() / 1000;
  if (head.alg !== "RS256" || pay.aud !== project || pay.iss !== "https://securetoken.google.com/" + project
    || !(pay.exp > now) || pay.iat > now + 300 || !pay.sub) throw new Error("sesión inválida");
  if (!JWKS || Date.now() - JWKS_AT > 3600e3) {
    JWKS = (await (await fetch("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com")).json()).keys;
    JWKS_AT = Date.now();
  }
  const jwk = JWKS.find(k => k.kid === head.kid);
  if (!jwk) throw new Error("sesión inválida");
  const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, bytes(s), enc.encode(h + "." + p));
  if (!ok) throw new Error("sesión inválida");
  return pay.sub;
}

async function tokenServicio(sa) {
  if (TOKEN && Date.now() < TOKEN_EXP) return TOKEN;
  const now = Math.floor(Date.now() / 1000);
  const head = toB64u(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const body = toB64u(enc.encode(JSON.stringify({
    iss: sa.client_email, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
    scope: "https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.messaging"
  })));
  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const key = await crypto.subtle.importKey("pkcs8", Uint8Array.from(atob(pem), c => c.charCodeAt(0)),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = toB64u(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(head + "." + body)));
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=" + head + "." + body + "." + sig
  });
  const d = await r.json();
  if (!d.access_token) throw new Error("no se pudo autenticar con Google");
  TOKEN = d.access_token; TOKEN_EXP = Date.now() + 50 * 60e3;
  return TOKEN;
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.FIREBASE_SA) return res({ error: "falta configurar FIREBASE_SA" }, 503);
    const sa = JSON.parse(env.FIREBASE_SA), project = sa.project_id;
    const uid = await verificarUsuario((request.headers.get("Authorization") || "").replace(/^Bearer\s+/, ""), project);
    const { aviso } = await request.json();
    if (!/^[A-Za-z0-9_-]{6,60}$/.test(aviso || "")) return res({ error: "aviso inválido" }, 400);
    const tok = await tokenServicio(sa), H = { Authorization: "Bearer " + tok, "Content-Type": "application/json" };
    const base = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`;
    const r = await fetch(`${base}/avisos/${aviso}`, { headers: H });
    if (!r.ok) return res({ error: "aviso no encontrado" }, 404);
    const f = (await r.json()).fields || {};
    if (f.por?.stringValue !== uid) return res({ error: "no autorizado" }, 403);
    if (f.enviado?.booleanValue) return res({ ok: true, repetido: true });
    if (!(Date.now() - Date.parse(f.fecha?.stringValue || "") < 10 * 60e3)) return res({ error: "aviso antiguo" }, 400);
    await fetch(`${base}/avisos/${aviso}?updateMask.fieldPaths=enviado`, {
      method: "PATCH", headers: H, body: JSON.stringify({ fields: { enviado: { booleanValue: true } } })
    });
    const para = (f.para?.arrayValue?.values || []).map(v => v.stringValue).filter(x => /^[A-Za-z0-9_-]{1,128}$/.test(x || "")).slice(0, 80);
    const data = {
      title: "Tuna UTAL", body: (f.texto?.stringValue || "Hay novedades en la app.").slice(0, 300), tag: aviso,
      abrir: (f.kind?.stringValue || "") + ":" + (f.ref?.stringValue || "")
    };
    let enviados = 0;
    await Promise.all(para.map(async u => {
      const tr = await fetch(`${base}/pushTokens/${u}`, { headers: H });
      if (!tr.ok) return;
      const tokens = ((await tr.json()).fields?.tokens?.arrayValue?.values || []).map(v => v.stringValue).filter(Boolean);
      const malos = [];
      await Promise.all(tokens.map(async t => {
        const s = await fetch(`https://fcm.googleapis.com/v1/projects/${project}/messages:send`, {
          method: "POST", headers: H,
          body: JSON.stringify({ message: { token: t, data, webpush: { headers: { Urgency: "high", TTL: "86400" } } } })
        });
        if (s.ok) enviados++;
        else if (/UNREGISTERED|NOT_FOUND|INVALID_ARGUMENT/.test(await s.text())) malos.push(t);
      }));
      if (malos.length) {
        const quedan = tokens.filter(t => !malos.includes(t));
        await fetch(`${base}/pushTokens/${u}?updateMask.fieldPaths=tokens`, {
          method: "PATCH", headers: H,
          body: JSON.stringify({ fields: { tokens: { arrayValue: { values: quedan.map(t => ({ stringValue: t })) } } } })
        });
      }
    }));
    return res({ ok: true, enviados });
  } catch (e) {
    return res({ error: String(e && e.message || e) }, 500);
  }
}
