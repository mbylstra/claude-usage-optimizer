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
function ee(e, t) {
	return e === "none" ? "onTrack" : t > 0 ? "ahead" : "behind";
}
function u(e) {
	if (e === null) return null;
	let t = new Date(e);
	return Number.isNaN(t.getTime()) ? null : t;
}
function d(e, t) {
	let n = c(e.utilizationPercent), i = u(e.resetsAt);
	if (i === null) return {
		kind: e.kind,
		isActive: !1,
		percentUsed: n
	};
	let a = r[e.kind], o = u(e.startedAt) ?? new Date(i.getTime() - a), s = Math.max(1, i.getTime() - o.getTime()), d = c((t.getTime() - o.getTime()) / s * 100), f = n - d, p = i.getTime() - t.getTime(), m = f / 100 * s, h = l(e.kind, m);
	return {
		kind: e.kind,
		isActive: !0,
		windowStartedAt: o,
		windowResetsAt: i,
		timeRemainingMs: Math.max(0, p),
		hasResetElapsed: p <= 0,
		percentUsed: n,
		pacePercent: d,
		paceDeltaPercentagePoints: f,
		paceDeltaMs: m,
		paceStatus: ee(h, m),
		paceSeverity: h
	};
}
function f(e, t) {
	return e.windows.map((e) => d(e, t));
}
function p(e) {
	return e.windows.reduce((e, t) => Math.max(e, c(t.utilizationPercent)), 0);
}
function m(e, t) {
	return e.find((e) => e.kind === t);
}
//#endregion
//#region src/lib/usageToolbarTitle.ts
var h = "Claude Usage Optimizer";
function te(e) {
	return `Claude usage: ${Math.round(p(e))}% of the closest limit`;
}
//#endregion
//#region src/lib/paceTone.ts
function g(e) {
	if (e.paceStatus === "ahead") switch (e.paceSeverity) {
		case "severe": return "aheadSevere";
		case "moderate": return "aheadModerate";
		default: return "aheadSlight";
	}
	return -e.paceDeltaMs >= s[e.kind] ? "headroom" : "steady";
}
//#endregion
//#region src/lib/suggestedModel.ts
function ne(e) {
	if (!e.isActive) return "favourable";
	switch (g(e)) {
		case "aheadSevere": return "severe";
		case "aheadSlight":
		case "aheadModerate": return "caution";
		default: return "favourable";
	}
}
var re = 18e5;
function ie(e) {
	return e.isActive ? g(e) === "aheadSevere" ? "severe" : e.paceStatus === "ahead" && e.paceDeltaMs >= re ? "caution" : "favourable" : "favourable";
}
function ae(e) {
	let t = m(e, "fiveHour"), n = m(e, "sevenDay");
	if (t === void 0 || n === void 0) return null;
	let r = [ie(t), ne(n)];
	return r.includes("severe") ? "haiku" : r.includes("caution") ? "sonnet" : "opus";
}
//#endregion
//#region src/lib/modelChangeReason.ts
function _(e, t, n) {
	let r = m(n, "fiveHour"), i = m(n, "sevenDay");
	if (e === null) return "Initial recommendation";
	if (e === t) return "Recommendation unchanged";
	let a = r?.isActive ? g(r) : null, o = i?.isActive ? g(i) : null;
	return v(t, e) ? y(a, o, t) : b(a, o, t);
}
function v(e, t) {
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
function b(e, t, n) {
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
var x = "https://claude.ai/api", S = class extends Error {
	code;
	httpStatus;
	constructor(e, t, n) {
		super(t), this.name = "ClaudeUsageError", this.code = e, this.httpStatus = n;
	}
}, C = {
	fiveHour: ["five_hour", "fiveHour"],
	sevenDay: ["seven_day", "sevenDay"],
	sevenDayOpus: ["seven_day_opus", "sevenDayOpus"]
}, oe = [
	"utilization",
	"utilization_pct",
	"utilizationPercent"
], se = [
	"resets_at",
	"reset_at",
	"resetsAt"
], ce = [
	"starts_at",
	"started_at",
	"window_start",
	"startsAt"
];
function w(e) {
	return typeof e == "object" && !!e && !Array.isArray(e);
}
function le(e, t) {
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
function T(e, t) {
	for (let n of t) {
		let t = e[n];
		if (typeof t == "string" && t.trim() !== "") return t;
	}
	return null;
}
async function E(e, t) {
	let n;
	try {
		n = await e.fetch(`${x}${t}`, {
			method: "GET",
			credentials: "include",
			headers: { Accept: "application/json" }
		});
	} catch {
		throw new S("NETWORK_ERROR", "Could not reach claude.ai. Check your connection.");
	}
	if (n.status === 401 || n.status === 403) throw new S("NOT_LOGGED_IN", "Not logged in to Claude.ai.", n.status);
	if (!n.ok) throw new S("HTTP_ERROR", `Claude.ai returned an unexpected response (${n.status}).`, n.status);
	try {
		return await n.json();
	} catch {
		throw new S("MALFORMED_RESPONSE", "Could not read the response from Claude.ai.");
	}
}
async function ue(e) {
	let t = await E(e, "/organizations");
	if (!Array.isArray(t) || t.length === 0) throw new S("NO_ORGANIZATIONS", "No Claude.ai organizations found.");
	let n = t.filter(w), r = n.find((e) => {
		let t = e.capabilities;
		return Array.isArray(t) && t.includes("chat");
	}) ?? n[0], i = r === void 0 ? null : T(r, ["uuid", "id"]);
	if (i === null) throw new S("NO_ORGANIZATIONS", "No Claude.ai organizations found.");
	return i;
}
function de(e, t) {
	let n = C[t].map((t) => e[t]).find((e) => w(e));
	if (n === void 0) return null;
	let r = le(n, oe);
	return r === null ? null : {
		kind: t,
		utilizationPercent: r,
		resetsAt: T(n, se),
		startedAt: T(n, ce)
	};
}
function fe(e) {
	if (!w(e)) throw new S("MALFORMED_RESPONSE", "Unexpected usage response from Claude.ai.");
	let t = Object.keys(C).map((t) => de(e, t)).filter((e) => e !== null);
	if (t.length === 0) throw new S("MALFORMED_RESPONSE", "Claude.ai did not report any usage windows.");
	return { windows: t };
}
async function D(e, t) {
	return fe(await E(e, `/organizations/${encodeURIComponent(t)}/usage`));
}
async function pe(e) {
	let t = await e.organizationIdCache.read();
	if (t !== null) try {
		return await D(e, t);
	} catch (t) {
		if (t instanceof S && t.code === "NOT_LOGGED_IN") throw t;
		await e.organizationIdCache.clear();
	}
	let n = await ue(e), r = await D(e, n);
	return await e.organizationIdCache.write(n), r;
}
function O(e) {
	return e instanceof S ? e.httpStatus === void 0 ? {
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
function k(e) {
	return typeof e == "object" && !!e && e.type === "REFRESH_USAGE";
}
function A(e) {
	return typeof e == "object" && !!e && e.type === "TEST_NOTIFICATION";
}
function j(e) {
	return typeof e == "object" && !!e && e.type === "RUN_AUTONOMOUS_WORK";
}
//#endregion
//#region src/lib/usageSnapshotExport.ts
function M(e, t) {
	return m(e, t)?.percentUsed ?? null;
}
function N(e, t) {
	let n = f(e, t), r = m(n, "sevenDay");
	return {
		fetchedAt: t.toISOString(),
		weeklyPaceDeltaMs: r?.isActive ? r.paceDeltaMs : null,
		weeklyPaceStatus: r?.isActive ? r.paceStatus : null,
		fiveHourPercent: M(n, "fiveHour"),
		sevenDayPercent: M(n, "sevenDay"),
		sevenDayOpusPercent: M(n, "sevenDayOpus")
	};
}
//#endregion
//#region src/extension/usageSnapshotExporter.ts
var P = "com.claudeusageoptimizer.usagehost", F = !1;
function I(e) {
	F || (F = !0, console.info(`Usage snapshot not exported (native host "${P}" unavailable). This is expected unless you installed it with \`just install-usage-host\`. Reason: ${String(e)}`));
}
var L = "snapshot", R = "runAutonomousWork";
async function z(e, t) {
	try {
		let n = N(e, t), r = await chrome.runtime.sendNativeMessage(P, {
			type: L,
			snapshot: n
		});
		if (typeof r == "object" && r && "error" in r) {
			I(r.error);
			return;
		}
		F = !1;
	} catch (e) {
		I(e);
	}
}
async function B() {
	try {
		let e = await chrome.runtime.sendNativeMessage(P, { type: R });
		if (typeof e == "object" && e && "ok" in e) {
			let { ok: t, error: n } = e;
			return t === !0 ? { started: !0 } : {
				started: !1,
				error: n === void 0 ? "Host refused the request" : String(n)
			};
		}
		return {
			started: !1,
			error: "Host sent no reply"
		};
	} catch (e) {
		return {
			started: !1,
			error: String(e)
		};
	}
}
//#endregion
//#region src/extension/usageStorage.ts
var V = "organizationId", H = "usageCache", U = "usageHistory", W = "suggestedModel", me = 864e5, he = 2e3;
async function G(e) {
	let t = (await chrome.storage.local.get(e))[e];
	return t === void 0 ? null : t;
}
async function ge() {
	let e = await G(V);
	if (e === null || typeof e.organizationId != "string") return null;
	let t = new Date(e.cachedAt).getTime();
	return Number.isNaN(t) || Date.now() - t > me ? null : e.organizationId;
}
async function _e(e) {
	let t = {
		organizationId: e,
		cachedAt: (/* @__PURE__ */ new Date()).toISOString()
	};
	await chrome.storage.local.set({ [V]: t });
}
async function ve() {
	await chrome.storage.local.remove(V);
}
var ye = {
	read: ge,
	write: _e,
	clear: ve
};
async function be() {
	return G(H);
}
async function K(e) {
	await chrome.storage.local.set({ [H]: e });
}
function q(e, t) {
	return e.windows.find((e) => e.kind === t);
}
async function xe(e, t) {
	let n = await G(U) ?? [], r = Array.isArray(n) ? n : [], i = q(e, "fiveHour"), a = q(e, "sevenDay"), o = q(e, "sevenDayOpus"), s = {
		fetchedAt: t,
		fiveHourPercent: i?.utilizationPercent ?? null,
		sevenDayPercent: a?.utilizationPercent ?? null,
		sevenDayOpusPercent: o?.utilizationPercent ?? null,
		fiveHourResetsAt: i?.resetsAt ?? null,
		sevenDayResetsAt: a?.resetsAt ?? null,
		sevenDayOpusResetsAt: o?.resetsAt ?? null
	}, c = [...r, s], l = c.slice(Math.max(0, c.length - he));
	await chrome.storage.local.set({ [U]: l });
}
async function Se() {
	return G(W);
}
async function Ce(e) {
	await chrome.storage.local.set({ [W]: e });
}
//#endregion
//#region src/lib/settingsTypes.ts
var we = { notificationsEnabled: !1 }, J = "settings";
async function Y() {
	let e = (await chrome.storage.local.get(J))[J];
	return {
		...we,
		...e
	};
}
//#endregion
//#region src/extension/serviceWorker.ts
var X = "refreshUsage", Te = 5;
async function Z(e) {
	await chrome.action.setTitle({ title: e === null ? h : te(e) });
}
async function Ee(e, t, n) {
	if (!(await Y()).notificationsEnabled) return;
	let r = _(e, t, n), i = {
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
async function De() {
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
		let e = await pe({
			fetch: globalThis.fetch.bind(globalThis),
			organizationIdCache: ye
		}), t = /* @__PURE__ */ new Date(), n = t.toISOString(), r = {
			snapshot: e,
			fetchedAt: n,
			error: null
		};
		await K(r), await xe(e, n), await Z(e), await z(e, t);
		let i = f(e, t), a = ae(i);
		if (a !== null) {
			let e = await Se();
			e !== a && (await Ee(e, a, i), await Ce(a));
		}
		return r;
	} catch (e) {
		let t = await be(), n = {
			snapshot: t?.snapshot ?? null,
			fetchedAt: t?.fetchedAt ?? null,
			error: O(e)
		};
		return await K(n), await Z(n.snapshot), n;
	}
}
function $() {
	chrome.alarms.create(X, {
		periodInMinutes: Te,
		delayInMinutes: .1
	});
}
chrome.runtime.onInstalled.addListener(() => {
	$(), Q();
}), chrome.runtime.onStartup.addListener(() => {
	$(), Q();
}), chrome.alarms.onAlarm.addListener((e) => {
	e.name === X && Q();
}), chrome.runtime.onMessage.addListener((e, t, n) => k(e) ? (Q().then((e) => n(e), (e) => n({
	snapshot: null,
	fetchedAt: null,
	error: O(e)
})), !0) : j(e) ? (B().then((e) => n(e)), !0) : A(e) ? (De().then(() => n({ success: !0 })).catch((e) => {
	console.error("Test notification error:", e), n({
		success: !1,
		error: String(e)
	});
}), !0) : !1), $(), chrome.action.setBadgeText({ text: "" });
//#endregion
