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
	let t = h(e, "fiveHour"), n = h(e, "sevenDay");
	if (t === void 0 || n === void 0) return null;
	let r = [re(t), te(n)];
	return r.includes("severe") ? "haiku" : r.includes("caution") ? "sonnet" : "opus";
}
//#endregion
//#region src/lib/modelChangeReason.ts
function ae(e, t, n) {
	let r = h(n, "fiveHour"), i = h(n, "sevenDay");
	if (e === null) return "Initial recommendation";
	if (e === t) return "Recommendation unchanged";
	let a = r?.isActive ? _(r) : null, o = i?.isActive ? _(i) : null;
	return oe(t, e) ? v(a, o, t) : se(a, o, t);
}
function oe(e, t) {
	let n = {
		haiku: 0,
		sonnet: 1,
		opus: 2
	};
	return (n[e] ?? -1) > (n[t] ?? -1);
}
function v(e, t, n) {
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
function fe(e, t) {
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
function S(e, t) {
	for (let n of t) {
		let t = e[n];
		if (typeof t == "string" && t.trim() !== "") return t;
	}
	return null;
}
async function C(e, t) {
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
async function pe(e) {
	let t = await C(e, "/organizations");
	if (!Array.isArray(t) || t.length === 0) throw new y("NO_ORGANIZATIONS", "No Claude.ai organizations found.");
	let n = t.filter(x), r = n.find((e) => {
		let t = e.capabilities;
		return Array.isArray(t) && t.includes("chat");
	}) ?? n[0], i = r === void 0 ? null : S(r, ["uuid", "id"]);
	if (i === null) throw new y("NO_ORGANIZATIONS", "No Claude.ai organizations found.");
	return i;
}
function me(e, t) {
	let n = b[t].map((t) => e[t]).find((e) => x(e));
	if (n === void 0) return null;
	let r = fe(n, le);
	return r === null ? null : {
		kind: t,
		utilizationPercent: r,
		resetsAt: S(n, ue),
		startedAt: S(n, de)
	};
}
function he(e) {
	if (!x(e)) throw new y("MALFORMED_RESPONSE", "Unexpected usage response from Claude.ai.");
	let t = Object.keys(b).map((t) => me(e, t)).filter((e) => e !== null);
	if (t.length === 0) throw new y("MALFORMED_RESPONSE", "Claude.ai did not report any usage windows.");
	return { windows: t };
}
async function w(e, t) {
	return he(await C(e, `/organizations/${encodeURIComponent(t)}/usage`));
}
async function ge(e) {
	let t = await e.organizationIdCache.read();
	if (t !== null) try {
		return await w(e, t);
	} catch (t) {
		if (t instanceof y && t.code === "NOT_LOGGED_IN") throw t;
		await e.organizationIdCache.clear();
	}
	let n = await pe(e), r = await w(e, n);
	return await e.organizationIdCache.write(n), r;
}
function T(e) {
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
function _e(e) {
	return typeof e == "object" && !!e && e.type === "REFRESH_USAGE";
}
function ve(e) {
	return typeof e == "object" && !!e && e.type === "TEST_NOTIFICATION";
}
function ye(e) {
	return typeof e == "object" && !!e && e.type === "RUN_AUTONOMOUS_WORK";
}
function be(e) {
	return typeof e == "object" && !!e && e.type === "OPEN_RUN_LOG";
}
function xe(e) {
	return typeof e == "object" && !!e && e.type === "PRIME_FOLDER_ACCESS";
}
function Se(e) {
	return typeof e == "object" && !!e && e.type === "SYNC_AUTONOMOUS_WORK_SETTINGS";
}
//#endregion
//#region src/extension/runLogWindow.ts
var Ce = "run-log.html", we = 520, Te = 680, E = "runLogWindowId";
async function D() {
	let e = (await chrome.storage.session.get(E))[E];
	return typeof e == "number" ? e : null;
}
async function O(e) {
	try {
		return await chrome.windows.update(e, {
			focused: !0,
			drawAttention: !0
		}), !0;
	} catch {
		return !1;
	}
}
async function Ee() {
	let e = await D();
	if (e !== null && await O(e)) return;
	let t = await chrome.windows.create({
		url: chrome.runtime.getURL(Ce),
		type: "popup",
		width: we,
		height: Te
	});
	t?.id !== void 0 && await chrome.storage.session.set({ [E]: t.id });
}
function De(e) {
	D().then((t) => {
		t === e && chrome.storage.session.remove(E);
	});
}
//#endregion
//#region src/lib/usageSnapshotExport.ts
function k(e, t) {
	return h(e, t)?.percentUsed ?? null;
}
function Oe(e, t) {
	let n = p(e, t), r = h(n, "sevenDay");
	return {
		fetchedAt: t.toISOString(),
		weeklyPaceDeltaMs: r?.isActive ? r.paceDeltaMs : null,
		weeklyPaceStatus: r?.isActive ? r.paceStatus : null,
		fiveHourPercent: k(n, "fiveHour"),
		sevenDayPercent: k(n, "sevenDay"),
		sevenDayOpusPercent: k(n, "sevenDayOpus")
	};
}
//#endregion
//#region src/extension/usageSnapshotExporter.ts
var A = "com.claudeusageoptimizer.usagehost", j = !1;
function M(e) {
	j || (j = !0, console.info(`Usage snapshot not exported (native host "${A}" unavailable). This is expected unless you installed it with \`just install-usage-host\`. Reason: ${String(e)}`));
}
var ke = "snapshot", Ae = "runAutonomousWork", je = "primeFolderAccess", Me = "setAutonomousWorkSettings";
async function Ne(e, t) {
	try {
		let n = Oe(e, t), r = await chrome.runtime.sendNativeMessage(A, {
			type: ke,
			snapshot: n
		});
		if (typeof r == "object" && r && "error" in r) {
			M(r.error);
			return;
		}
		j = !1;
	} catch (e) {
		M(e);
	}
}
async function Pe() {
	try {
		let e = await chrome.runtime.sendNativeMessage(A, { type: Ae });
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
async function Fe() {
	try {
		let e = await chrome.runtime.sendNativeMessage(A, { type: je });
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
async function N(e) {
	try {
		let t = await chrome.runtime.sendNativeMessage(A, {
			type: Me,
			settings: {
				scheduleHour: e.scheduleTime.hour,
				scheduleMinute: e.scheduleTime.minute,
				newProjectsDirectory: e.newProjectsDirectory,
				model: e.model
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
var P = "organizationId", F = "usageCache", I = "usageHistory", L = "suggestedModel", Ie = 864e5, Le = 2e3;
async function R(e) {
	let t = (await chrome.storage.local.get(e))[e];
	return t === void 0 ? null : t;
}
async function Re() {
	let e = await R(P);
	if (e === null || typeof e.organizationId != "string") return null;
	let t = new Date(e.cachedAt).getTime();
	return Number.isNaN(t) || Date.now() - t > Ie ? null : e.organizationId;
}
async function ze(e) {
	let t = {
		organizationId: e,
		cachedAt: (/* @__PURE__ */ new Date()).toISOString()
	};
	await chrome.storage.local.set({ [P]: t });
}
async function Be() {
	await chrome.storage.local.remove(P);
}
var Ve = {
	read: Re,
	write: ze,
	clear: Be
};
async function He() {
	return R(F);
}
async function z(e) {
	await chrome.storage.local.set({ [F]: e });
}
function B(e, t) {
	return e.windows.find((e) => e.kind === t);
}
async function Ue(e, t) {
	let n = await R(I) ?? [], r = Array.isArray(n) ? n : [], i = B(e, "fiveHour"), a = B(e, "sevenDay"), o = B(e, "sevenDayOpus"), s = {
		fetchedAt: t,
		fiveHourPercent: i?.utilizationPercent ?? null,
		sevenDayPercent: a?.utilizationPercent ?? null,
		sevenDayOpusPercent: o?.utilizationPercent ?? null,
		fiveHourResetsAt: i?.resetsAt ?? null,
		sevenDayResetsAt: a?.resetsAt ?? null,
		sevenDayOpusResetsAt: o?.resetsAt ?? null
	}, c = [...r, s], l = c.slice(Math.max(0, c.length - Le));
	await chrome.storage.local.set({ [I]: l });
}
async function We() {
	return R(L);
}
async function Ge(e) {
	await chrome.storage.local.set({ [L]: e });
}
//#endregion
//#region src/lib/scheduleTime.ts
var V = {
	hour: 2,
	minute: 0
};
function H(e, t) {
	return typeof e == "number" && Number.isInteger(e) && e >= 0 && e <= t;
}
function Ke(e) {
	if (typeof e != "object" || !e) return V;
	let { hour: t, minute: n } = e;
	return !H(t, 23) || !H(n, 59) ? V : {
		hour: t,
		minute: n
	};
}
//#endregion
//#region src/lib/settingsTypes.ts
var U = "~/code", W = "opus", G = {
	notificationsEnabled: !1,
	autonomousWork: {
		scheduleTime: V,
		newProjectsDirectory: U,
		model: W
	}
};
function K(e) {
	if (typeof e != "object" || !e) return G;
	let { notificationsEnabled: t, autonomousWork: n } = e, r = typeof n == "object" && n ? n : {}, i = typeof r.newProjectsDirectory == "string" && r.newProjectsDirectory.trim() !== "" ? r.newProjectsDirectory : U, a = [
		"haiku",
		"sonnet",
		"opus"
	].includes(r.model) ? r.model : W;
	return {
		notificationsEnabled: typeof t == "boolean" ? t : G.notificationsEnabled,
		autonomousWork: {
			scheduleTime: Ke(r.scheduleTime),
			newProjectsDirectory: i,
			model: a
		}
	};
}
//#endregion
//#region src/extension/settingsStorage.ts
var q = "settings";
async function J() {
	return K((await chrome.storage.local.get(q))[q]);
}
//#endregion
//#region src/extension/serviceWorker.ts
var Y = "refreshUsage", qe = 5;
async function X(e) {
	await chrome.action.setTitle({ title: e === null ? g : ee(e) });
}
async function Je(e, t, n) {
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
async function Ye() {
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
		let e = await ge({
			fetch: globalThis.fetch.bind(globalThis),
			organizationIdCache: Ve
		}), t = /* @__PURE__ */ new Date(), n = t.toISOString(), r = {
			snapshot: e,
			fetchedAt: n,
			error: null
		};
		await z(r), await Ue(e, n), await X(e), await Ne(e, t);
		let i = p(e, t), a = ie(i);
		if (a !== null) {
			let e = await We();
			e !== a && (await Je(e, a, i), await Ge(a));
		}
		return r;
	} catch (e) {
		let t = await He(), n = {
			snapshot: t?.snapshot ?? null,
			fetchedAt: t?.fetchedAt ?? null,
			error: T(e)
		};
		return await z(n), await X(n.snapshot), n;
	}
}
async function Q() {
	await N((await J()).autonomousWork);
}
function $() {
	chrome.alarms.create(Y, {
		periodInMinutes: qe,
		delayInMinutes: .1
	});
}
chrome.runtime.onInstalled.addListener(() => {
	$(), Z(), Q();
}), chrome.runtime.onStartup.addListener(() => {
	$(), Z(), Q();
}), chrome.alarms.onAlarm.addListener((e) => {
	e.name === Y && Z();
}), chrome.runtime.onMessage.addListener((e, t, n) => _e(e) ? (Z().then((e) => n(e), (e) => n({
	snapshot: null,
	fetchedAt: null,
	error: T(e)
})), !0) : ye(e) ? (Pe().then((e) => n(e)), !0) : xe(e) ? (Fe().then((e) => n(e)), !0) : be(e) ? (Ee().then(() => n({ opened: !0 }), (e) => n({
	opened: !1,
	error: String(e)
})), !0) : Se(e) ? (N(e.settings).then((e) => n(e)), !0) : ve(e) ? (Ye().then(() => n({ success: !0 })).catch((e) => {
	console.error("Test notification error:", e), n({
		success: !1,
		error: String(e)
	});
}), !0) : !1), chrome.windows.onRemoved.addListener(De), $(), chrome.action.setBadgeText({ text: "" });
//#endregion
