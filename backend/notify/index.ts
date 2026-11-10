// @ts-nocheck
// Pen Pal push notifier — Supabase Edge Function "notify". Generated from webpush.js + notify.main.ts.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

// Minimal Web Push sender (RFC 8291 aes128gcm + RFC 8292 VAPID) using only Web Crypto,
// so it runs in Supabase Edge Functions (Deno) and in Node 20+ for testing.
const enc = new TextEncoder();

function b64uToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64u(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

async function vapidHeader(endpoint, vapid) {
  const aud = new URL(endpoint).origin;
  const head = bytesToB64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = bytesToB64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: vapid.subject })));
  const key = await crypto.subtle.importKey("jwk", vapid.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(head + "." + body));
  return `vapid t=${head}.${body}.${bytesToB64u(sig)}, k=${vapid.publicKey}`;
}

async function encryptPayload(subscription, payload) {
  const uaPublic = b64uToBytes(subscription.keys.p256dh);
  const authSecret = b64uToBytes(subscription.keys.auth);
  const asKeys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asKeys.privateKey, 256));

  const prkKey = await hmac(authSecret, ecdh);
  const ikm = await hmac(prkKey, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic, new Uint8Array([1])));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);

  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const plaintext = concat(enc.encode(payload), new Uint8Array([2]));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, plaintext));

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ciphertext);
}

// Returns the push service's HTTP status (201 = delivered, 404/410 = subscription gone).
async function sendWebPush(subscription, payload, vapid, ttl = 86400) {
  const body = await encryptPayload(subscription, payload);
  const res = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(ttl),
      Urgency: "high",
      Authorization: await vapidHeader(subscription.endpoint, vapid),
    },
    body,
  });
  return res.status;
}

// Called by the app right after someone logs a hit. Sends a push to everyone else in the crew.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SERVICE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: userData } = await admin.auth.getUser(token);
    const user = userData && userData.user;
    if (!user) return json({ error: "not signed in" }, 401);

    const { hit_id } = await req.json();
    // Claim the hit once: only the sender, only within 2 minutes, only if not already announced.
    const { data: hit } = await admin
      .from("hits")
      .update({ notified: true })
      .eq("id", hit_id)
      .eq("uid", user.id)
      .eq("notified", false)
      .gte("at", new Date(Date.now() - 120000).toISOString())
      .select()
      .maybeSingle();
    if (!hit) return json({ sent: 0, reason: "nothing to announce" });

    const { data: subs } = await admin
      .from("push_subs")
      .select("endpoint, sub")
      .eq("crew", hit.crew)
      .neq("uid", hit.uid);

    const vapid = {
      publicKey: Deno.env.get("VAPID_PUBLIC_KEY"),
      privateJwk: JSON.parse(Deno.env.get("VAPID_PRIVATE_JWK") || "{}"),
      subject: Deno.env.get("VAPID_SUBJECT") || "mailto:penpal@example.com",
    };
    const body = `${hit.photo ? "📸 " : ""}${hit.name} just hit the ${hit.pen}${hit.spot ? " · " + hit.spot : ""}`;
    const payload = JSON.stringify({
      title: "Pen Pal",
      body,
      tag: "hit-" + hit.uid,
      image: hit.photo || undefined,
      url: Deno.env.get("APP_URL") || "./",
    });

    let sent = 0;
    const dead = [];
    const statuses = [];
    await Promise.all((subs || []).map(async (s) => {
      try {
        const status = await sendWebPush(s.sub, payload, vapid);
        statuses.push(status);
        if (status === 404 || status === 410) dead.push(s.endpoint);
        else if (status < 300) sent++;
      } catch (e) {
        statuses.push(String(e && e.message || e));
      }
    }));
    if (dead.length) await admin.from("push_subs").delete().in("endpoint", dead);
    console.log("notify", hit.id, { subs: (subs || []).length, sent, statuses });
    return json({ sent, statuses });
  } catch (e) {
    console.error(e);
    return json({ error: String(e && e.message || e) }, 500);
  }
});
