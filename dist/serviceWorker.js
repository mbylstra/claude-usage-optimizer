//#region src/lib/usageTypes.ts
var e = 6e4, t = 60 * e, n = 24 * t;
5 * t, 7 * n, 7 * n, 15 * e, 30 * e, 60 * e, 12 * t, 24 * t, 48 * t;
//#endregion
//#region src/lib/usagePace.ts
function r(e) {
	return Number.isFinite(e) ? Math.min(100, Math.max(0, e)) : 0;
}
function i(e) {
	return e.windows.reduce((e, t) => Math.max(e, r(t.utilizationPercent)), 0);
}
//#endregion
//#region src/lib/usageToolbarTitle.ts
var a = "Claude Usage Optimizer";
function o(e) {
	return `Claude usage: ${Math.round(i(e))}% of the closest limit`;
}
//#endregion
//#region src/extension/claudeUsageClient.ts
var s = "https://claude.ai/api", c = class extends Error {
	code;
	httpStatus;
	constructor(e, t, n) {
		super(t), this.name = "ClaudeUsageError", this.code = e, this.httpStatus = n;
	}
}, l = {
	fiveHour: ["five_hour", "fiveHour"],
	sevenDay: ["seven_day", "sevenDay"],
	sevenDayOpus: ["seven_day_opus", "sevenDayOpus"]
}, u = [
	"utilization",
	"utilization_pct",
	"utilizationPercent"
], d = [
	"resets_at",
	"reset_at",
	"resetsAt"
], f = [
	"starts_at",
	"started_at",
	"window_start",
	"startsAt"
];
function p(e) {
	return typeof e == "object" && !!e && !Array.isArray(e);
}
function m(e, t) {
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
function h(e, t) {
	for (let n of t) {
		let t = e[n];
		if (typeof t == "string" && t.trim() !== "") return t;
	}
	return null;
}
async function g(e, t) {
	let n;
	try {
		n = await e.fetch(`${s}${t}`, {
			method: "GET",
			credentials: "include",
			headers: { Accept: "application/json" }
		});
	} catch {
		throw new c("NETWORK_ERROR", "Could not reach claude.ai. Check your connection.");
	}
	if (n.status === 401 || n.status === 403) throw new c("NOT_LOGGED_IN", "Not logged in to Claude.ai.", n.status);
	if (!n.ok) throw new c("HTTP_ERROR", `Claude.ai returned an unexpected response (${n.status}).`, n.status);
	try {
		return await n.json();
	} catch {
		throw new c("MALFORMED_RESPONSE", "Could not read the response from Claude.ai.");
	}
}
async function _(e) {
	let t = await g(e, "/organizations");
	if (!Array.isArray(t) || t.length === 0) throw new c("NO_ORGANIZATIONS", "No Claude.ai organizations found.");
	let n = t.filter(p), r = n.find((e) => {
		let t = e.capabilities;
		return Array.isArray(t) && t.includes("chat");
	}) ?? n[0], i = r === void 0 ? null : h(r, ["uuid", "id"]);
	if (i === null) throw new c("NO_ORGANIZATIONS", "No Claude.ai organizations found.");
	return i;
}
function v(e, t) {
	let n = l[t].map((t) => e[t]).find((e) => p(e));
	if (n === void 0) return null;
	let r = m(n, u);
	return r === null ? null : {
		kind: t,
		utilizationPercent: r,
		resetsAt: h(n, d),
		startedAt: h(n, f)
	};
}
function y(e) {
	if (!p(e)) throw new c("MALFORMED_RESPONSE", "Unexpected usage response from Claude.ai.");
	let t = Object.keys(l).map((t) => v(e, t)).filter((e) => e !== null);
	if (t.length === 0) throw new c("MALFORMED_RESPONSE", "Claude.ai did not report any usage windows.");
	return { windows: t };
}
async function b(e, t) {
	return y(await g(e, `/organizations/${encodeURIComponent(t)}/usage`));
}
async function x(e) {
	let t = await e.organizationIdCache.read();
	if (t !== null) try {
		return await b(e, t);
	} catch (t) {
		if (t instanceof c && t.code === "NOT_LOGGED_IN") throw t;
		await e.organizationIdCache.clear();
	}
	let n = await _(e), r = await b(e, n);
	return await e.organizationIdCache.write(n), r;
}
function S(e) {
	return e instanceof c ? e.httpStatus === void 0 ? {
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
function C(e) {
	return typeof e == "object" && !!e && e.type === "REFRESH_USAGE";
}
//#endregion
//#region src/extension/usageStorage.ts
var w = "organizationId", T = "usageCache", E = "usageHistory", D = 864e5, O = 2e3;
async function k(e) {
	let t = (await chrome.storage.local.get(e))[e];
	return t === void 0 ? null : t;
}
async function A() {
	let e = await k(w);
	if (e === null || typeof e.organizationId != "string") return null;
	let t = new Date(e.cachedAt).getTime();
	return Number.isNaN(t) || Date.now() - t > D ? null : e.organizationId;
}
async function j(e) {
	let t = {
		organizationId: e,
		cachedAt: (/* @__PURE__ */ new Date()).toISOString()
	};
	await chrome.storage.local.set({ [w]: t });
}
async function M() {
	await chrome.storage.local.remove(w);
}
var N = {
	read: A,
	write: j,
	clear: M
};
async function P() {
	return k(T);
}
async function F(e) {
	await chrome.storage.local.set({ [T]: e });
}
function I(e, t) {
	return e.windows.find((e) => e.kind === t);
}
async function L(e, t) {
	let n = await k(E) ?? [], r = Array.isArray(n) ? n : [], i = I(e, "fiveHour"), a = I(e, "sevenDay"), o = I(e, "sevenDayOpus"), s = {
		fetchedAt: t,
		fiveHourPercent: i?.utilizationPercent ?? null,
		sevenDayPercent: a?.utilizationPercent ?? null,
		sevenDayOpusPercent: o?.utilizationPercent ?? null,
		fiveHourResetsAt: i?.resetsAt ?? null,
		sevenDayResetsAt: a?.resetsAt ?? null,
		sevenDayOpusResetsAt: o?.resetsAt ?? null
	}, c = [...r, s], l = c.slice(Math.max(0, c.length - O));
	await chrome.storage.local.set({ [E]: l });
}
//#endregion
//#region src/extension/serviceWorker.ts
var R = "refreshUsage", z = 5;
async function B(e) {
	await chrome.action.setTitle({ title: e === null ? a : o(e) });
}
async function V() {
	try {
		let e = await x({
			fetch: globalThis.fetch.bind(globalThis),
			organizationIdCache: N
		}), t = (/* @__PURE__ */ new Date()).toISOString(), n = {
			snapshot: e,
			fetchedAt: t,
			error: null
		};
		return await F(n), await L(e, t), await B(e), n;
	} catch (e) {
		let t = await P(), n = {
			snapshot: t?.snapshot ?? null,
			fetchedAt: t?.fetchedAt ?? null,
			error: S(e)
		};
		return await F(n), await B(n.snapshot), n;
	}
}
function H() {
	chrome.alarms.create(R, {
		periodInMinutes: z,
		delayInMinutes: .1
	});
}
chrome.runtime.onInstalled.addListener(() => {
	H(), V();
}), chrome.runtime.onStartup.addListener(() => {
	H(), V();
}), chrome.alarms.onAlarm.addListener((e) => {
	e.name === R && V();
}), chrome.runtime.onMessage.addListener((e, t, n) => C(e) ? (V().then((e) => n(e), (e) => n({
	snapshot: null,
	fetchedAt: null,
	error: S(e)
})), !0) : !1), H(), chrome.action.setBadgeText({ text: "" });
//#endregion
