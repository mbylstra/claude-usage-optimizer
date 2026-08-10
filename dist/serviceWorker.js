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
var y = 18e5;
function b(e) {
	return e.isActive ? _(e) === "aheadSevere" ? "severe" : e.paceStatus === "ahead" && e.paceDeltaMs >= y ? "caution" : "favourable" : "favourable";
}
function te(e) {
	let t = h(e, "fiveHour"), n = h(e, "sevenDay");
	if (t === void 0 || n === void 0) return null;
	let r = [b(t), v(n)];
	return r.includes("severe") ? "haiku" : r.includes("caution") ? "sonnet" : "opus";
}
//#endregion
//#region src/lib/modelChangeReason.ts
function ne(e, t, n) {
	let r = h(n, "fiveHour"), i = h(n, "sevenDay");
	if (e === null) return "Initial recommendation";
	if (e === t) return "Recommendation unchanged";
	let a = r?.isActive ? _(r) : null, o = i?.isActive ? _(i) : null;
	return re(t, e) ? ie(a, o, t) : ae(a, o, t);
}
function re(e, t) {
	let n = {
		haiku: 0,
		sonnet: 1,
		opus: 2
	};
	return (n[e] ?? -1) > (n[t] ?? -1);
}
function ie(e, t, n) {
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
function ae(e, t, n) {
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
var oe = "https://claude.ai/api", x = class extends Error {
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
		n = await e.fetch(`${oe}${t}`, {
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
function ce(e, t) {
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
function A(e) {
	if (!E(e)) throw new x("MALFORMED_RESPONSE", "Unexpected usage response from Claude.ai.");
	let t = Object.keys(S).map((t) => ce(e, t)).filter((e) => e !== null);
	if (t.length === 0) throw new x("MALFORMED_RESPONSE", "Claude.ai did not report any usage windows.");
	return { windows: t };
}
async function j(e, t) {
	return A(await k(e, `/organizations/${encodeURIComponent(t)}/usage`));
}
async function M(e) {
	let t = await e.organizationIdCache.read();
	if (t !== null) try {
		return await j(e, t);
	} catch (t) {
		if (t instanceof x && t.code === "NOT_LOGGED_IN") throw t;
		await e.organizationIdCache.clear();
	}
	let n = await se(e), r = await j(e, n);
	return await e.organizationIdCache.write(n), r;
}
function N(e) {
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
function P(e) {
	return typeof e == "object" && !!e && e.type === "REFRESH_USAGE";
}
function F(e) {
	return typeof e == "object" && !!e && e.type === "TEST_NOTIFICATION";
}
//#endregion
//#region src/lib/usageSnapshotExport.ts
function I(e, t) {
	return h(e, t)?.percentUsed ?? null;
}
function L(e, t) {
	let n = p(e, t), r = h(n, "sevenDay");
	return {
		fetchedAt: t.toISOString(),
		weeklyPaceDeltaMs: r?.isActive ? r.paceDeltaMs : null,
		weeklyPaceStatus: r?.isActive ? r.paceStatus : null,
		fiveHourPercent: I(n, "fiveHour"),
		sevenDayPercent: I(n, "sevenDay"),
		sevenDayOpusPercent: I(n, "sevenDayOpus")
	};
}
//#endregion
//#region src/extension/usageStorage.ts
var R = "organizationId", z = "usageCache", B = "usageHistory", V = "suggestedModel", H = 864e5, U = 2e3;
async function W(e) {
	let t = (await chrome.storage.local.get(e))[e];
	return t === void 0 ? null : t;
}
async function G() {
	let e = await W(R);
	if (e === null || typeof e.organizationId != "string") return null;
	let t = new Date(e.cachedAt).getTime();
	return Number.isNaN(t) || Date.now() - t > H ? null : e.organizationId;
}
async function le(e) {
	let t = {
		organizationId: e,
		cachedAt: (/* @__PURE__ */ new Date()).toISOString()
	};
	await chrome.storage.local.set({ [R]: t });
}
async function ue() {
	await chrome.storage.local.remove(R);
}
var de = {
	read: G,
	write: le,
	clear: ue
};
async function fe() {
	return W(z);
}
async function K(e) {
	await chrome.storage.local.set({ [z]: e });
}
function q(e, t) {
	return e.windows.find((e) => e.kind === t);
}
async function pe(e, t) {
	let n = await W(B) ?? [], r = Array.isArray(n) ? n : [], i = q(e, "fiveHour"), a = q(e, "sevenDay"), o = q(e, "sevenDayOpus"), s = {
		fetchedAt: t,
		fiveHourPercent: i?.utilizationPercent ?? null,
		sevenDayPercent: a?.utilizationPercent ?? null,
		sevenDayOpusPercent: o?.utilizationPercent ?? null,
		fiveHourResetsAt: i?.resetsAt ?? null,
		sevenDayResetsAt: a?.resetsAt ?? null,
		sevenDayOpusResetsAt: o?.resetsAt ?? null
	}, c = [...r, s], l = c.slice(Math.max(0, c.length - U));
	await chrome.storage.local.set({ [B]: l });
}
var me = "claude-usage.json", he = 1e4;
function ge(e) {
	return new Promise((t) => {
		function n(t) {
			t.id === e && t.state !== void 0 && (t.state.current === "complete" || t.state.current === "interrupted") && r();
		}
		let r = () => {
			clearTimeout(i), chrome.downloads.onChanged.removeListener(n), t();
		};
		chrome.downloads.onChanged.addListener(n);
		let i = setTimeout(r, he);
	});
}
async function _e(e, t) {
	try {
		let n = L(e, t), r = `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(n, null, 2))}`, i = await chrome.downloads.download({
			url: r,
			filename: me,
			saveAs: !1,
			conflictAction: "overwrite"
		});
		await ge(i), await chrome.downloads.erase({ id: i });
	} catch (e) {
		console.warn("Failed to export usage snapshot to the download directory:", e);
	}
}
async function ve() {
	return W(V);
}
async function J(e) {
	await chrome.storage.local.set({ [V]: e });
}
//#endregion
//#region src/lib/settingsTypes.ts
var ye = { notificationsEnabled: !1 }, Y = "settings";
async function be() {
	let e = (await chrome.storage.local.get(Y))[Y];
	return {
		...ye,
		...e
	};
}
//#endregion
//#region src/extension/serviceWorker.ts
var X = "refreshUsage", xe = 5;
async function Z(e) {
	await chrome.action.setTitle({ title: e === null ? g : ee(e) });
}
async function Se(e, t, n) {
	if (!(await be()).notificationsEnabled) return;
	let r = ne(e, t, n), i = {
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
async function Ce() {
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
		let e = await M({
			fetch: globalThis.fetch.bind(globalThis),
			organizationIdCache: de
		}), t = /* @__PURE__ */ new Date(), n = t.toISOString(), r = {
			snapshot: e,
			fetchedAt: n,
			error: null
		};
		await K(r), await pe(e, n), await Z(e), await _e(e, t);
		let i = p(e, t), a = te(i);
		if (a !== null) {
			let e = await ve();
			e !== a && (await Se(e, a, i), await J(a));
		}
		return r;
	} catch (e) {
		let t = await fe(), n = {
			snapshot: t?.snapshot ?? null,
			fetchedAt: t?.fetchedAt ?? null,
			error: N(e)
		};
		return await K(n), await Z(n.snapshot), n;
	}
}
function $() {
	chrome.alarms.create(X, {
		periodInMinutes: xe,
		delayInMinutes: .1
	});
}
chrome.runtime.onInstalled.addListener(() => {
	$(), Q();
}), chrome.runtime.onStartup.addListener(() => {
	$(), Q();
}), chrome.alarms.onAlarm.addListener((e) => {
	e.name === X && Q();
}), chrome.runtime.onMessage.addListener((e, t, n) => P(e) ? (Q().then((e) => n(e), (e) => n({
	snapshot: null,
	fetchedAt: null,
	error: N(e)
})), !0) : F(e) ? (Ce().then(() => n({ success: !0 })).catch((e) => {
	console.error("Test notification error:", e), n({
		success: !1,
		error: String(e)
	});
}), !0) : !1), $(), chrome.action.setBadgeText({ text: "" });
//#endregion
