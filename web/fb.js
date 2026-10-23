// Firebase setup, sign-in and the loading screen.
import config from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getAuth, connectAuthEmulator, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  sendPasswordResetEmail, signOut, setPersistence, browserLocalPersistence,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  initializeFirestore, connectFirestoreEmulator, persistentLocalCache, persistentMultipleTabManager, doc, getDoc, setDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

const { emulators, ...options } = config; // `emulators: true` only in a local test config
export const app = initializeApp(options);
export const auth = getAuth(app);
setPersistence(auth, browserLocalPersistence).catch(() => {});
// Keeps data on the phone so the app still works on bad event Wi-Fi.
export const db = (() => {
  if (emulators) return initializeFirestore(app, {});
  try { return initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }); }
  catch { return initializeFirestore(app, {}); }
})();
if (emulators) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
}

// ---- loading screen (lives in index.html so it shows before any script loads)
export const splash = msg => { const m = document.getElementById("splash-msg"); if (m) m.textContent = msg; };
export function hideSplash() {
  const s = document.getElementById("splash");
  if (!s || s.classList.contains("gone")) return;
  s.classList.add("gone");
  setTimeout(() => s.remove(), 350);
}

// Remember that this phone's account is a team member, so the next launch opens straight away
// instead of waiting on the network. Still checked in the background every time.
const memberKey = uid => `19109m.member.${uid}`;
const cachedMember = uid => { try { return JSON.parse(localStorage.getItem(memberKey(uid))); } catch { return null; } };
export const rememberMember = (uid, m) => { try { localStorage.setItem(memberKey(uid), JSON.stringify({ nickname: m.nickname })); } catch {} };
const forgetMember = uid => { try { localStorage.removeItem(memberKey(uid)); } catch {} };

export const h = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "text") n.textContent = v;
    else if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) n.append(kid instanceof Node ? kid : String(kid));
  return n;
};

/**
 * A password-style field with a Show / Hide button, so people can check what they typed.
 * Hidden by default. `what` names it for screen readers ("password", "team code").
 */
export function secret(input, what = "password") {
  input.type = "password";
  const reveal = h("button", { type: "button", class: "reveal", "aria-label": `Show ${what}`, "aria-pressed": "false", onclick: () => {
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    reveal.textContent = show ? "Hide" : "Show";
    reveal.setAttribute("aria-pressed", String(show));
    reveal.setAttribute("aria-label", `${show ? "Hide" : "Show"} ${what}`);
    input.focus();
  } }, "Show");
  return h("div", { class: "pw" }, input, reveal);
}

/**
 * "Forgot the team code? Ask an admin": sends a request admins see in the app (Settings).
 * Needs a signed-in account (members, or someone who made an account but is stuck joining).
 * `where` says what they were trying to open; `nickname` is who's asking.
 */
export function askAdmin(where, nickname = "") {
  const sent = h("span", { class: "muted small" });
  const btn = h("button", { type: "button", class: "btn plain small", onclick: async () => {
    const u = auth.currentUser;
    if (!u) return;
    btn.disabled = true;
    try {
      await setDoc(doc(db, "codeRequests", u.uid), { nickname: String(nickname || u.email.split("@")[0]).slice(0, 24), email: u.email, where: where.slice(0, 40), at: serverTimestamp() });
      btn.remove(); sent.textContent = "Asked. An admin will get back to you with the team code.";
    } catch (err) { btn.disabled = false; sent.textContent = `Couldn't send: ${err.code || err.message}`; }
  } }, "Forgot the team code? Ask an admin");
  return h("div", { class: "ask-admin" }, btn, sent);
}

const friendly = err => ({
  "auth/invalid-credential": "Wrong email or password.",
  "auth/invalid-email": "That email doesn't look right.",
  "auth/email-already-in-use": "That email already has an account. Sign in instead.",
  "auth/weak-password": "Use at least 6 characters for the password.",
  "auth/too-many-requests": "Too many tries. Wait a minute and try again.",
  "auth/network-request-failed": "No connection.",
  "permission-denied": "Wrong team code.",
}[err?.code] || err?.message || "Something went wrong.");

