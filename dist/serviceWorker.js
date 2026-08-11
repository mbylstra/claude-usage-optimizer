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
function g(e) {
	return `Claude usage: ${Math.round(p(e))}% of the closest limit`;
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
function te(e) {
	if (!e.isActive) return "favourable";
	switch (_(e)) {
		case "aheadSevere": return "severe";
		case "aheadSlight":
		case "aheadModerate": return "caution";
		default: return "favourable";
	}
}
var ne = 18e5;
function re(e) {
	return e.isActive ? _(e) === "aheadSevere" ? "severe" : e.paceStatus === "ahead" && e.paceDeltaMs >= ne ? "caution" : "favourable" : "favourable";
}
function ie(e) {
	let t = m(e, "fiveHour"), n = m(e, "sevenDay");
	if (t === void 0 || n === void 0) return null;
	let r = [re(t), te(n)];
	return r.includes("severe") ? "haiku" : r.includes("caution") ? "sonnet" : "opus";
}
//#endregion
//#region src/lib/modelChangeReason.ts
function v(e, t, n) {
	let r = m(n, "fiveHour"), i = m(n, "sevenDay");
	if (e === null) return "Initial recommendation";
	if (e === t) return "Recommendation unchanged";
	let a = r?.isActive ? _(r) : null, o = i?.isActive ? _(i) : null;
	return ae(t, e) ? oe(a, o, t) : se(a, o, t);
}
function ae(e, t) {
	let n = {
		haiku: 0,
		sonnet: 1,
		opus: 2
	};
	return (n[e] ?? -1) > (n[t] ?? -1);
}
function oe(e, t, n) {
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
function se(e, t, n) {
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
var ce = "https://claude.ai/api", y = class extends Error {
	code;
	httpStatus;
	constructor(e, t, n) {
		super(t), this.name = "ClaudeUsageError", this.code = e, this.httpStatus = n;
	}
}, b = {
	fiveHour: ["five_hour", "fiveHour"],
	sevenDay: ["seven_day", "sevenDay"],
	sevenDayOpus: ["seven_day_opus", "sevenDayOpus"]
}, le = [
	"utilization",
	"utilization_pct",
	"utilizationPercent"
], ue = [
	"resets_at",
	"reset_at",
	"resetsAt"
], de = [
	"starts_at",
	"started_at",
	"window_start",
	"startsAt"
];
function x(e) {
	return typeof e == "object" && !!e && !Array.isArray(e);
}
function S(e, t) {
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
function C(e, t) {
	for (let n of t) {
		let t = e[n];
		if (typeof t == "string" && t.trim() !== "") return t;
	}
	return null;
}
async function w(e, t) {
	let n;
	try {
		n = await e.fetch(`${ce}${t}`, {
			method: "GET",
			credentials: "include",
			headers: { Accept: "application/json" }
		});
	} catch {
		throw new y("NETWORK_ERROR", "Could not reach claude.ai. Check your connection.");
	}
	if (n.status === 401 || n.status === 403) throw new y("NOT_LOGGED_IN", "Not logged in to Claude.ai.", n.status);
	if (!n.ok) throw new y("HTTP_ERROR", `Claude.ai returned an unexpected response (${n.status}).`, n.status);
	try {
		return await n.json();
	} catch {
		throw new y("MALFORMED_RESPONSE", "Could not read the response from Claude.ai.");
	}
}
async function fe(e) {
	let t = await w(e, "/organizations");
	if (!Array.isArray(t) || t.length === 0) throw new y("NO_ORGANIZATIONS", "No Claude.ai organizations found.");
	let n = t.filter(x), r = n.find((e) => {
		let t = e.capabilities;
		return Array.isArray(t) && t.includes("chat");
	}) ?? n[0], i = r === void 0 ? null : C(r, ["uuid", "id"]);
	if (i === null) throw new y("NO_ORGANIZATIONS", "No Claude.ai organizations found.");
	return i;
}
function pe(e, t) {
	let n = b[t].map((t) => e[t]).find((e) => x(e));
	if (n === void 0) return null;
	let r = S(n, le);
	return r === null ? null : {
		kind: t,
		utilizationPercent: r,
		resetsAt: C(n, ue),
		startedAt: C(n, de)
	};
}
function me(e) {
	if (!x(e)) throw new y("MALFORMED_RESPONSE", "Unexpected usage response from Claude.ai.");
	let t = Object.keys(b).map((t) => pe(e, t)).filter((e) => e !== null);
	if (t.length === 0) throw new y("MALFORMED_RESPONSE", "Claude.ai did not report any usage windows.");
	return { windows: t };
}
async function T(e, t) {
	return me(await w(e, `/organizations/${encodeURIComponent(t)}/usage`));
}
async function he(e) {
	let t = await e.organizationIdCache.read();
	if (t !== null) try {
		return await T(e, t);
	} catch (t) {
		if (t instanceof y && t.code === "NOT_LOGGED_IN") throw t;
		await e.organizationIdCache.clear();
	}
	let n = await fe(e), r = await T(e, n);
	return await e.organizationIdCache.write(n), r;
}
function E(e) {
	return e instanceof y ? e.httpStatus === void 0 ? {
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
function ge(e) {
	return typeof e == "object" && !!e && e.type === "REFRESH_USAGE";
}
function _e(e) {
	return typeof e == "object" && !!e && e.type === "TEST_NOTIFICATION";
}
function ve(e) {
	return typeof e == "object" && !!e && e.type === "RUN_AUTONOMOUS_WORK";
}
function ye(e) {
	return typeof e == "object" && !!e && e.type === "OPEN_RUN_LOG";
}
function be(e) {
	return typeof e == "object" && !!e && e.type === "SYNC_AUTONOMOUS_WORK_SETTINGS";
}
//#endregion
//#region src/extension/runLogWindow.ts
var xe = "run-log.html", Se = 520, Ce = 680, D = "runLogWindowId";
async function O() {
	let e = (await chrome.storage.session.get(D))[D];
	return typeof e == "number" ? e : null;
}
async function k(e) {
	try {
		return await chrome.windows.update(e, {
			focused: !0,
			drawAttention: !0
		}), !0;
	} catch {
		return !1;
	}
}
async function A() {
	let e = await O();
	if (e !== null && await k(e)) return;
	let t = await chrome.windows.create({
		url: chrome.runtime.getURL(xe),
		type: "popup",
		width: Se,
		height: Ce
	});
	t?.id !== void 0 && await chrome.storage.session.set({ [D]: t.id });
}
function we(e) {
	O().then((t) => {
		t === e && chrome.storage.session.remove(D);
	});
}
//#endregion
//#region src/lib/usageSnapshotExport.ts
function j(e, t) {
	return m(e, t)?.percentUsed ?? null;
}
function Te(e, t) {
	let n = f(e, t), r = m(n, "sevenDay");
	return {
		fetchedAt: t.toISOString(),
		weeklyPaceDeltaMs: r?.isActive ? r.paceDeltaMs : null,
		weeklyPaceStatus: r?.isActive ? r.paceStatus : null,
		fiveHourPercent: j(n, "fiveHour"),
		sevenDayPercent: j(n, "sevenDay"),
		sevenDayOpusPercent: j(n, "sevenDayOpus")
	};
}
//#endregion
//#region src/extension/usageSnapshotExporter.ts
var M = "com.claudeusageoptimizer.usagehost", N = !1;
function P(e) {
	N || (N = !0, console.info(`Usage snapshot not exported (native host "${M}" unavailable). This is expected unless you installed it with \`just install-usage-host\`. Reason: ${String(e)}`));
}
var Ee = "snapshot", De = "runAutonomousWork", Oe = "setAutonomousWorkSettings";
async function ke(e, t) {
	try {
		let n = Te(e, t), r = await chrome.runtime.sendNativeMessage(M, {
			type: Ee,
			snapshot: n
		});
		if (typeof r == "object" && r && "error" in r) {
			P(r.error);
			return;
		}
		N = !1;
	} catch (e) {
		P(e);
	}
}
async function Ae() {
	try {
		let e = await chrome.runtime.sendNativeMessage(M, { type: De });
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
async function F(e) {
	try {
		let t = await chrome.runtime.sendNativeMessage(M, {
			type: Oe,
			settings: {
				scheduleHour: e.scheduleTime.hour,
				scheduleMinute: e.scheduleTime.minute,
				newProjectsDirectory: e.newProjectsDirectory
			}
		});
		if (typeof t == "object" && t && "ok" in t) {
			let { ok: e, launchAgentUpdated: n, error: r } = t;
			return e === !0 ? {
				saved: !0,
				launchAgentUpdated: n === !0
			} : {
				saved: !1,
				launchAgentUpdated: !1,
				error: r === void 0 ? "Host refused the settings" : String(r)
			};
		}
		return {
			saved: !1,
			launchAgentUpdated: !1,
			error: "Host sent no reply"
		};
	} catch (e) {
		return {
			saved: !1,
			launchAgentUpdated: !1,
			error: String(e)
		};
	}
}
//#endregion
//#region src/extension/usageStorage.ts
var I = "organizationId", L = "usageCache", R = "usageHistory", z = "suggestedModel", je = 864e5, Me = 2e3;
async function B(e) {
	let t = (await chrome.storage.local.get(e))[e];
	return t === void 0 ? null : t;
}
async function Ne() {
	let e = await B(I);
	if (e === null || typeof e.organizationId != "string") return null;
	let t = new Date(e.cachedAt).getTime();
	return Number.isNaN(t) || Date.now() - t > je ? null : e.organizationId;
}
async function Pe(e) {
	let t = {
		organizationId: e,
		cachedAt: (/* @__PURE__ */ new Date()).toISOString()
	};
	await chrome.storage.local.set({ [I]: t });
}
async function Fe() {
	await chrome.storage.local.remove(I);
}
var Ie = {
	read: Ne,
	write: Pe,
	clear: Fe
};
async function Le() {
	return B(L);
}
async function V(e) {
	await chrome.storage.local.set({ [L]: e });
}
function H(e, t) {
	return e.windows.find((e) => e.kind === t);
}
async function Re(e, t) {
	let n = await B(R) ?? [], r = Array.isArray(n) ? n : [], i = H(e, "fiveHour"), a = H(e, "sevenDay"), o = H(e, "sevenDayOpus"), s = {
		fetchedAt: t,
		fiveHourPercent: i?.utilizationPercent ?? null,
		sevenDayPercent: a?.utilizationPercent ?? null,
		sevenDayOpusPercent: o?.utilizationPercent ?? null,
		fiveHourResetsAt: i?.resetsAt ?? null,
		sevenDayResetsAt: a?.resetsAt ?? null,
		sevenDayOpusResetsAt: o?.resetsAt ?? null
	}, c = [...r, s], l = c.slice(Math.max(0, c.length - Me));
	await chrome.storage.local.set({ [R]: l });
}
async function ze() {
	return B(z);
}
async function Be(e) {
	await chrome.storage.local.set({ [z]: e });
}
//#endregion
//#region src/lib/scheduleTime.ts
var U = {
	hour: 2,
	minute: 0
};
function W(e, t) {
	return typeof e == "number" && Number.isInteger(e) && e >= 0 && e <= t;
}
function Ve(e) {
	if (typeof e != "object" || !e) return U;
	let { hour: t, minute: n } = e;
	return !W(t, 23) || !W(n, 59) ? U : {
		hour: t,
		minute: n
	};
}
//#endregion
//#region src/lib/settingsTypes.ts
var G = "~/code", K = {
	notificationsEnabled: !1,
	autonomousWork: {
		scheduleTime: U,
		newProjectsDirectory: G
	}
};
function He(e) {
	if (typeof e != "object" || !e) return K;
	let { notificationsEnabled: t, autonomousWork: n } = e, r = typeof n == "object" && n ? n : {}, i = typeof r.newProjectsDirectory == "string" && r.newProjectsDirectory.trim() !== "" ? r.newProjectsDirectory : G;
	return {
		notificationsEnabled: typeof t == "boolean" ? t : K.notificationsEnabled,
		autonomousWork: {
			scheduleTime: Ve(r.scheduleTime),
			newProjectsDirectory: i
		}
	};
}
//#endregion
//#region src/extension/settingsStorage.ts
var q = "settings";
async function J() {
	return He((await chrome.storage.local.get(q))[q]);
}
//#endregion
//#region src/extension/serviceWorker.ts
var Y = "refreshUsage", Ue = 5;
async function X(e) {
	await chrome.action.setTitle({ title: e === null ? h : g(e) });
}
async function We(e, t, n) {
	if (!(await J()).notificationsEnabled) return;
	let r = v(e, t, n), i = {
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
async function Ge() {
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
async function Z() {
	try {
		let e = await he({
			fetch: globalThis.fetch.bind(globalThis),
			organizationIdCache: Ie
		}), t = /* @__PURE__ */ new Date(), n = t.toISOString(), r = {
			snapshot: e,
			fetchedAt: n,
			error: null
		};
		await V(r), await Re(e, n), await X(e), await ke(e, t);
		let i = f(e, t), a = ie(i);
		if (a !== null) {
			let e = await ze();
			e !== a && (await We(e, a, i), await Be(a));
		}
		return r;
	} catch (e) {
		let t = await Le(), n = {
			snapshot: t?.snapshot ?? null,
			fetchedAt: t?.fetchedAt ?? null,
			error: E(e)
		};
		return await V(n), await X(n.snapshot), n;
	}
}
async function Q() {
	await F((await J()).autonomousWork);
}
function $() {
	chrome.alarms.create(Y, {
		periodInMinutes: Ue,
		delayInMinutes: .1
	});
}
chrome.runtime.onInstalled.addListener(() => {
	$(), Z(), Q();
}), chrome.runtime.onStartup.addListener(() => {
	$(), Z(), Q();
}), chrome.alarms.onAlarm.addListener((e) => {
	e.name === Y && Z();
}), chrome.runtime.onMessage.addListener((e, t, n) => ge(e) ? (Z().then((e) => n(e), (e) => n({
	snapshot: null,
	fetchedAt: null,
	error: E(e)
})), !0) : ve(e) ? (Ae().then((e) => n(e)), !0) : ye(e) ? (A().then(() => n({ opened: !0 }), (e) => n({
	opened: !1,
	error: String(e)
})), !0) : be(e) ? (F(e.settings).then((e) => n(e)), !0) : _e(e) ? (Ge().then(() => n({ success: !0 })).catch((e) => {
	console.error("Test notification error:", e), n({
		success: !1,
		error: String(e)
	});
}), !0) : !1), chrome.windows.onRemoved.addListener(we), $(), chrome.action.setBadgeText({ text: "" });
//#endregion
