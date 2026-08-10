//#region src/lib/usageTypes.ts
var e = 6e4, t = 60 * e, n = 24 * t, r = {
	fiveHour: 5 * t,
	sevenDay: 7 * n,
	sevenDayOpus: 7 * n
}, i = {
	slight: 15 * e,
	moderate: 30 * e,
	severe: 60 * e
}, a = {
	slight: 12 * t,
	moderate: 24 * t,
	severe: 48 * t
}, o = {
	fiveHour: i,
	sevenDay: a,
	sevenDayOpus: a
}, s = {
	fiveHour: t,
	sevenDay: n,
	sevenDayOpus: n
};
//#endregion
//#region src/lib/usagePace.ts
function c(e) {
	return Number.isFinite(e) ? Math.min(100, Math.max(0, e)) : 0;
}
function l(e, t) {
	let n = o[e], r = Math.abs(t);
	return r >= n.severe ? "severe" : r >= n.moderate ? "moderate" : r >= n.slight ? "slight" : "none";
}
function u(e, t) {
	return e === "none" ? "onTrack" : t > 0 ? "ahead" : "behind";
}
function d(e) {
	if (e === null) return null;
	let t = new Date(e);
	return Number.isNaN(t.getTime()) ? null : t;
}
function f(e, t) {
	let n = c(e.utilizationPercent), i = d(e.resetsAt);
	if (i === null) return {
		kind: e.kind,
		isActive: !1,
		percentUsed: n
	};
	let a = r[e.kind], o = d(e.startedAt) ?? new Date(i.getTime() - a), s = Math.max(1, i.getTime() - o.getTime()), f = c((t.getTime() - o.getTime()) / s * 100), p = n - f, m = i.getTime() - t.getTime(), h = p / 100 * s, g = l(e.kind, h);
	return {
		kind: e.kind,
		isActive: !0,
		windowStartedAt: o,
		windowResetsAt: i,
		timeRemainingMs: Math.max(0, m),
		hasResetElapsed: m <= 0,
		percentUsed: n,
		pacePercent: f,
		paceDeltaPercentagePoints: p,
		paceDeltaMs: h,
		paceStatus: u(g, h),
		paceSeverity: g
	};
}
function p(e, t) {
	return e.windows.map((e) => f(e, t));
}
function m(e) {
	return e.windows.reduce((e, t) => Math.max(e, c(t.utilizationPercent)), 0);
}
function h(e, t) {
	return e.find((e) => e.kind === t);
}
//#endregion
//#region src/lib/usageToolbarTitle.ts
var g = "Claude Usage Optimizer";
function ee(e) {
	return `Claude usage: ${Math.round(m(e))}% of the closest limit`;
}
//#endregion
//#region src/lib/paceTone.ts
function _(e) {
	if (e.paceStatus === "ahead") switch (e.paceSeverity) {
		case "severe": return "aheadSevere";
		case "moderate": return "aheadModerate";
		default: return "aheadSlight";
	}
	return -e.paceDeltaMs >= s[e.kind] ? "headroom" : "steady";
}
//#endregion
//#region src/lib/suggestedModel.ts
function v(e) {
	if (!e.isActive) return "favourable";
	switch (_(e)) {
		case "aheadSevere": return "severe";
		case "aheadSlight":
		case "aheadModerate": return "caution";
		default: return "favourable";
	}
}
var te = 18e5;
function ne(e) {
	return e.isActive ? _(e) === "aheadSevere" ? "severe" : e.paceStatus === "ahead" && e.paceDeltaMs >= te ? "caution" : "favourable" : "favourable";
}
function re(e) {
	let t = h(e, "fiveHour"), n = h(e, "sevenDay");
	if (t === void 0 || n === void 0) return null;
	let r = [ne(t), v(n)];
	return r.includes("severe") ? "haiku" : r.includes("caution") ? "sonnet" : "opus";
}
//#endregion
//#region src/lib/modelChangeReason.ts
function ie(e, t, n) {
	let r = h(n, "fiveHour"), i = h(n, "sevenDay");
	if (e === null) return "Initial recommendation";
	if (e === t) return "Recommendation unchanged";
	let a = r?.isActive ? _(r) : null, o = i?.isActive ? _(i) : null;
	return ae(t, e) ? y(a, o, t) : oe(a, o, t);
}
function ae(e, t) {
	let n = {
		haiku: 0,
		sonnet: 1,
		opus: 2
	};
	return (n[e] ?? -1) > (n[t] ?? -1);
}
function y(e, t, n) {
	let r = ![
		"aheadSlight",
		"aheadModerate",
		"aheadSevere"
	].includes(e || ""), i = ![
		"aheadSlight",
		"aheadModerate",
		"aheadSevere"
	].includes(t || "");
	return r && i ? n === "opus" ? "Usage back on track, try Opus" : "Usage improving" : n === "sonnet" ? r && !i ? "5-hour session is healthy, weekly pace improving" : !r && i ? "Weekly pace is healthy, 5-hour session improving" : "Usage improving" : "Usage improving";
}
function oe(e, t, n) {
	let r = e === "aheadSevere", i = t === "aheadSevere";
	if (n === "haiku") return r && i ? "Both windows at critical pace — switch to Haiku to conserve" : r ? "5-hour session at critical pace — switch to Haiku to conserve" : i ? "Weekly usage at critical pace — switch to Haiku to conserve" : "Usage accelerating — switch to Haiku to conserve";
	if (n === "sonnet") {
		if (e === "aheadModerate" || e === "aheadSlight") return t === "aheadModerate" || t === "aheadSlight" ? "Both windows approaching limit — switch to Sonnet" : "5-hour session approaching limit — switch to Sonnet";
		if (t === "aheadModerate" || t === "aheadSlight") return "Weekly usage approaching limit — switch to Sonnet";
	}
	return "Usage pattern changed";
}
//#endregion
//#region src/extension/claudeUsageClient.ts
var b = "https://claude.ai/api", x = class extends Error {
	code;
	httpStatus;
	constructor(e, t, n) {
		super(t), this.name = "ClaudeUsageError", this.code = e, this.httpStatus = n;
	}
}, S = {
	fiveHour: ["five_hour", "fiveHour"],
	sevenDay: ["seven_day", "sevenDay"],
	sevenDayOpus: ["seven_day_opus", "sevenDayOpus"]
}, C = [
	"utilization",
	"utilization_pct",
	"utilizationPercent"
], w = [
	"resets_at",
	"reset_at",
	"resetsAt"
], T = [
	"starts_at",
	"started_at",
	"window_start",
	"startsAt"
];
function E(e) {
	return typeof e == "object" && !!e && !Array.isArray(e);
}
function D(e, t) {
	for (let n of t) {
		let t = e[n];
		if (typeof t == "number" && Number.isFinite(t)) return t;
		if (typeof t == "string" && t.trim() !== "") {
			let e = Number(t);
			if (Number.isFinite(e)) return e;
		}
	}
	return null;
}
function O(e, t) {
	for (let n of t) {
		let t = e[n];
		if (typeof t == "string" && t.trim() !== "") return t;
	}
	return null;
}
async function k(e, t) {
	let n;
	try {
		n = await e.fetch(`${b}${t}`, {
			method: "GET",
			credentials: "include",
			headers: { Accept: "application/json" }
		});
	} catch {
		throw new x("NETWORK_ERROR", "Could not reach claude.ai. Check your connection.");
	}
	if (n.status === 401 || n.status === 403) throw new x("NOT_LOGGED_IN", "Not logged in to Claude.ai.", n.status);
	if (!n.ok) throw new x("HTTP_ERROR", `Claude.ai returned an unexpected response (${n.status}).`, n.status);
	try {
		return await n.json();
	} catch {
		throw new x("MALFORMED_RESPONSE", "Could not read the response from Claude.ai.");
	}
}
async function se(e) {
	let t = await k(e, "/organizations");
	if (!Array.isArray(t) || t.length === 0) throw new x("NO_ORGANIZATIONS", "No Claude.ai organizations found.");
	let n = t.filter(E), r = n.find((e) => {
		let t = e.capabilities;
		return Array.isArray(t) && t.includes("chat");
	}) ?? n[0], i = r === void 0 ? null : O(r, ["uuid", "id"]);
	if (i === null) throw new x("NO_ORGANIZATIONS", "No Claude.ai organizations found.");
	return i;
}
function A(e, t) {
	let n = S[t].map((t) => e[t]).find((e) => E(e));
	if (n === void 0) return null;
	let r = D(n, C);
	return r === null ? null : {
		kind: t,
		utilizationPercent: r,
		resetsAt: O(n, w),
		startedAt: O(n, T)
	};
}
function j(e) {
	if (!E(e)) throw new x("MALFORMED_RESPONSE", "Unexpected usage response from Claude.ai.");
	let t = Object.keys(S).map((t) => A(e, t)).filter((e) => e !== null);
	if (t.length === 0) throw new x("MALFORMED_RESPONSE", "Claude.ai did not report any usage windows.");
	return { windows: t };
}
async function M(e, t) {
	return j(await k(e, `/organizations/${encodeURIComponent(t)}/usage`));
}
async function N(e) {
	let t = await e.organizationIdCache.read();
	if (t !== null) try {
		return await M(e, t);
	} catch (t) {
		if (t instanceof x && t.code === "NOT_LOGGED_IN") throw t;
		await e.organizationIdCache.clear();
	}
	let n = await se(e), r = await M(e, n);
	return await e.organizationIdCache.write(n), r;
}
function P(e) {
	return e instanceof x ? e.httpStatus === void 0 ? {
		code: e.code,
		message: e.message
	} : {
		code: e.code,
		message: e.message,
		httpStatus: e.httpStatus
	} : {
		code: "NETWORK_ERROR",
		message: e instanceof Error ? e.message : "Something went wrong fetching usage."
	};
}
function F(e) {
	return typeof e == "object" && !!e && e.type === "REFRESH_USAGE";
}
function I(e) {
	return typeof e == "object" && !!e && e.type === "TEST_NOTIFICATION";
}
//#endregion
//#region src/extension/usageStorage.ts
var L = "organizationId", R = "usageCache", z = "usageHistory", B = "suggestedModel", V = 864e5, H = 2e3;
async function U(e) {
	let t = (await chrome.storage.local.get(e))[e];
	return t === void 0 ? null : t;
}
async function W() {
	let e = await U(L);
	if (e === null || typeof e.organizationId != "string") return null;
	let t = new Date(e.cachedAt).getTime();
	return Number.isNaN(t) || Date.now() - t > V ? null : e.organizationId;
}
async function ce(e) {
	let t = {
		organizationId: e,
		cachedAt: (/* @__PURE__ */ new Date()).toISOString()
	};
	await chrome.storage.local.set({ [L]: t });
}
async function G() {
	await chrome.storage.local.remove(L);
}
var le = {
	read: W,
	write: ce,
	clear: G
};
async function ue() {
	return U(R);
}
async function K(e) {
	await chrome.storage.local.set({ [R]: e });
}
function q(e, t) {
	return e.windows.find((e) => e.kind === t);
}
async function de(e, t) {
	let n = await U(z) ?? [], r = Array.isArray(n) ? n : [], i = q(e, "fiveHour"), a = q(e, "sevenDay"), o = q(e, "sevenDayOpus"), s = {
		fetchedAt: t,
		fiveHourPercent: i?.utilizationPercent ?? null,
		sevenDayPercent: a?.utilizationPercent ?? null,
		sevenDayOpusPercent: o?.utilizationPercent ?? null,
		fiveHourResetsAt: i?.resetsAt ?? null,
		sevenDayResetsAt: a?.resetsAt ?? null,
		sevenDayOpusResetsAt: o?.resetsAt ?? null
	}, c = [...r, s], l = c.slice(Math.max(0, c.length - H));
	await chrome.storage.local.set({ [z]: l });
}
async function fe() {
	return U(B);
}
async function pe(e) {
	await chrome.storage.local.set({ [B]: e });
}
//#endregion
//#region src/lib/settingsTypes.ts
var me = { notificationsEnabled: !1 }, J = "settings";
async function he() {
	let e = (await chrome.storage.local.get(J))[J];
	return {
		...me,
		...e
	};
}
//#endregion
//#region src/extension/serviceWorker.ts
var Y = "refreshUsage", X = 5;
async function Z(e) {
	await chrome.action.setTitle({ title: e === null ? g : ee(e) });
}
async function ge(e, t, n) {
	if (!(await he()).notificationsEnabled) return;
	let r = ie(e, t, n), i = {
		opus: "Opus",
		sonnet: "Sonnet",
		haiku: "Haiku"
	};
	try {
		if (Notification.permission !== "granted") {
			console.warn("Notification permission not granted");
			return;
		}
		let e = Date.now();
		await self.registration.showNotification(`Recommended model: ${i[t] || t}`, {
			icon: chrome.runtime.getURL("icons/icon-128.png"),
			body: r,
			tag: `model-recommendation-${e}`
		});
	} catch (e) {
		console.error("Failed to send model change notification:", e);
	}
}
async function _e() {
	try {
		if (Notification.permission !== "granted") {
			console.warn("Notification permission not granted");
			return;
		}
		let e = Date.now();
		await self.registration.showNotification("Recommended model: Opus", {
			icon: chrome.runtime.getURL("icons/icon-128.png"),
			body: "This is a test notification. Your notifications are working!",
			tag: `model-recommendation-${e}`
		}), console.log("Test notification sent successfully");
	} catch (e) {
		throw console.error("Failed to send test notification:", e), e;
	}
}
async function Q() {
	try {
		let e = await N({
			fetch: globalThis.fetch.bind(globalThis),
			organizationIdCache: le
		}), t = (/* @__PURE__ */ new Date()).toISOString(), n = {
			snapshot: e,
			fetchedAt: t,
			error: null
		};
		await K(n), await de(e, t), await Z(e);
		let r = p(e, /* @__PURE__ */ new Date()), i = re(r);
		if (i !== null) {
			let e = await fe();
			e !== i && (await ge(e, i, r), await pe(i));
		}
		return n;
	} catch (e) {
		let t = await ue(), n = {
			snapshot: t?.snapshot ?? null,
			fetchedAt: t?.fetchedAt ?? null,
			error: P(e)
		};
		return await K(n), await Z(n.snapshot), n;
	}
}
function $() {
	chrome.alarms.create(Y, {
		periodInMinutes: X,
		delayInMinutes: .1
	});
}
chrome.runtime.onInstalled.addListener(() => {
	$(), Q();
}), chrome.runtime.onStartup.addListener(() => {
	$(), Q();
}), chrome.alarms.onAlarm.addListener((e) => {
	e.name === Y && Q();
}), chrome.runtime.onMessage.addListener((e, t, n) => F(e) ? (Q().then((e) => n(e), (e) => n({
	snapshot: null,
	fetchedAt: null,
	error: P(e)
})), !0) : I(e) ? (_e().then(() => n({ success: !0 })).catch((e) => {
	console.error("Test notification error:", e), n({
		success: !1,
		error: String(e)
	});
}), !0) : !1), $(), chrome.action.setBadgeText({ text: "" });
//#endregion