/** The sign-in / join screen. Resolves once the person is a signed-in team member. */
function authScreen(root, user) {
  return new Promise(resolve => {
    let mode = user ? "finish" : "signin";
    const vals = { email: "", nick: "", code: "" }; // kept across redraws
    hideSplash();
    const draw = () => {
      root.replaceChildren();
      const msg = h("p", { class: "error", role: "alert" });
      const keep = k => e => { vals[k] = e.target.value; };
      const email = h("input", { type: "email", autocomplete: "email", required: true, placeholder: "you@school.ca", value: vals.email, oninput: keep("email") });
      const pass = h("input", { id: "pw", type: "password", autocomplete: mode === "signin" ? "current-password" : "new-password", required: true, minlength: 6 });
      const passBox = secret(pass, "password");
      const nick = h("input", { type: "text", maxlength: 24, required: true, placeholder: "What the team calls you", value: vals.nick, oninput: keep("nick") });
      const code = h("input", { type: "password", required: true, autocomplete: "off", placeholder: "Ask a teammate", value: vals.code, oninput: keep("code") });
      const busy = b => form.querySelectorAll("button, input").forEach(x => { x.disabled = b; });
      const join = async u => {
        await setDoc(doc(db, "members", u.uid), { nickname: nick.value.trim(), code: code.value.trim(), joinedAt: serverTimestamp() });
        resolve(u);
      };
      const form = h("form", { class: "card", onsubmit: async e => {
        e.preventDefault(); msg.textContent = ""; busy(true);
        try {
          if (mode === "signin") {
            const { user: u } = await signInWithEmailAndPassword(auth, email.value.trim(), pass.value);
            const m = await getDoc(doc(db, "members", u.uid)).catch(() => null);
            if (m?.exists()) resolve(u); else { mode = "finish"; draw(); }
          } else if (mode === "join") {
            const { user: u } = await createUserWithEmailAndPassword(auth, email.value.trim(), pass.value);
            try { await join(u); } catch (err) { mode = "finish"; draw(); root.querySelector(".error").textContent = friendly(err); }
          } else {
            await join(auth.currentUser);
          }
        } catch (err) { msg.textContent = friendly(err); busy(false); }
      } },
        mode === "finish"
          ? [h("h2", { text: "Join the team" }), h("p", { class: "muted", text: `Signed in as ${auth.currentUser?.email}. Enter the team code to finish.` })]
          : h("h2", { text: mode === "signin" ? "Sign in" : "Make an account" }),
        mode !== "finish" && h("label", { class: "field" }, "Email", email),
        mode !== "finish" && h("div", { class: "field" }, h("label", { for: "pw" }, "Password"), passBox),
        mode !== "signin" && h("label", { class: "field" }, "Nickname", nick),
        mode !== "signin" && h("div", { class: "field" }, h("span", {}, "Team code"), secret(code, "team code")),
        msg,
        h("button", { class: "btn primary", type: "submit" }, mode === "signin" ? "Sign in" : "Join"),
        mode === "finish" && askAdmin("Joining the team", vals.nick),
        mode === "signin" && h("button", { class: "btn", type: "button", onclick: async () => {
          if (!email.value.trim()) { msg.textContent = "Type your email first."; return; }
          try { await sendPasswordResetEmail(auth, email.value.trim()); msg.textContent = "Reset link sent. Check your email."; } catch (err) { msg.textContent = friendly(err); }
        } }, "Forgot password"),
      );
      root.append(h("div", { class: "auth" },
        h("div", { class: "mark", "aria-hidden": "true" }, "M"),
        h("div", {}, h("div", { class: "brand" }, "19109M Scout"), h("p", { class: "muted", text: "Team scouting for 19109M. Members only." })),
        h("div", { class: "chips" },
          mode === "finish"
            ? h("button", { type: "button", onclick: () => signOut(auth).then(() => { mode = "signin"; draw(); }) }, "Use a different account")
            : ["signin", "join"].map(m => h("button", { type: "button", "aria-pressed": String(mode === m), onclick: () => { mode = m; draw(); } }, m === "signin" ? "Sign in" : "New here"))),
        form));
    };
    draw();
  });
}

/** Waits for a signed-in member, showing the sign-in screen in `root` if needed. Returns { user, member }. */
export function requireMember(root) {
  return new Promise(resolve => {
    let started = false, done = false;
    onAuthStateChanged(auth, async user => {
      if (done) { if (!user) location.reload(); return; }
      if (started) return; // the sign-in screen handles sign-ins while it's open
      started = true;
      let member = null;
      if (user) {
        const cached = cachedMember(user.uid);
        if (cached) {
          // Open now; if the server says they're no longer a member, sign out.
          getDoc(doc(db, "members", user.uid)).then(m => {
            if (m.exists()) rememberMember(user.uid, m.data());
            else { forgetMember(user.uid); signOut(auth); }
          }).catch(() => {});
          done = true;
          resolve({ user, member: cached });
          return;
        }
        splash("Signing in…");
        try { const m = await getDoc(doc(db, "members", user.uid)); if (m.exists()) member = m.data(); } catch {}
      }
      if (!member) {
        const u = await authScreen(root, user);
        member = (await getDoc(doc(db, "members", u.uid))).data();
        user = u;
      }
      rememberMember(user.uid, member);
      done = true;
      resolve({ user, member });
    });
  });
}

export { signOut };
