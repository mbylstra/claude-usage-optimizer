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
function ae(e, t, n) {
	let r = m(n, "fiveHour"), i = m(n, "sevenDay");
	if (e === null) return "Initial recommendation";
	if (e === t) return "Recommendation unchanged";
	let a = r?.isActive ? _(r) : null, o = i?.isActive ? _(i) : null;
	return oe(t, e) ? se(a, o, t) : ce(a, o, t);
}
function oe(e, t) {
	let n = {
		haiku: 0,
		sonnet: 1,
		opus: 2
	};
	return (n[e] ?? -1) > (n[t] ?? -1);
}
function se(e, t, n) {
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
function ce(e, t, n) {
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
var le = "https://claude.ai/api", v = class extends Error {
	code;
	httpStatus;
	constructor(e, t, n) {
		super(t), this.name = "ClaudeUsageError", this.code = e, this.httpStatus = n;
	}
}, y = {
	fiveHour: ["five_hour", "fiveHour"],
	sevenDay: ["seven_day", "sevenDay"],
	sevenDayOpus: ["seven_day_opus", "sevenDayOpus"]
}, ue = [
	"utilization",
	"utilization_pct",
	"utilizationPercent"
], de = [
	"resets_at",
	"reset_at",
	"resetsAt"
], b = [
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
		n = await e.fetch(`${le}${t}`, {
			method: "GET",
			credentials: "include",
			headers: { Accept: "application/json" }
		});
	} catch {
		throw new v("NETWORK_ERROR", "Could not reach claude.ai. Check your connection.");
	}
	if (n.status === 401 || n.status === 403) throw new v("NOT_LOGGED_IN", "Not logged in to Claude.ai.", n.status);
	if (!n.ok) throw new v("HTTP_ERROR", `Claude.ai returned an unexpected response (${n.status}).`, n.status);
	try {
		return await n.json();
	} catch {
		throw new v("MALFORMED_RESPONSE", "Could not read the response from Claude.ai.");
	}
}
async function fe(e) {
	let t = await w(e, "/organizations");
	if (!Array.isArray(t) || t.length === 0) throw new v("NO_ORGANIZATIONS", "No Claude.ai organizations found.");
	let n = t.filter(x), r = n.find((e) => {
		let t = e.capabilities;
		return Array.isArray(t) && t.includes("chat");
	}) ?? n[0], i = r === void 0 ? null : C(r, ["uuid", "id"]);
	if (i === null) throw new v("NO_ORGANIZATIONS", "No Claude.ai organizations found.");
	return i;
}
function pe(e, t) {
	let n = y[t].map((t) => e[t]).find((e) => x(e));
	if (n === void 0) return null;
	let r = S(n, ue);
	return r === null ? null : {
		kind: t,
		utilizationPercent: r,
		resetsAt: C(n, de),
		startedAt: C(n, b)
	};
}
function me(e) {
	if (!x(e)) throw new v("MALFORMED_RESPONSE", "Unexpected usage response from Claude.ai.");
	let t = Object.keys(y).map((t) => pe(e, t)).filter((e) => e !== null);
	if (t.length === 0) throw new v("MALFORMED_RESPONSE", "Claude.ai did not report any usage windows.");
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
		if (t instanceof v && t.code === "NOT_LOGGED_IN") throw t;
		await e.organizationIdCache.clear();
	}
	let n = await fe(e), r = await T(e, n);
	return await e.organizationIdCache.write(n), r;
}
function E(e) {
	return e instanceof v ? e.httpStatus === void 0 ? {
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
	return typeof e == "object" && !!e && e.type === "PRIME_FOLDER_ACCESS";
}
function xe(e) {
	return typeof e == "object" && !!e && e.type === "SYNC_AUTONOMOUS_WORK_SETTINGS";
}
//#endregion
//#region src/extension/runLogWindow.ts
var Se = "run-log.html", Ce = 520, D = 680, O = "runLogWindowId";
async function k() {
	let e = (await chrome.storage.session.get(O))[O];
	return typeof e == "number" ? e : null;
}
async function A(e) {
	try {
		return await chrome.windows.update(e, {
			focused: !0,
			drawAttention: !0
		}), !0;
	} catch {
		return !1;
	}
}
async function we() {
	let e = await k();
	if (e !== null && await A(e)) return;
	let t = await chrome.windows.create({
		url: chrome.runtime.getURL(Se),
		type: "popup",
		width: Ce,
		height: D
	});
	t?.id !== void 0 && await chrome.storage.session.set({ [O]: t.id });
}
function Te(e) {
	k().then((t) => {
		t === e && chrome.storage.session.remove(O);
	});
}
//#endregion
//#region src/lib/usageSnapshotExport.ts
function j(e, t) {
	return m(e, t)?.percentUsed ?? null;
}
function Ee(e, t) {
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
var De = "snapshot", Oe = "runAutonomousWork", ke = "primeFolderAccess", Ae = "setAutonomousWorkSettings";
async function je(e, t) {
	try {
		let n = Ee(e, t), r = await chrome.runtime.sendNativeMessage(M, {
			type: De,
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
async function Me() {
	try {
		let e = await chrome.runtime.sendNativeMessage(M, { type: Oe });
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
async function Ne() {
	try {
		let e = await chrome.runtime.sendNativeMessage(M, { type: ke });
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
			type: Ae,
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
var I = "organizationId", L = "usageCache", R = "usageHistory", z = "suggestedModel", Pe = 864e5, Fe = 2e3;
async function B(e) {
	let t = (await chrome.storage.local.get(e))[e];
	return t === void 0 ? null : t;
}
async function Ie() {
	let e = await B(I);
	if (e === null || typeof e.organizationId != "string") return null;
	let t = new Date(e.cachedAt).getTime();
	return Number.isNaN(t) || Date.now() - t > Pe ? null : e.organizationId;
}
async function Le(e) {
	let t = {
		organizationId: e,
		cachedAt: (/* @__PURE__ */ new Date()).toISOString()
	};
	await chrome.storage.local.set({ [I]: t });
}
async function Re() {
	await chrome.storage.local.remove(I);
}
var ze = {
	read: Ie,
	write: Le,
	clear: Re
};
async function Be() {
	return B(L);
}
async function V(e) {
	await chrome.storage.local.set({ [L]: e });
}
function H(e, t) {
	return e.windows.find((e) => e.kind === t);
}
async function Ve(e, t) {
	let n = await B(R) ?? [], r = Array.isArray(n) ? n : [], i = H(e, "fiveHour"), a = H(e, "sevenDay"), o = H(e, "sevenDayOpus"), s = {
		fetchedAt: t,
		fiveHourPercent: i?.utilizationPercent ?? null,
		sevenDayPercent: a?.utilizationPercent ?? null,
		sevenDayOpusPercent: o?.utilizationPercent ?? null,
		fiveHourResetsAt: i?.resetsAt ?? null,
		sevenDayResetsAt: a?.resetsAt ?? null,
		sevenDayOpusResetsAt: o?.resetsAt ?? null
	}, c = [...r, s], l = c.slice(Math.max(0, c.length - Fe));
	await chrome.storage.local.set({ [R]: l });
}
async function He() {
	return B(z);
}
async function Ue(e) {
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
function We(e) {
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
function Ge(e) {
	if (typeof e != "object" || !e) return K;
	let { notificationsEnabled: t, autonomousWork: n } = e, r = typeof n == "object" && n ? n : {}, i = typeof r.newProjectsDirectory == "string" && r.newProjectsDirectory.trim() !== "" ? r.newProjectsDirectory : G;
	return {
		notificationsEnabled: typeof t == "boolean" ? t : K.notificationsEnabled,
		autonomousWork: {
			scheduleTime: We(r.scheduleTime),
			newProjectsDirectory: i
		}
	};
}
//#endregion
//#region src/extension/settingsStorage.ts
var q = "settings";
async function J() {
	return Ge((await chrome.storage.local.get(q))[q]);
}
//#endregion
//#region src/extension/serviceWorker.ts
var Y = "refreshUsage", Ke = 5;
async function X(e) {
	await chrome.action.setTitle({ title: e === null ? h : g(e) });
}
async function qe(e, t, n) {
	if (!(await J()).notificationsEnabled) return;
	let r = ae(e, t, n), i = {
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
async function Je() {
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
			organizationIdCache: ze
		}), t = /* @__PURE__ */ new Date(), n = t.toISOString(), r = {
			snapshot: e,
			fetchedAt: n,
			error: null
		};
		await V(r), await Ve(e, n), await X(e), await je(e, t);
		let i = f(e, t), a = ie(i);
		if (a !== null) {
			let e = await He();
			e !== a && (await qe(e, a, i), await Ue(a));
		}
		return r;
	} catch (e) {
		let t = await Be(), n = {
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
		periodInMinutes: Ke,
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
})), !0) : ve(e) ? (Me().then((e) => n(e)), !0) : be(e) ? (Ne().then((e) => n(e)), !0) : ye(e) ? (we().then(() => n({ opened: !0 }), (e) => n({
	opened: !1,
	error: String(e)
})), !0) : xe(e) ? (F(e.settings).then((e) => n(e)), !0) : _e(e) ? (Je().then(() => n({ success: !0 })).catch((e) => {
	console.error("Test notification error:", e), n({
		success: !1,
		error: String(e)
	});
}), !0) : !1), chrome.windows.onRemoved.addListener(Te), $(), chrome.action.setBadgeText({ text: "" });
//#endregion
