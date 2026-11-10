import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";

const DEFAULT_PENS = ["Nic pen", "Cart", "Disposable"];
const OUT_WINDOW = 2 * 60 * 60 * 1000;

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const show = (id) => ["loading", "unconfigured", "onboard", "main"].forEach((v) => { $(v).hidden = v !== id; });

const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

let swReg = null;
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").then((r) => { swReg = r; }).catch(() => {});
}

const cfg = self.PENPAL_CONFIG || {};
if (!cfg.supabaseUrl || cfg.supabaseUrl.startsWith("PASTE") || !cfg.supabaseKey || cfg.supabaseKey.startsWith("PASTE")) {
  show("unconfigured");
  throw new Error("Pen Pal: config.js not filled in");
}
const sb = createClient(cfg.supabaseUrl, cfg.supabaseKey, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: "penpal-auth" },
});

let uid = null;
let profile = null;            // { name, crew, pens, pen }
let crew = null;               // { code, name }
let members = new Map();       // uid -> { name, lastAt(ms) }
let hits = [];                 // [{ id, uid, name, pen, spot, photo, at(ms) }]
let channel = null;
let lastHitAt = 0;
let sending = false;

// ---------- helpers ----------
function toast(msg, action, ms) {
  const t = el("div", "toast");
  t.append(el("span", "msg", msg));
  if (action) {
    const b = el("button", "linkbtn", action.label); b.type = "button";
    b.onclick = () => { action.run(); t.remove(); };
    t.append(b);
  }
  $("toasts").append(t);
  setTimeout(() => t.remove(), ms || (action ? 8000 : 4500));
}
function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60); if (m < 60) return m + "m ago";
  const h = Math.round(m / 60); if (h < 24) return h + "h ago";
  return Math.round(h / 24) + "d ago";
}
function postmark(ms) {
  const d = new Date(ms);
  return {
    day: d.toLocaleDateString(undefined, { month: "short", day: "numeric" }).toUpperCase(),
    t: d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }).replace(/\s?([AP]M)/i, "$1"),
  };
}
function colorFor(id) {
  let h = 0; for (const c of id || "") h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 55% 45%)`;
}
function avatar(id, name) {
  const a = el("div", "avatar", (name || "?").trim().charAt(0).toUpperCase() || "?");
  a.style.background = colorFor(id);
  return a;
}
const ms = (v) => (v ? new Date(v).getTime() : 0);
function friendlyError(e) {
  const m = String(e?.message || e || "");
  if (/fetch|network|Failed to fetch|Load failed/i.test(m)) return "No connection. Check your signal and try again.";
  if (/row-level security|permission|JWT/i.test(m)) return "Pen Pal couldn't save that. Close and reopen the app.";
  return "Something went wrong. Try again.";
}
const must = ({ data, error }) => { if (error) throw error; return data; };
function rowToHit(r) {
  return { id: r.id, uid: r.uid, name: r.name, pen: r.pen, spot: r.spot || "", photo: r.photo || "", at: ms(r.at) || Date.now() };
}

// ---------- boot ----------
(async function boot() {
  try {
    let { data: { session } } = await sb.auth.getSession();
    if (!session) {
      const res = await sb.auth.signInAnonymously();
      if (res.error) throw res.error;
      session = res.data.session;
    }
    uid = session.user.id;
    profile = must(await sb.from("profiles").select("name, crew, pens, pen").eq("uid", uid).maybeSingle());
    if (profile?.crew) {
      const c = must(await sb.from("crews").select("code, name").eq("code", profile.crew).maybeSingle());
      if (c) return enterCrew(c.code, c.name);
    }
    startOnboarding();
  } catch (e) {
    startOnboarding();
    onboardError("Couldn't connect. Check your signal and reopen Pen Pal.");
  }
})();

// ---------- onboarding ----------
function startOnboarding() {
  show("onboard");
  if (profile?.name) $("nameIn").value = profile.name;
  const needsInstall = isIOS && !standalone;
  $("installCard").hidden = !needsInstall;
  $("setupSteps").hidden = needsInstall;
}
$("skipInstall").onclick = () => { $("installCard").hidden = true; $("setupSteps").hidden = false; };
function onboardError(msg) { $("onboardErr").textContent = msg; $("onboardErr").hidden = !msg; }
function busy(on) { $("createBtn").disabled = on; $("joinBtn").disabled = on; }

async function saveProfile(patch) {
  profile = { pens: DEFAULT_PENS.slice(), pen: DEFAULT_PENS[0], ...(profile || {}), ...patch };
  must(await sb.from("profiles").upsert({ uid, name: profile.name, crew: profile.crew, pens: profile.pens, pen: profile.pen }));
}

$("createBtn").onclick = async () => {
  const name = $("nameIn").value.trim();
  if (!name) return onboardError("Add your name first.");
  if (!uid) return onboardError("Still connecting. Give it a second and try again.");
  onboardError(""); busy(true);
  try {
    const code = must(await sb.rpc("create_crew", { crew_name: $("crewNameIn").value.trim(), member_name: name }));
    await saveProfile({ name, crew: code });
    const c = must(await sb.from("crews").select("name").eq("code", code).single());
    await enterCrew(code, c.name);
    toast(`Crew started. Your invite code is ${code}.`, null, 7000);
  } catch (e) { onboardError(friendlyError(e)); }
  busy(false);
};

$("joinBtn").onclick = async () => {
  const name = $("nameIn").value.trim();
  const code = $("codeIn").value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!name) return onboardError("Add your name first.");
  if (code.length !== 6) return onboardError("Invite codes are 6 letters and numbers.");
  if (!uid) return onboardError("Still connecting. Give it a second and try again.");
  onboardError(""); busy(true);
  try {
    const ok = must(await sb.rpc("join_crew", { crew_code: code, member_name: name }));
    if (!ok) onboardError(`No crew uses the code ${code}. Double-check it with whoever sent it.`);
    else {
      await saveProfile({ name, crew: code });
      const c = must(await sb.from("crews").select("name").eq("code", code).single());
      await enterCrew(code, c.name);
    }
  } catch (e) { onboardError(friendlyError(e)); }
  busy(false);
};
$("codeIn").addEventListener("input", (e) => { e.target.value = e.target.value.toUpperCase(); });

// ---------- main ----------
async function loadMembers() {
  const rows = must(await sb.from("members").select("uid, name, last_at").eq("crew", crew.code));
  members = new Map(rows.map((m) => [m.uid, { name: m.name, lastAt: ms(m.last_at) }]));
  if (!members.has(uid)) return kicked();
  render();
}
async function loadHits() {
  const rows = must(await sb.from("hits").select("id, uid, name, pen, spot, photo, at").eq("crew", crew.code).order("at", { ascending: false }).limit(60));
  hits = rows.map(rowToHit);
  render();
}
async function refreshAll() {
  if (!crew) return;
  try { await Promise.all([loadMembers(), loadHits()]); } catch (e) { /* offline; keep what we have */ }
}

async function enterCrew(code, name) {
  if (channel) { sb.removeChannel(channel); channel = null; }
  crew = { code, name: name || "Your crew" };
  members = new Map(); hits = [];
  show("main");
  try { $("spot").value = localStorage.getItem("penpal.spot") || ""; } catch (e) {}
  render();
  await refreshAll();

  channel = sb.channel("crew-" + code)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "hits", filter: `crew=eq.${code}` }, ({ new: r }) => {
      if (hits.some((h) => h.id === r.id)) return;
      const h = rowToHit(r);
      hits = [h, ...hits].sort((a, b) => b.at - a.at).slice(0, 60);
      if (h.uid !== uid) toast(`${h.photo ? "📸 " : ""}${h.name || "A pal"} just hit the ${h.pen || "pen"}${h.spot ? " · " + h.spot : ""}`);
      render();
    })
    .on("postgres_changes", { event: "DELETE", schema: "public", table: "hits" }, ({ old }) => {
      if (old?.id && hits.some((h) => h.id === old.id)) { hits = hits.filter((h) => h.id !== old.id); render(); }
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "members", filter: `crew=eq.${code}` }, () => { loadMembers().catch(() => {}); })
    .subscribe();

  setupPushCard();
}

// Phones pause the live connection in the background, so catch up when the app comes back.
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refreshAll(); });

function kicked() {
  if (channel) { sb.removeChannel(channel); channel = null; }
  crew = null;
  toast("You're no longer in that crew.");
  startOnboarding();
}

function render() {
  if (!crew) return;
  const myName = profile?.name || "You";

  // Pens
  const pens = $("pens"); pens.replaceChildren();
  const list = profile?.pens?.length ? profile.pens : DEFAULT_PENS;
  const current = profile?.pen || list[0];
  list.forEach((p) => {
    const c = el("button", "chip"); c.type = "button";
    c.setAttribute("aria-pressed", String(p === current));
    c.append(el("span", null, p));
    if (list.length > 1) {
      const x = el("span", "x", "×"); x.title = "Remove";
      x.onclick = (e) => { e.stopPropagation(); removePen(p); };
      c.append(x);
    }
    c.onclick = () => { savePens(list, p); };
    pens.append(c);
  });
  const add = el("button", "chip add", "+ Add pen"); add.type = "button";
  add.onclick = () => { $("addRow").hidden = false; $("newPen").focus(); };
  pens.append(add);

  // My stats
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const mine = hits.filter((h) => h.uid === uid);
  const today = mine.filter((h) => h.at >= midnight.getTime()).length;
  const st = $("mystats"); st.replaceChildren();
  st.append("Today ", el("b", null, String(today)), today === 1 ? " hit" : " hits");
  if (mine[0]) st.append(" · last ", el("b", null, ago(mine[0].at)));

  // Out now
  const out = [...members.entries()].filter(([, m]) => m.lastAt && Date.now() - m.lastAt < OUT_WINDOW)
    .sort((a, b) => b[1].lastAt - a[1].lastAt);
  const othersOut = out.filter(([id]) => id !== uid).length;
  $("outChip").classList.toggle("on", out.length > 0);
  $("outText").textContent = out.length === 0 ? "Nobody's out" : othersOut === 0 ? "Just you" : `${othersOut} pal${othersOut === 1 ? "" : "s"} out`;
  const pals = $("pals"); pals.replaceChildren();
  out.forEach(([id, m]) => {
    const p = el("div", "pal");
    p.append(avatar(id, m.name), el("span", "n", id === uid ? "You" : m.name), el("span", "t", ago(m.lastAt)));
    pals.append(p);
  });
  $("palsEmpty").hidden = out.length > 0;

  // Feed
  const feed = $("feed"); feed.replaceChildren();
  if (!hits.length) {
    const e = el("div", "empty");
    e.append(el("strong", null, "No mail yet"), document.createTextNode("Tap the stamp to send the first hit. Your crew gets it the second it lands."));
    feed.append(e);
  }
  hits.slice(0, 50).forEach((h) => {
    const me = h.uid === uid;
    const name = me ? "You" : (members.get(h.uid)?.name || h.name || "A pal");
    const c = el("div", "card" + (me ? " mine" : ""));
    const body = el("div", "body");
    const who = el("div", "who");
    who.append(`${name} hit the `, el("em", null, String(h.pen || "pen")));
    body.append(who);
    if (h.spot) body.append(el("div", "spot", "📍 " + h.spot));
    const pm = postmark(h.at);
    const mark = el("div", "postmark");
    mark.append(el("span", "d", pm.day), el("span", "h", pm.t));
    c.append(avatar(h.uid, me ? myName : name), body, mark);
    if (h.photo) {
      const img = el("img", "photo");
      img.src = h.photo; img.alt = `${name} with the ${h.pen || "pen"}`; img.loading = "lazy";
      img.onclick = () => openLightbox(h.photo, `${name} hit the ${h.pen || "pen"} · ${ago(h.at)}`);
      c.append(img);
    }
    feed.append(c);
  });

  // Crew box
  $("crewName").textContent = crew.name || "Your crew";
  $("crewCount").textContent = `${members.size} ${members.size === 1 ? "member" : "members"}`;
  $("codeBtn").textContent = crew.code;
}
setInterval(render, 30000);

async function savePens(pens, pen) {
  try { await saveProfile({ pens: pens.slice(0, 20), pen }); } catch (e) { toast(friendlyError(e)); }
  render();
}
function removePen(p) {
  const list = (profile?.pens?.length ? profile.pens : DEFAULT_PENS).filter((x) => x !== p);
  if (!list.length) return;
  savePens(list, profile?.pen === p ? list[0] : (profile?.pen || list[0]));
}
function addPen() {
  const v = $("newPen").value.trim().slice(0, 24);
  $("newPen").value = ""; $("addRow").hidden = true;
  if (!v) return;
  const list = (profile?.pens?.length ? profile.pens : DEFAULT_PENS).slice();
  if (!list.includes(v)) list.push(v);
  savePens(list, v);
}
$("savePen").onclick = addPen;
$("newPen").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); addPen(); }
  if (e.key === "Escape") $("addRow").hidden = true;
});
$("spot").addEventListener("input", () => { try { localStorage.setItem("penpal.spot", $("spot").value); } catch (e) {} });

// ---------- HIT ----------
// Tapping HIT opens the camera; the hit sends once the photo is taken.
$("stamp").onclick = () => {
  if (!crew || !uid || sending) return;
  $("cam").value = "";
  $("cam").click();
};
$("cam").addEventListener("change", () => {
  const file = $("cam").files && $("cam").files[0];
  if (file) sendHit(file);
});
$("noPic").onclick = () => { if (!sending) sendHit(null); };

// Shrink the photo to ~1080px JPEG so it uploads fast on cell signal.
async function compress(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const scale = Math.min(1, 1080 / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
    const canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h;
    canvas.getContext("2d").drawImage(img, 0, 0, w, h);
    return await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.78));
  } finally { URL.revokeObjectURL(url); }
}

function setSending(on) {
  sending = on;
  $("stamp").classList.toggle("sending", on);
  $("stampSub").textContent = on ? "SENDING…" : "SNAP + SEND";
  $("noPic").disabled = on;
}

async function sendHit(file) {
  if (!crew || !uid || sending) return;
  if (Date.now() - lastHitAt < 3000) return;          // stop accidental double sends
  lastHitAt = Date.now();
  const code = crew.code;
  const s = $("stamp");
  s.classList.remove("thunk"); void s.offsetWidth; s.classList.add("thunk");
  const r = el("span", "ring"); s.append(r); setTimeout(() => r.remove(), 750);
  if (navigator.vibrate) navigator.vibrate(30);

  const id = crypto.randomUUID ? crypto.randomUUID()
    : ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16));
  const row = {
    id, crew: code,
    name: (profile?.name || "A pal").slice(0, 24),
    pen: (profile?.pen || profile?.pens?.[0] || DEFAULT_PENS[0]).slice(0, 24),
    spot: $("spot").value.trim().slice(0, 40),
  };
  let photoPath = null;
  setSending(true);
  try {
    if (file) {
      const blob = await compress(file);
      if (blob) {
        photoPath = `${code}/${uid}/${id}.jpg`;
        must(await sb.storage.from("photos").upload(photoPath, blob, { contentType: "image/jpeg", upsert: false }));
        row.photo = sb.storage.from("photos").getPublicUrl(photoPath).data.publicUrl;
      }
    }
    const saved = must(await sb.from("hits").insert(row).select("id, uid, name, pen, spot, photo, at").single());
    if (!hits.some((h) => h.id === saved.id)) hits = [rowToHit(saved), ...hits].slice(0, 60);
    const me = members.get(uid); if (me) me.lastAt = ms(saved.at);
    render();
    sb.functions.invoke("notify", { body: { hit_id: id } }).catch(() => {});
    toast(file ? "Pic sent to your crew." : "Sent to your crew.", {
      label: "Undo",
      run: async () => {
        try {
          must(await sb.from("hits").delete().eq("id", id));
          if (photoPath) await sb.storage.from("photos").remove([photoPath]);
          hits = hits.filter((h) => h.id !== id); render();
        } catch (e) { toast("Couldn't undo that one."); }
      },
    });
  } catch (e) {
    lastHitAt = 0;
    if (photoPath) sb.storage.from("photos").remove([photoPath]).catch(() => {});
    toast("That hit didn't send. " + friendlyError(e));
  }
  setSending(false);
}

// ---------- photo viewer ----------
function openLightbox(src, caption) {
  $("lightImg").src = src; $("lightImg").alt = caption; $("lightCap").textContent = caption;
  $("lightbox").hidden = false;
}
function closeLightbox() { $("lightbox").hidden = true; $("lightImg").removeAttribute("src"); }
$("lightClose").onclick = closeLightbox;
$("lightbox").onclick = (e) => { if (e.target.id === "lightbox") closeLightbox(); };
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("lightbox").hidden) closeLightbox(); });

// ---------- crew box ----------
$("codeBtn").onclick = async () => {
  const link = location.origin + location.pathname.replace(/index\.html$/, "");
  const text = `Join my crew on Pen Pal: ${link}  Code: ${crew.code}`;
  try {
    if (navigator.share) await navigator.share({ title: "Pen Pal", text });
    else { await navigator.clipboard.writeText(text); toast("Invite copied."); }
  } catch (e) { /* share sheet dismissed */ }
};
$("leaveBtn").onclick = () => { $("leaveBtn").hidden = true; $("leaveConfirm").hidden = false; };
$("leaveNo").onclick = () => { $("leaveBtn").hidden = false; $("leaveConfirm").hidden = true; };
$("leaveYes").onclick = async () => {
  try {
    must(await sb.from("members").delete().eq("crew", crew.code).eq("uid", uid));
    await saveProfile({ crew: null });
    await sb.from("push_subs").update({ crew: null }).eq("uid", uid);
    if (channel) { sb.removeChannel(channel); channel = null; }
    crew = null;
    $("leaveBtn").hidden = false; $("leaveConfirm").hidden = true;
    startOnboarding();
  } catch (e) { toast(friendlyError(e)); }
};

// ---------- push notifications ----------
function pushSupported() {
  return "Notification" in window && "serviceWorker" in navigator && "PushManager" in window && !!cfg.vapidPublicKey && !cfg.vapidPublicKey.startsWith("PASTE");
}
function keyBytes(b64u) {
  const s = b64u.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64u.length + 3) % 4);
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
async function saveSubscription() {
  const reg = swReg || (await navigator.serviceWorker.ready);
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(cfg.vapidPublicKey) });
  must(await sb.from("push_subs").upsert({ endpoint: sub.endpoint, sub: sub.toJSON(), crew: crew?.code || null }));
}
function setupPushCard() {
  const card = $("pushCard"), text = $("pushText"), btn = $("pushBtn");
  if (isIOS && !standalone) {
    card.hidden = false; btn.hidden = true;
    text.textContent = "To get notifications, add Pen Pal to your home screen (Share → Add to Home Screen) and open it from there.";
    return;
  }
  if (!pushSupported()) { card.hidden = true; return; }
  if (Notification.permission === "granted") {
    card.hidden = true;
    saveSubscription().catch(() => {});        // keep this phone linked to the current crew
    return;
  }
  if (Notification.permission === "denied") {
    card.hidden = false; btn.hidden = true;
    text.textContent = "Notifications are blocked. Turn them on in Settings → Notifications → Pen Pal.";
    return;
  }
  card.hidden = false; btn.hidden = false;
  text.textContent = "Get a buzz when a pal hits.";
}
$("pushBtn").onclick = async () => {
  $("pushBtn").disabled = true;
  try {
    const perm = await Notification.requestPermission();
    if (perm === "granted") { await saveSubscription(); toast("Notifications on."); }
  } catch (e) { toast("Couldn't turn on notifications. Try again in a minute."); }
  $("pushBtn").disabled = false;
  setupPushCard();
};
