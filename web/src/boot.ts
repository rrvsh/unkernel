// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Terminal and boot flow, loaded by main.ts once the preflight passed. The
// SDK does the work (download, streaming compile, memory with fallback
// sizes, console routing, network); this module shows it (with ?worker=1
// the kernel runs in a Web Worker, the SDK's worker mode, which gets the
// module compiled here; input and frames cross through shared memory when
// the page is cross-origin isolated, else as messages, and sound as messages):
// a wterm terminal with a systemd-style boot transcript, the status
// indicator and stages (ui.ts), and the kernel's console as window 0, with
// more terminal windows over vsock (windows.ts), the guest preview
// (preview.ts: guest web servers in an iframe), and the Wayland desktop
// (wayland.ts: the guest's Wayland apps as windows, through kwshm). With several CPUs (?cpus=N,
// config.ts) it loads the SMP kernel instead and boots it in worker mode,
// whose worker starts the other CPUs; whatever stops that before the
// kernel runs reloads once on one CPU (bootUpOnce()). A suspended session
// resumes on the next load, quietly, then says so in a toast (offerResume(),
// sayResumed()), on the CPU count it was saved on (offerResumeCpus()). The kernel is the
// base bundle, with the distro image ?distro= picks (config.ts) attached
// read-only by URL (createKernel({ distro }); inline it is opened here
// first, for the resume check), and the Alpine-only part (the apk index
// prefetch) runs only on Alpine. A machine the user has used is suspended by
// itself when the tab stays hidden (?autosuspend=, phones by default) and
// resumed when it is shown, and closing the page asks first (autosuspend.ts).
import "@wterm/dom/src/terminal.css";
import { WTerm } from "@wterm/dom";
import { prefetchApkIndexes } from "./apk.ts";
import { createAudioOut } from "./audio.ts";
import { AUTO_SUSPEND_HOLD_MS, AutoSuspend, AutoSuspendSkip, LEAVE_OFFER_MS, LEAVE_STAYED_MS, Pause, SuspendSaveError, allowLeave, autoSuspendLabel, pageLeaving, quietStart, resumeAskedFor, resumeChoice, resumedNote, sessionRoom, wantLeavePrompt, type SuspendFacts } from "./autosuspend.ts";
import { CPUS_ONCE_KEY, GL_DISTROS, INLINE_ONCE_KEY, REPO, UP_ONCE_KEY } from "./config.ts";
import { attachDataDisk, attachSeedDisk, detachDataDisk, downloadKwsparse, exportDataDisk, fmtSize, importDataDisk, resetDataDisk, storageState, acquireDiskLock, type DataAttach } from "./data.ts";
import { createDisplayUi } from "./display.ts";
import { KW } from "./kw.ts";
import { showcaseFromUrl, waitPort } from "./launcher.ts";
import { browserNet, browserNetSpec } from "./net.ts";
import { openCommand } from "./open.ts";
import { attachPreview, closePreview, openPreview, previewSupported, previewUrl } from "./preview.ts";
import { ui$ } from "./store.ts";
import { ScreenTail, clearSession, loadSession, saveSession, sessionCpus, sessionInfo, sessionMismatch, type SessionDevices, type SessionMeta } from "./session.ts";
import { APPLE, CHORD } from "./shortcuts.ts";
import { dropLegacyScope } from "./sw.ts";
import { clearResumeRequest, setResumeRequest, takeResumeRequest } from "./ui.ts";
import { createWindows, pasteText, setTermFont, termText, TERM_OPTIONS } from "./windows.ts";
import { attachWayland, waylandApi } from "./wayland.ts";
import {
	BootError, ConsoleRouter, KernelInstance, SnapshotCommitError, WorkerKernel, bundledBoot, createKernel, loadKernelModule, openDistroDisk, serveWasiPrograms, snapshotDiskMismatch,
	type BlockDevice, type DistroDisk, type BootProgress, type DiskSpec, type DiskState, type DownloadProgress, type Kernel, type KernelHandle, type KernelSnapshot, type SnapshotHoldDecision,
	type GlStats, type VirglTotals,
} from "./sdk.ts";

/** The virtio-gpu device's 3D counters (vm.gl.stats.gpu). */
type GpuRendererStats = NonNullable<GlStats["gpu"]>;

/** An error tagged with what failed (fetch, compile, memory, boot) and the boot stage it belongs to. */
type StageError = Error & { kind?: string; stageId?: string };
const tag = (e: unknown, kind: string, stageId: string): StageError => Object.assign(e instanceof Error ? e : new Error(String(e)), { kind, stageId });

const fmtMiB = (n: number) => `${(n / 1048576).toFixed(1)} MiB`;
/** How long the toast after a resume ("Resumed the session suspended …", sayResumed()) shows. */
const RESUMED_TOAST_MS = 5000;
const fmtS = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`);

// The terminal's colours and font are CSS custom properties (style.css, #term).
const SGR = { ok: "\x1b[32m", warn: "\x1b[33m", fail: "\x1b[31m", busy: "\x1b[36m", dim: "\x1b[2m", gray: "\x1b[90m", bold: "\x1b[1m", off: "\x1b[0m" };

/**
 * Pip from the logo (assets/logo.svg) as 10x8 pixels in truecolor half
 * blocks (wterm draws U+2580-259F as solid blocks): four lines, 10 cells each.
 */
const PIP = ((art: string[]) => {
	const rgb: Record<string, string> = {
		O: "106;84;24", Y: "255;212;90", S: "232;168;60", H: "255;244;192",
		E: "42;26;16", B: "255;154;138", G: "111;220;111", g: "79;176;79",
	};
	const lines: string[] = [];
	for (let y = 0; y < art.length; y += 2) {
		const top = art[y]!, bottom = art[y + 1]!;
		let s = "";
		for (let x = 0; x < top.length; x++) {
			const t = rgb[top[x]!], b = rgb[bottom[x]!];
			s += !t && !b ? `${SGR.off} ` : t && b ? (t === b ? `\x1b[0;38;2;${t}m█` : `\x1b[0;38;2;${t};48;2;${b}m▀`) :
				t ? `\x1b[0;38;2;${t}m▀` : `\x1b[0;38;2;${b}m▄`;
		}
		lines.push(s + SGR.off);
	}
	return Object.assign(lines, { width: art[0]!.length });
})([
	"...g.GG...",
	"....g.....",
	"..OOOOOO..",
	".OHYYYYYO.",
	".OYEYYEYO.",
	".OBYYYYBO.",
	".OYYYYSSO.",
	"..OOOOOO..",
]);
const STEP: Record<string, string> = { kernel: "Download the kernel", compile: "Compile the kernel", memory: "Allocate kernel memory", boot: "Boot the kernel" };

/**
 * A guest `reboot` (halt code 2) reloads the page, at most 3 times a
 * minute, so a guest that reboots in a loop ends up halted instead of
 * reloading forever. The count lives in sessionStorage (this tab only);
 * without it, auto-reboot still works but is not limited.
 */
const AUTO_REBOOT_KEY = "kw-auto-reboot", AUTO_REBOOT_MAX = 3, AUTO_REBOOT_WINDOW = 60000;
function autoRebootAllowed(): boolean {
	const now = Date.now();
	let times: number[] = [];
	try {
		const v: unknown = JSON.parse(sessionStorage.getItem(AUTO_REBOOT_KEY) ?? "[]");
		if (Array.isArray(v)) times = v.filter((t): t is number => typeof t === "number" && now - t < AUTO_REBOOT_WINDOW);
	} catch { /* storage blocked or bad value: no limit */ }
	if (times.length >= AUTO_REBOOT_MAX) return false;
	try { sessionStorage.setItem(AUTO_REBOOT_KEY, JSON.stringify([...times, now])); } catch { /* see above */ }
	return true;
}

export function start(): void {
	const ui = KW.ui!;
	const cfg = KW.config;
	KW.started = true;
	const g = globalThis as unknown as { term?: WTerm; kernel?: Kernel; vm?: KernelHandle };
	// A KernelInstance, or with ?worker=1 a WorkerKernel (no low-level kernel; the display, evdev and sound through messages).
	let vm: KernelHandle | null = null;
	const local = (): KernelInstance | null => (vm instanceof KernelInstance ? vm : null);
	let vmExited = false;
	/** createKernel() is running (in worker mode the worker may be opening the data disk). */
	let kernelStarting = false;
	/** The kernel has exited (inline: the moment it does; a worker: once its exit message arrived). */
	const ended = () => { const l = local(); return l ? !!l.kernel.result : vmExited; };
	const send = (s: string | Uint8Array) => vm?.write(s);
	/** This load boots the SMP kernel on several CPUs (config.ts). */
	const smp = cfg.cpus > 1;
	/** The kernel this load runs: the base's UP bundle, or its SMP one (sdk.ts kernelSmpUrl). */
	const kernelUrl = smp ? cfg.kernelSmpUrl! : cfg.kernelUrl;
	/** The image this load boots (null: ?distro=none). */
	const distro = cfg.distro;
	/** The session's distro (session.ts). */
	const distroRef = distro ? { name: distro.name, url: distro.url } : null;
	/** Inline: the distro image, opened ahead (the snapshot's first disk, for the resume check). */
	let distroDisk: DistroDisk | null = null;
	/** Only Alpine has apk and the index the page pushes (apk.ts). */
	const alpine = cfg.guest === "alpine";

	// A key typed for the guest (into a terminal, or the display), seen ahead of display.ts's routing,
	// which keeps the display's keys to itself: it ends a pause by hand and drops the notification that
	// offers one (guestKey, set with them below). The shortcut prefix's keys never get here (shortcuts.ts).
	let guestKey: (() => void) | null = null;
	addEventListener("keydown", (e) => {
		if (!guestKey || !e.isTrusted || /^(Shift|Control|Alt|Meta|CapsLock|Fn)$/.test(e.key)) return;
		const t = e.target as Element | null;
		if (t?.closest?.("#panel, #scrim, #bar, #confirm, #paste, #launcher, #toast, #resume-card")) return;
		if (t?.closest?.("input, textarea, select, [contenteditable]") && !t.closest("#terms")) return;
		guestKey();
	}, true);

	// --- display and input (kwfb, kwinput; ?display=0 turns them off): display.ts --------------
	const display = createDisplayUi({
		vm: () => (vm instanceof KernelInstance || vm instanceof WorkerKernel ? vm : null), touch: cfg.mobile, sendTty: (s) => KW.term?.send(s),
		appCursor: () => !!KW.term?.appCursor(),
		focusTerminal: () => KW.term?.focus(),
	});

	// --- data disk (persistent /data) -------------------------------------------
	// Shown in the panel's Environment list ("Data disk", "Storage") and its
	// Data disk section; QuotaExceededError and other failed saves are errors.
	let data: DataAttach | null = null;
	let saveErrorShown = -Infinity, storageFailed = false;
	function saveError(e: unknown) {
		storageFailed = true;
		const err = e as Error | undefined;
		const quota = err?.name === "QuotaExceededError";
		ui.check("storage", "Storage", "fail", quota ? "quota exceeded" : "save failed", `${err?.name ?? ""} ${err?.message ?? e}`);
		if (performance.now() - saveErrorShown < 30000) return; // once per burst of failed flushes
		saveErrorShown = performance.now();
		KW.report("storage", quota
			? "The browser's storage quota is full: disk changes are NOT being saved (the guest sees I/O errors). Free space, or export the data disk and reset it."
			: `Saving disk changes to IndexedDB failed: ${err?.message ?? e}`, err?.stack ?? "", false);
	}
	const dataLog = (m: string) => { console.log(m); ui.hostLog(m); };
	async function showStorage({ ask = false } = {}) {
		const st = await storageState({ ask });
		if (storageFailed) return; // keep the failure visible
		const usage = st.usage !== undefined ? `${fmtSize(st.usage)} used${st.quota ? ` of ${fmtSize(st.quota)}` : ""}` : "usage unknown";
		ui.check("storage", "Storage", st.persisted ? "pass" : "info", `${st.persisted === undefined ? "persistence unknown" : st.persisted ? "persistent" : "best effort"}, ${usage}`,
			st.persisted ? "not evicted under storage pressure" : st.persisted === false ? "the browser may evict the saved disks under storage pressure (it did not grant navigator.storage.persist())" : "");
	}
	const diskLabel = cfg.portable ? "Root disk" : "Data disk";
	/** Worker mode: the worker's latest snapshot of the persistent disk (spec 0), if it was built. */
	const workerData = (): DiskState | undefined => (vm instanceof WorkerKernel ? vm.disks.find((d) => d.index === 0 && d.kind === (cfg.portable ? "seed" : "data")) : undefined);
	function dataStatus() {
		const d = data?.disk;
		const w = d ? undefined : workerData();
		if (w) {
			const blocks = w.overlayBlocks ?? 0;
			ui.diskUsage(blocks * 4096, w.size, w.persistent);
			ui.dataStatus(w.persistent
				? `Saved in this browser (IndexedDB ${w.store}, written by the kernel worker): ${fmtSize(w.size)} disk, ${blocks} blocks (${fmtSize(blocks * 4096)}) stored.`
				: `In memory only: ${data?.notice ?? w.notice ?? "not saved"}.`);
			return;
		}
		if (!d) return;
		const blocks = d.overlayBlocks;
		ui.diskUsage(blocks * 4096, d.size, d.persistent);
		ui.dataStatus(d.persistent
			? `Saved in this browser (IndexedDB ${d.store?.name}): ${fmtSize(d.size)} disk, ${blocks} blocks (${fmtSize(blocks * 4096)}) stored.`
			: `In memory only: ${data?.notice ?? d.notice ?? "not saved"}.`);
	}
	async function openData(module: WebAssembly.Module): Promise<BlockDevice[]> {
		// Opening IndexedDB, the tab lock, and loading the stored blocks (or seeding from the template).
		const t0 = performance.now();
		try {
			data = cfg.portable
				? await attachSeedDisk(cfg.portable, { log: dataLog, onError: saveError })
				: await attachDataDisk({ enabled: cfg.data, bundled: bundledBoot(module).datadisk, log: dataLog, onError: saveError });
		} catch (e) {
			data = { disk: null, lock: null, reason: `failed: ${(e as Error).message}` };
			console.error(e);
		}
		const ms = performance.now() - t0;
		KW.dataDisk = data.disk;
		const d = data.disk;
		showData(d ? { size: d.size, seeded: d.seeded, storedBlocks: d.stored.size } : null, ms);
		if (cfg.portable && !d) throw new Error(`the portable root disk is unavailable: ${data.reason ?? "unknown error"}`);
		return d ? [d] : [];
	}
	/** The data disk's rows, boot line and status, inline or (from the worker's snapshot) in worker mode. */
	function showData(d: { size: number; seeded?: boolean; storedBlocks?: number } | null, ms: number) {
		if (!data) return;
		if (!d) {
			ui.check("data", diskLabel, "info", "none", data.reason);
			ui.dataStatus(`No data disk: ${data.reason}.`);
			ui.hostLog(`[host] data disk: none (${data.reason}, ${fmtS(ms)})`);
			if (cfg.data && !/no IndexedDB/.test(data.reason ?? "")) warn(`No data disk: ${data.reason}`, ms);
			return;
		}
		const dev = distro ? "/dev/wdb" : "/dev/wda"; // the distro image is wda
		if (data.notice) {
			ui.check("data", diskLabel, "warn", `${dev}, not saved`, data.notice);
			warn(`Data disk ${dev}: ${data.notice}`, ms);
			ui.toast(`Data disk not saved: ${data.notice}`);
			ui.hostLog(`[host] data disk: ${data.notice}`);
		} else {
			const stored = d.storedBlocks ?? 0;
			ui.check("data", diskLabel, "pass", `${dev} (${fmtSize(d.size)}), saved in this browser`,
				`${d.seeded ? `created from the template (${data.from})` : `${stored} blocks stored`}; lock: ${data.lock?.how}; opened in ${fmtS(ms)}` +
				(cfg.worker ? "; the kernel worker writes it" : ""));
			ok(`Attached the data disk ${dev} (${d.seeded ? "new" : `${fmtSize(stored * 4096)} stored`})`, ms);
			void showStorage({ ask: true });
		}
		dataStatus();
		setInterval(dataStatus, 5000); // the stored block count grows as the guest writes
	}
	/**
	 * Worker mode: the data disk as a spec. The lock is taken here, on the
	 * page (the worker then is the only writer of the store; a tab without
	 * the lock gets a snapshot); the worker opens IndexedDB and builds it.
	 */
	async function dataSpec(): Promise<DiskSpec[]> {
		if (!cfg.data) data = { disk: null, lock: null, reason: "off (?data=0)" };
		else if (typeof indexedDB === "undefined") data = { disk: null, lock: null, reason: "no IndexedDB in this browser" };
		else {
			const lock = await acquireDiskLock(cfg.portable?.name);
			data = { disk: null, lock, from: cfg.portable?.url ?? "bundled in the kernel" };
			if (cfg.portable) {
				if (!lock.held) throw new Error("this portable machine is open in another tab");
				return [{ kind: "seed", ...cfg.portable }];
			}
			return [{ kind: "data", template: "bundled", mode: lock.held ? "persistent" : "snapshot", optional: true }];
		}
		KW.dataDisk = null;
		showData(null, 0);
		return [];
	}
	/** Worker mode, once booted: what the worker built (or why not), shown like an inline attach. */
	function workerDataAttached(w: WorkerKernel, ms: number) {
		if (!data?.lock) return; // no spec was sent
		KW.dataDisk = null; // the CowDisk is in the worker: KW.vm.disks has its state
		const st = workerData();
		const skipped = w.skippedDisks.find((d) => d.index === 0);
		if (!st) {
			data.reason = skipped ? `failed: ${skipped.reason}` : "not attached";
			showData(null, ms);
			return;
		}
		if (!data.lock.held) data.notice = `open in another tab: this tab's /data is ${st.notice ?? "in memory"} (changes are not saved)`;
		else if (!st.persistent) data.notice = st.notice ?? "not saved";
		showData({ size: st.size, seeded: st.seeded, storedBlocks: st.storedBlocks }, ms);
	}
	/** Sync the guest's file systems to the persistent disks (the SDK's sync()). */
	KW.sync = (opts) => (vm && !ended() ? vm.sync(opts) : Promise.resolve(true));
	/**
	 * Reboot discards this machine, and with it any record of it that is still
	 * saved (held by Pause or in the background, the resumed one before an SMP
	 * resume deleted it, one a given-up save left): the load after Reboot would
	 * otherwise keep it or ask about it. A session kept from before is the
	 * next load's to decide (resumeChoice()). Then the sync.
	 */
	KW.beforeReboot = async () => {
		const own = [holdState?.saved, resumedSaved, strandedSaved].filter((t): t is number => typeof t === "number");
		await Promise.all(own.map((t) => clearSession(t).catch(() => {})));
		return KW.sync!();
	};
	document.addEventListener("visibilitychange", () => {
		// A suspend that starts now seals the disks itself (autosuspend.ts); else sync them.
		if (document.visibilityState === "hidden") { if (!auto.hidden()) void KW.sync!().then(dataStatus); }
		else auto.shown();
	});
	addEventListener("pagehide", () => { void KW.sync!(); });
	/** Download the data disk as a .kwsparse.gz file (synced first). */
	KW.exportData = async () => {
		const d = data?.disk;
		const w = d ? undefined : workerData();
		if (w && vm instanceof WorkerKernel) {
			// Worker mode: the worker reads the disk (memory and store) and hands over the parts.
			if (w.persistent && !(await KW.sync!())) ui.hostLog("[host] data disk: the guest did not confirm a sync; exporting what was flushed");
			const { parts, blocks } = await vm.exportDisk(0);
			const r = await downloadKwsparse(parts, blocks, cfg.portable?.name ?? "kwdata");
			ui.hostLog(`[host] data disk: exported ${r.blocks} blocks as ${r.name} (${fmtSize(r.bytes)}), from the kernel worker`);
			return r;
		}
		if (!d) throw new Error(`no data disk is attached${data?.reason ? ` (${data.reason})` : ""}`);
		if (d.persistent && !(await KW.sync!())) ui.hostLog("[host] data disk: the guest did not confirm a sync; exporting what was flushed");
		const r = await exportDataDisk(d, cfg.portable?.name ?? "kwdata");
		ui.hostLog(`[host] data disk: exported ${r.blocks} blocks as ${r.name} (${fmtSize(r.bytes)})`);
		return r;
	};
	async function takeOverData() {
		if (data?.lock && !data.lock.held) throw new Error("the data disk is open in another tab; close it first");
		if (!data?.lock && !(await acquireDiskLock(cfg.portable?.name)).held) throw new Error("the data disk is open in another tab; close it first");
		if (cfg.worker) {
			// The kernel worker writes the store: it must stop (and close it) before this page touches it.
			if (!vm && kernelStarting) throw new Error("the kernel worker is still starting (it may be opening the data disk); try again once it runs");
			if (vm instanceof WorkerKernel && !ended() && workerData()?.store) await vm.detachDisk(0);
			return;
		}
		await detachDataDisk(data?.disk); // the running guest's later writes are not saved
	}
	function reloadPage() {
		allowLeave();
		const u = new URL(location.href);
		u.searchParams.delete("reset");
		location.replace(u);
	}
	/** Replace the saved data disk with a .kwsparse[.gz] file (File, Blob or bytes), then reload. */
	KW.importData = async (file) => {
		const bytes = file instanceof Uint8Array ? file : new Uint8Array(await file.arrayBuffer());
		await takeOverData();
		const r = await importDataDisk(bytes, { name: cfg.portable?.name, version: cfg.portable?.version, size: data?.disk?.size ?? workerData()?.size, log: dataLog });
		ui.hostLog(`[host] data disk: imported ${r.blocks} blocks; reloading`);
		reloadPage();
		return r;
	};
	/** Forget the saved data disk (the next boot starts from the template), then reload. */
	KW.resetData = async () => {
		await takeOverData();
		await resetDataDisk({ name: cfg.portable?.name, version: cfg.portable?.version });
		ui.hostLog("[host] data disk: reset; reloading");
		reloadPage();
	};

	// --- terminal -------------------------------------------------------------
	// wterm renders the rows as DOM text in #term, which is also the scroll
	// container, so scrolling (touch momentum, the scrollbar) is the browser's
	// own. It sizes the grid to the element (autoResize, also when the font
	// size changes) and onResize passes the size on to the guest tty.
	const termEl = document.getElementById("term")!;
	// wterm takes the row height from --term-row-height (it does not follow the font):
	// setTermFont sets both. Its font probe then refits the grid.
	setTermFont(termEl, cfg.fontSize);
	const term = new WTerm(termEl, {
		...TERM_OPTIONS,
		onData: (d) => send(ui.applyModifiers(d)),
		onBinary: (d) => send(d),
		onResize: (cols, rows) => vm?.resize(cols, rows), // SIGWINCH
	});
	g.term = term;
	// init() instantiates wterm's parser (a small wasm module inside the package);
	// output written before then waits here. boot() waits for it before the kernel starts.
	let early: (string | Uint8Array)[] | null = [];
	const write = (data: string | Uint8Array) => { if (early) early.push(data); else term.write(data); };
	/**
	 * What the last load asked of this one: resume the suspended session,
	 * "hand" (the Resume button) or "auto" (a suspend in the background), or
	 * "fresh" (Reboot: boot fresh); null for a plain load, which resumes a
	 * session it can (offerResume()).
	 */
	const resumeRequest = takeResumeRequest();
	/** Resume without a question, also on another CPU count (offerResumeCpus()). */
	const resumeAsked = resumeAskedFor(resumeRequest);
	/**
	 * A quiet resume (every resume: after the Resume button, a suspend in the
	 * background, or on a plain load; autosuspend.ts quietStart()): the
	 * splash ("Resuming") stays over the terminal and the host's boot lines
	 * are held back (the Kernel log has them), so the first thing the
	 * terminal shows is the screen as it was (markRunning()). A plain load
	 * starts so until the saved session's meta says whether there is one to
	 * resume (boot()). A load that boots fresh or fails after all shows them
	 * (unquiet()).
	 */
	let quietResume = quietStart(resumeRequest, cfg.verbose);
	let held = "";
	const termReady = term.init().then(() => {
		termEl.querySelector("textarea")?.setAttribute("enterkeyhint", "enter");
		const q = early ?? [];
		early = null;
		for (const d of q) term.write(d);
		if (!cfg.mobile) term.focus();
	});
	// --- terminal windows (windows.ts) -------------------------------------------
	// Window 0 is this console; 1 to 9 are terminal sessions over vsock, opened
	// once user space runs (guestReady) and closed when the kernel stops.
	let guestUp = false, stopped = false;
	let readyResolve!: (vm: KernelHandle) => void, readyReject!: (e: Error) => void;
	const guestReady = new Promise<KernelHandle>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
	guestReady.catch(() => {});
	const checkReady = () => { if (guestUp && vm && !stopped) readyResolve(vm); };
	/** The kernel stopped or never started: no more windows. */
	const stopWindows = (why: string) => {
		stopped = true;
		readyReject(new Error(why));
		windows.closeAll();
	};
	const windows = createWindows({
		term0: term, send0: send, ready: () => guestReady, alive: () => !stopped && !ended() && ui.state() !== "error" && ui.state() !== "halted",
		autoFocus: !cfg.coarse,
	});
	KW.windows = windows;
	KW.ready = () => guestReady;
	// ?showcase: the scripted tour of the demos (launcher.ts).
	void guestReady.then(showcaseFromUrl, () => {});
	// Fresh apk indexes, fetched by the page over Wisp and pushed in once user space runs (apk.ts).
	if (cfg.net && alpine) void guestReady.then((vm) => prefetchApkIndexes(vm, { servers: cfg.wisp, log: (m) => ui.log(m, "h") }), () => {});
	// What the base booted (/run/kw-base: the image id, the upper layer), for the
	// Environment rows, About and diagnostics.
	void guestReady.then(showBase, () => {});
	KW.preview = { open: openPreview, close: closePreview, url: previewUrl };
	// Paste, the key bar, the touch controls and the shortcuts act on the current window.
	KW.term = {
		focus: () => windows.focus(),
		paste: (t) => windows.sendCurrent(pasteText(windows.currentTerm(), t)), // the panel's Paste
		send: (d) => windows.sendCurrent(d),
		appCursor: () => !!windows.currentTerm().bridge?.cursorKeysApp(),
		setFontSize: (px) => { setTermFont(termEl, px); windows.setFont(px); },
		notice: (m) => write(`\r\n\x1b[1;31m${m.replace(/\n/g, "\r\n")}\x1b[0m\r\n`), // the console's
	};
	KW.screenText = () => termText(term);
	if (!quietResume) ui.hideSplash(); // from here on the boot is shown on the terminal

	// --- host boot lines, systemd style -------------------------------------------
	// "[  OK  ] Downloaded ..." for each host step, and one transient line
	// (download progress, "Compiling") redrawn in place below them.
	let live = "";
	function hostLine(line: string) {
		if (quietResume) held += `${line}\r\n`;
		else write(`\r\x1b[K${line}\r\n${live}`);
	}
	/** A quiet resume that boots fresh or fails after all: show the boot as usual from here on. */
	function unquiet() {
		if (!quietResume) return;
		quietResume = false;
		ui.hideSplash();
		write(held + live);
		held = "";
	}
	const took = (ms: number | null | undefined) => (ms != null ? ` ${SGR.dim}(${fmtS(ms)})${SGR.off}` : "");
	const okLine = (msg: string, ms?: number | null) => `[${SGR.ok}  OK  ${SGR.off}] ${msg}${took(ms)}`;
	function status(t: string, color: string, msg: string, ms?: number | null) {
		if (ui.state() === "error") return; // e.g. a parallel download finishing after a failure
		hostLine(`[${color}${t}${SGR.off}] ${msg}${took(ms)}`);
		ui.hostLog(`[boot] ${t.trim()} ${msg}${ms != null ? ` (${fmtS(ms)})` : ""}`);
	}
	function ok(msg: string, ms?: number | null) { status("  OK  ", SGR.ok, msg, ms); }
	function warn(msg: string, ms?: number | null) { status(" WARN ", SGR.warn, msg, ms); }
	function failed(msg: string) { setLive(null); status("FAILED", SGR.fail, msg); }
	/**
	 * Show (or with null, remove) the transient line: tag (6 characters), msg,
	 * then detail in gray. It is cut to the terminal's width, so it never wraps.
	 */
	function setLive(t: string | null, msg = "", detail = "") {
		if (!t && !live) return;
		if (!t) { live = ""; if (!quietResume) write("\r\x1b[K"); return; }
		const max = Math.max(1, term.cols - 9);
		let a = ` ${msg}`, b = detail ? ` ${detail}` : "";
		if (a.length >= max) { a = `${a.slice(0, max - 1)}…`; b = ""; }
		else if (a.length + b.length > max) b = `${b.slice(0, max - 1 - a.length)}…`;
		live = `[${SGR.busy}${t}${SGR.off}]${a}${b && `${SGR.gray}${b}${SGR.off}`}`;
		if (!quietResume) write(`\r\x1b[K${live}`);
	}
	hostLine(`${SGR.bold}unkernel${SGR.off} ${SGR.dim}· Linux on WebAssembly${SGR.off}\r\n`);
	ok("Checked browser features", ui.stageTime("preflight"));

	// --- console output ------------------------------------------------------------
	// The SDK's ConsoleRouter splits the console into kernel lines and user
	// output. Every kernel line goes to the Kernel log tab. Boot phase: the
	// newest kernel line shows, in gray, after "Starting Linux" on the transient
	// line (cut to the terminal's width); IMPORTANT ones (warning, oops,
	// panic, ...) are written in full, and so is every kernel line after the
	// first of those, for its context. When user space prints its first line
	// (or a prompt), "Started Linux" replaces the transient line, followed by a
	// timing summary and the user-space output so far (buffered until then).
	// From then on only IMPORTANT kernel lines reach the terminal.
	// ?verbose=1 stays in the boot phase and writes every kernel line, in gray.
	let sawOutput = false, running = false, loud = false;
	let phase: "boot" | "user" = "boot";
	let replay = ""; // user-space output during the boot phase, redrawn below the summary
	// Each step already shows its own time: the summary is the total from page load.
	const summary = () => `${SGR.dim}Booted in${SGR.off} ${SGR.bold}${fmtS(Date.now() - KW.t0)}${SGR.off}` +
		(smp ? ` ${SGR.dim}on ${cfg.cpus} CPUs${SGR.off}` : cfg.worker ? ` ${SGR.dim}in a Web Worker${SGR.off}` : "") + "\r\n";
	// Two lines under the summary of a fresh boot: the source (an OSC 8 link,
	// which wterm opens on Ctrl/⌘-click) and how to open the demo launcher.
	const link = (url: string, text: string) => `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
	const notes = () => [`${SGR.dim}Source${SGR.off}  ${link(REPO, REPO.replace(/^https:\/\//, ""))}`,
		`${SGR.dim}Demos${SGR.off}   ${cfg.coarse ? "tap ❯ in the status line" : `press ${SGR.bold}${APPLE ? "⌘ K" : `${CHORD}-O`}${SGR.off}`}`];
	// Pip, glimmer's seed and the logo (assets/logo.svg), left of the summary
	// and the notes; left out where the lines would wrap.
	const PIP_W = PIP.width + 2; // with the gap before the text
	const visible = (s: string) => s.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "").replace(/\x1b\[[0-9;]*m/g, "").length;
	const intro = () => {
		const lines = [summary().replace(/\r\n$/, ""), ...notes()];
		if (term.cols < PIP_W + Math.max(...lines.map(visible)) + 1) return lines.join("\r\n") + "\r\n";
		return ["", ...lines].map((s, i) => `${PIP[i]}  ${s}`).join("\r\n") + "\r\n";
	};
	// The command line is shown only when it is not the default one.
	const cmdlineNote = () => (cfg.cmdlineGiven ? `: ${SGR.dim}${cfg.cmdline}${SGR.off}` : "");
	let replayTimer: ReturnType<typeof setTimeout> | undefined;
	/** Set when the kernel resumed a suspended session: what markRunning says instead of "Started Linux", and the old screen. */
	let resumed: { note: string; saved: number; screen?: string; preview?: SessionMeta["preview"]; windows?: SessionMeta["windows"]; win?: number } | null = null;
	function markRunning(why: string) {
		if (running) return;
		running = true;
		guestUp = true;
		checkReady();
		clearTimeout(replayTimer);
		if (ui.state() === "error") {
			unquiet();
			if (phase === "boot" && !cfg.verbose) { phase = "user"; setLive(null); write(replay); replay = ""; }
			return;
		}
		ui.stage("boot", "done");
		ui.stage("userspace", "done", why);
		ui.setState("running");
		if (phase === "boot" && !cfg.verbose) {
			phase = "user";
			setLive(null); // "Starting Linux", replaced by its result
			if (resumed) {
				// Quiet: only the screen as it was, then the splash goes (the toast says it: sayResumed()).
				// Else (the boot lines showed after all: a plain load whose session took long to read) a line too.
				if (quietResume) { quietResume = false; held = ""; ui.hideSplash(); }
				else write(okLine(resumed.note) + "\r\n\r\n" + summary() + "\r\n");
				if (resumed.screen?.length) write(resumed.screen); // the console as it was (the guest does not redraw it)
				write(replay);
			} else {
				unquiet(); // not the resume asked for (a fresh boot): its lines after all
				// Two steps: the kernel until it runs /init, then the base mounting the
				// distro image (its first blocks come over HTTP) and the distro's init.
				const user = cfg.distro ? cfg.guest[0]!.toUpperCase() + cfg.guest.slice(1) : "the base shell";
				write(okLine(`Started Linux${cmdlineNote()}`, ui.stageTime("boot")) + "\r\n" +
					okLine(`Started ${user}`, ui.stageTime("userspace")) + "\r\n\r\n" + intro() + "\r\n" + replay);
			}
			replay = "";
		}
		auto.update(); // a tab hidden while it booted
	}
	/** What the console showed of the guest, saved by Suspend (session.ts). */
	const screenTail = new ScreenTail();
	/** Text the terminal shows once user space runs (kept for the redraw until then). */
	function show(t: string) {
		screenTail.push(t);
		if (phase === "user") write(t);
		else if (!cfg.verbose && (replay += t).length > 65536) replay = replay.slice(-49152);
	}
	const KSTAMP_RE = /^\[ *\d+\.\d+\] */;
	// The base's check of the root with the data disk's changes failed, so this boot
	// runs the plain image (safe mode), or it found no distro to boot and started its
	// base shell (guest/base/initramfs/init).
	let userTail = "", safeSeen = false, baseSeen = false;
	const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").trim();
	function watchUser(t: string) {
		if (safeSeen && baseSeen) return;
		userTail = (userTail + t).slice(-2048);
		const rs = baseSeen ? null : /unkernel base shell \([^)\r\n]*\): ([^\r\n]*)\r?\n/.exec(userTail);
		if (rs) {
			baseSeen = true;
			const reason = plain(rs[1]!);
			ui.hostLog(`[host] the base started its base shell: ${reason}`);
			ui.baseShell(reason);
		}
		const m = safeSeen ? null : /kw-overlay: SAFE MODE: ([^\r\n]*)\r?\n/.exec(userTail);
		if (!m) return;
		safeSeen = true;
		const reason = plain(m[1]!);
		ui.hostLog(`[host] the guest booted in safe mode: ${reason}`);
		ui.safeMode(reason);
	}
	/** A whole line during the boot phase, above the transient line. */
	const bootLine = (s: string) => { if (quietResume) held += s; else write(live ? `\r\x1b[K${s}${live}` : s); };
	const router = new ConsoleRouter({
		onKernelLine(line, info) {
			ui.log(line);
			if (/Run \S+ as init process/.test(line)) {
				ui.stage("boot", "done");
				ui.stage("userspace", "active", line.replace(KSTAMP_RE, "").trim());
			}
			if (phase === "boot") {
				if (info.important) {
					loud = true;
					bootLine(info.raw);
				} else if (cfg.verbose || loud) bootLine(`${SGR.gray}${line}${SGR.off}\r\n`);
				else setLive(" .... ", "Starting Linux", line.replace(KSTAMP_RE, ""));
			} else if (info.important) show(info.raw);
		},
		onUserOutput(t) {
			watchUser(t);
			if (cfg.verbose) { setLive(null); screenTail.push(t); write(t); return; }
			// Boot phase: drawn once, below the summary (markRunning). The router marks
			// user space on a whole line or a prompt; anything else shows after 300 ms.
			show(t);
			if (phase === "boot") replayTimer ??= setTimeout(() => markRunning("first output"), 300);
		},
		onUserspace(why) {
			if (why.startsWith("first output: ")) ui.log(why.slice(14));
			markRunning(why);
		},
	});
	function consoleWrite(bytes: Uint8Array) {
		sawOutput = true;
		router.write(bytes);
	}

	// --- download (the SDK's loader reports it) -----------------------------------
	let t0Download = 0, liveT = 0;
	function onDownload(d: DownloadProgress) {
		if (!t0Download) {
			t0Download = performance.now();
			ui.stage("kernel", "active", d.url);
		}
		if (d.done) {
			const ms = performance.now() - t0Download;
			const rate = `${(d.loaded / 1048576 / Math.max(ms / 1000, 0.001)).toFixed(1)} MiB/s`;
			ui.stage("kernel", "done", `${d.url} · ${fmtMiB(d.loaded)} · ${rate}`);
			ok(`Downloaded ${smp ? "unkernel-smp.wasm" : "unkernel.wasm"}, ${fmtMiB(d.loaded)}`, ms);
			// The kernel compiles while it downloads (compileStreaming); what is left shows as the compile step.
			ui.stage("compile", "active");
			ui.setState("booting", "Compiling");
			setLive(" .... ", `Compiling the kernel (${fmtMiB(d.loaded)} of WebAssembly)`);
		} else if (performance.now() - liveT >= 100) {
			liveT = performance.now();
			setLive(" .... ", `Downloading the kernel, ${fmtMiB(d.loaded)}`);
		}
	}

	// --- test hooks: fake an allocation failure --------------------------------
	if (cfg.simulate.includes("oom") || cfg.simulate.includes("lowmem")) {
		const Real = WebAssembly.Memory;
		const limitPages = cfg.simulate.includes("oom") ? 0 : 2048; // lowmem: nothing above 128 MiB
		const Fake = function Memory(desc: WebAssembly.MemoryDescriptor) {
			if (Number(desc?.initial) > limitPages)
				throw new RangeError(`WebAssembly.Memory(): could not allocate memory (simulated by ?simulate=${cfg.simulate.join(",")})`);
			return new Real(desc);
		} as unknown as typeof WebAssembly.Memory;
		Fake.prototype = Real.prototype;
		WebAssembly.Memory = Fake;
	}

	// --- the suspended session (session.ts) ------------------------------------------
	/**
	 * kwshm, for the Wayland desktop (wayland.ts): on unless ?shm=0, and for the
	 * resume of a session the session's (adoptSessionGl()), since a restore
	 * needs the snapshot's devices.
	 */
	let shm = cfg.shm;
	let shmOwn: boolean | null = null;
	const sessionDevices = (): SessionDevices => ({ display: cfg.display, sound: cfg.sound, net: cfg.net, data: cfg.data, gl: cfg.gl, gpu: cfg.gpu, shm });
	/**
	 * The devices a suspended session is matched against: this load's, except
	 * that guest GL and its virtio-gpu device follow the session's (it resumes
	 * with its own; adoptSessionGl()) unless this load's URL names ?gl= or
	 * ?gpu=, or the session had GL and this load cannot (no WebGL2, no
	 * renderer, another distro: the distro is matched anyway). So a session
	 * saved before GL was on by default (no gl, no gpu) still resumes, as it
	 * was; a fresh boot uses the options. kwshm always follows the session's.
	 */
	const sessionDevicesFor = (m: SessionMeta): SessionDevices => {
		const d = { ...sessionDevices(), shm: !!m.devices.shm };
		if (cfg.glFromUrl) return d;
		const gl = !!m.devices.gl, gpu = !!m.devices.gpu;
		if (gl && (cfg.glBlocked || !GL_DISTROS.includes(cfg.guest))) return d;
		return { ...d, gl, gpu };
	};
	/** This load's own GL devices, while a resume runs with the session's (a failed resume boots fresh with these). */
	let glOwn: { gl: boolean; gpu: boolean; why: string | null } | null = null;
	/** Resume `m` with its own guest GL devices and kwshm (sessionDevicesFor()). */
	const adoptSessionGl = (m: SessionMeta) => {
		const d = sessionDevicesFor(m);
		if (!!d.shm !== shm) {
			shmOwn = shm;
			shm = !!d.shm;
			ui.hostLog(`[host] suspended session: resumed ${shm ? "with" : "without"} kwshm (the Wayland desktop), as it was saved; a fresh boot ${cfg.shm ? "has" : "has not"} it`);
		}
		if (!!d.gl === cfg.gl && !!d.gpu === cfg.gpu) return;
		glOwn = { gl: cfg.gl, gpu: cfg.gpu, why: cfg.glWhy };
		cfg.gl = !!d.gl;
		cfg.gpu = !!d.gpu;
		cfg.glWhy = cfg.gl ? null : "the resumed session was saved without it; a fresh boot (Reboot) has it";
		ui.hostLog(`[host] suspended session: resumed with guest GL ${cfg.gl ? `on${cfg.gpu ? "" : ", without virtio-gpu"}` : "off"}, as it was saved; a fresh boot uses the options`);
	};
	/** The resume failed: the fresh boot gets this load's own GL devices (its command line has them). */
	const dropSessionGl = () => {
		if (shmOwn !== null) {
			shm = shmOwn;
			shmOwn = null;
		}
		if (!glOwn) return;
		cfg.gl = glOwn.gl;
		cfg.gpu = glOwn.gpu;
		cfg.glWhy = glOwn.why;
		glOwn = null;
	};
	const ago = (t: number) => {
		const m = Math.round((Date.now() - t) / 60000);
		return m < 1 ? "just now" : m < 120 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
	};
	/**
	 * Resume the saved session, if this page can: the same kernel and CPU
	 * count (another count: offerResumeCpus(), before), the same devices and
	 * (inline, where the data disk is open here) the data disk unchanged
	 * since; in worker mode the worker checks the disk, and a refusal falls
	 * back to a fresh boot. A plain load resumes it without a question (as
	 * every resume, it ends in sayResumed()'s toast); the load after Reboot boots
	 * fresh, keeping it without a data disk and asking with one
	 * (resumeChoice()). null: boot fresh.
	 */
	async function offerResume(info: Promise<SessionMeta | null>, disks: BlockDevice[] | DiskSpec[]): Promise<{ snap: KernelSnapshot; meta: SessionMeta } | null> {
		let meta: SessionMeta | null;
		try {
			meta = await info;
		} catch (e) {
			ui.hostLog(`[host] suspended session: cannot read it: ${(e as Error)?.message ?? e}`);
			return null;
		}
		if (!meta || sessionCpus(meta) !== cfg.cpus) return null;
		const label = `saved ${ago(meta.saved)}, ${fmtMiB(meta.bytes)}`;
		// Inline: the disks as the snapshot lists them, the distro image first.
		const inlineDisks = !cfg.worker ? [...(distroDisk ? [distroDisk] : []), ...disks as BlockDevice[]] : null;
		// A data disk that changed since can never resume it: forget it then.
		const stale = inlineDisks ? snapshotDiskMismatch(meta.disks, inlineDisks)
			: cfg.data && meta.devices.data && data?.lock && !data.lock.held ? "the data disk is open in another tab" : null;
		const why = sessionMismatch(meta, kernelUrl, sessionDevicesFor(meta), distroRef) ?? stale;
		if (why) {
			ui.check("session", "Suspended session", "info", `${label}; not resumed`, why);
			ui.hostLog(`[host] suspended session (${label}) not offered: ${why}`);
			if (stale && !/another tab/.test(stale)) await clearSession().catch(() => {});
			return null;
		}
		const choice = resumeChoice(resumeRequest, meta.devices.data);
		if (choice === "keep") {
			// After Reboot, without a data disk: nothing changes it, so it stays for the next load.
			ui.hostLog(`[host] suspended session (${label}): booting fresh after Reboot; it is kept, and the next load resumes it`);
			ui.check("session", "Suspended session", "info", `${label}; kept`, "booted fresh after Reboot; the next load resumes it");
			return null;
		}
		const on = smp ? `, ${cpusText(cfg.cpus)}` : "";
		if (choice === "ask" && !await ui.ask({ title: "resume", msg: `Resume the session suspended ${ago(meta.saved)} (${fmtMiB(meta.bytes)}, ${meta.memoryMiB} MiB of memory${on})? Boot fresh discards it: a fresh boot changes the data disk.`, ok: "Resume", cancel: "Boot fresh" })) {
			ui.hostLog(`[host] suspended session (${label}): booting fresh instead, discarded`);
			await clearSession().catch(() => {});
			return null;
		}
		try {
			const snap = await loadSession();
			adoptSessionGl(meta);
			return { snap, meta };
		} catch (e) {
			warn(`Could not read the suspended session: ${(e as Error)?.message ?? e}`);
			await clearSession().catch(() => {});
			return null;
		}
	}
	/**
	 * The preview panel open at the suspend, opened again on the resumed
	 * machine once its port answers: the guest's server and its listening
	 * socket are in the snapshot, while the old page's connections were reset
	 * and the reload gave this kernel a new vmId (preview.ts), so the old
	 * iframe could not have been kept.
	 */
	function reopenPreview(handle: KernelHandle, p: SessionMeta["preview"]) {
		if (!p || !previewSupported() || ui$().get().preview) return;
		waitPort(handle, p.port, 15000).then(() => {
			if (ended() || ui$().get().preview) return;
			openPreview(p.port, p.path ?? "/");
			ui$().set((st) => (st.preview ? { preview: { ...st.preview, shown: p.shown, fill: p.fill } } : {}));
			ui.hostLog(`[host] preview: port ${p.port} opened again after the resume`);
		}, (e: Error) => {
			ui.hostLog(`[host] preview: not opened again (${e.message})`);
			ui.toast(`The preview's port ${p.port} did not answer after the resume: Ctrl-A p opens it again`);
		});
	}
	/**
	 * A snapshot the SDK refused, in words the user can act on where the
	 * cause is known: a program holding the virtio-gpu device (guest GL: a GL
	 * program's contexts and resources live in this page's WebGL2, which a
	 * session cannot save; a KMS client's buffers), "virtio-gpu resources,
	 * contexts or commands in flight" (js.md, virtio and virtio-gpu).
	 */
	function refusal(e: unknown): unknown {
		const m = (e as Error)?.message ?? "";
		if (!/virtio-gpu (resources|contexts|commands)/.test(m)) return e;
		return new Error("a program is using the GPU (/dev/dri: a GL program, or a KMS client such as X, kmscube or glmark2), whose state lives in this page (its WebGL2 context and buffers) and cannot be saved in a session. Quit it and suspend again", { cause: e });
	}
	/** A record a given-up save left behind (its removal failed): this machine's, so a later suspend may replace it. */
	let strandedSaved: number | null = null;
	/** The Suspend in progress: settles with null once saved, or why it failed (the exit waits for it). */
	let suspending: Promise<string | null> | null = null;
	/** The size of the session the last Suspend saved (the Resume card says it). */
	let suspendedBytes = 0;
	/**
	 * How long the session's write may take while the kernel waits at its
	 * snapshot point (awake time: a page frozen in the background does not
	 * use it up); past it the machine runs on and the write is aborted.
	 */
	const SUSPEND_COMMIT_MS = 20000;
	/**
	 * A suspend in the background that holds the machine (snapshot({ commit,
	 * hold })): its session is saved (`saved`: SessionMeta.saved) and the
	 * kernel waits at its snapshot point until `decide` says "continue" (the
	 * tab shown again: continueHeld()) or "stop" (stopHeld()). `lost`: the
	 * kernel ended meanwhile (its worker died, the page stopped it).
	 */
	let holdState: { saved: number; since: number; bytes: number; decide: (how: SnapshotHoldDecision) => void; lost: boolean } | null = null;
	/**
	 * Suspend: save the running machine in this browser and stop it
	 * (session.ts); the next load resumes it, on as many CPUs. The
	 * kernel waits at its snapshot point while the session is written
	 * (snapshot({ commit })) and stops only once that transaction committed;
	 * if it does not, the machine runs on (SuspendSaveError) and the saved
	 * session stays as it was. `hold` (a suspend in the background): once
	 * saved, the kernel stays held there instead of stopping, and this
	 * resolves with `held` (continueHeld() and stopHeld() end the hold);
	 * kw-resume is set as soon as the session is stored, so a page the
	 * browser kills meanwhile resumes it on its next load. Asked for while
	 * held, Suspend turns the hold into the stop.
	 */
	KW.suspend = async ({ hold = false } = {}) => {
		if (holdState) {
			const h = holdState;
			await stopHeld();
			return { bytes: h.bytes, ms: 0 };
		}
		if (!vm || ended() || !running) throw new Error("the system is not running");
		if (suspending) throw new Error("a suspend is in progress");
		if (typeof indexedDB === "undefined") throw new Error("this browser has no IndexedDB to keep the session in");
		// The SMP kernel on one CPU (the worker could not start their threads): no load would boot that again.
		if (smp && vm.stats().cpus !== cfg.cpus) throw new Error(`the SMP kernel runs on ${vm.stats().cpus} of ${cfg.cpus} CPUs here (their threads did not start); set CPUs to 1 under Options to suspend`);
		const t0 = performance.now();
		const target = vm;
		ui.setState("running", "Suspending");
		let tSnap = 0, tStored = 0, bytes = 0, saved = 0, wrote = false;
		let nowHeld!: () => void;
		const holding = new Promise<void>((r) => { nowHeld = r; });
		const p = target.snapshot({
			commitTimeoutMs: SUSPEND_COMMIT_MS,
			commit: async (snap, signal) => {
				tSnap = performance.now() - t0;
				saved = Date.now();
				bytes = await saveSession(snap, {
					saved, kernelUrl, devices: sessionDevices(), screen: screenTail.text(), worker: cfg.worker, distro: distroRef, preview: ui$().get().preview,
					windows: windows.saved(snap.ttys ?? []), win: ui$().get().win, // the windows' sessions, detached by the restore (windows.ts)
				}, signal);
				wrote = true;
				tStored = performance.now() - t0;
				// Committed only after the snapshot was given up (the timeout): the machine runs on past it.
				if (signal.aborted) {
					await clearSession(saved).catch(() => { strandedSaved = saved; });
					throw signal.reason;
				}
				// Stored: a page killed while held resumes it on its next load, quietly.
				if (hold) setResumeRequest(true);
			},
			...(hold ? {
				hold: (_snap: KernelSnapshot, signal: AbortSignal) => new Promise<SnapshotHoldDecision>((decide) => {
					const h = { saved, since: Date.now(), bytes, decide, lost: false };
					holdState = h;
					signal.addEventListener("abort", () => { h.lost = true; }, { once: true });
					ui.setState("running", "Paused"); // before the page may be frozen (the tab's title follows)
					nowHeld();
				}),
			} : {}),
		});
		suspending = p.then(() => null, (e: unknown) => (e as Error)?.message ?? String(e));
		try {
			const how = await Promise.race([p.then(() => "stopped" as const), holding.then(() => "held" as const)]);
			if (how === "held") {
				ui.hostLog(`[host] ${autoSuspending ? "suspended in the background" : "paused"}: ${fmtMiB(bytes)} saved in this browser (parked and copied in ${fmtS(tSnap)}, stored in ${fmtS(tStored - tSnap)}); held at its snapshot point ${autoSuspending ? "while the tab is hidden" : "until Continue"}`);
				return { bytes, ms: performance.now() - t0, held: true };
			}
			suspendedBytes = bytes;
			ui.hostLog(`[host] suspended${autoSuspending ? " in the background" : ""}: ${fmtMiB(bytes)} saved in this browser (parked and copied in ${fmtS(tSnap)}, stored in ${fmtS(tStored - tSnap)}, stopped after ${fmtS(performance.now() - t0)})`);
			return { bytes, ms: performance.now() - t0 };
		} catch (e) {
			// Written, but given up after all (the commit's timeout came first): the machine runs on past it, so it is not this machine's.
			if (wrote && e instanceof SnapshotCommitError) await clearSession(saved).catch(() => { strandedSaved = saved; });
			if (ended()) throw e;
			// Refused before the copy (a task did not park, I/O in flight), or not stored: it runs on.
			suspending = null;
			ui.setState("running", "Running");
			if (!(e instanceof SnapshotCommitError)) throw refusal(e);
			const why = ((e.cause as Error | undefined)?.message ?? /not committed \((.*)\);/.exec(e.message)?.[1] ?? e.message).replace(/^snapshot: /, "");
			ui.hostLog(`[host] suspend: the session was not saved (${why}) after ${fmtS(performance.now() - t0)}; the system runs on`);
			throw new SuspendSaveError(`the session was not saved (${why}); the system runs on`);
		}
	};
	/**
	 * The tab is shown again while held: the machine goes on where it was
	 * (no reload: terminal windows, connections to the guest and the preview
	 * as they were), and its saved session is deleted, since the guest writes
	 * its disks again. kw-resume is cleared first, in the same task as the
	 * release, so a later reload does not resume that session; the record
	 * goes after the release (a page killed in between leaves a stale record,
	 * which the next load resumes as a plain load does, with its toast, and
	 * refuses once the data disk changed, as a record a given-up save could
	 * not delete). False if the
	 * machine is gone: its saved session resumes instead.
	 */
	async function continueHeld(byHand = false): Promise<boolean> {
		const h = holdState;
		if (!h || h.lost || ended()) return false;
		clearResumeRequest();
		h.decide("continue");
		await suspending; // settles once it went on (or the kernel ended)
		if (h.lost || ended()) { setResumeRequest(true); return false; }
		holdState = null;
		suspending = null;
		ui.setState("running", "Running");
		const sec = Math.round((Date.now() - h.since) / 1000);
		const was = sec < 120 ? `${sec} s` : sec < 7200 ? `${Math.round(sec / 60)} min` : `${Math.round(sec / 3600)} h`;
		if (byHand) ui.hostLog(`[host] paused for ${was}, continued; its saved session is deleted`);
		else {
			ui.hostLog(`[host] auto-suspend: held in the background for ${was}, continued; its saved session is deleted`);
			ui.check("autosuspend", "Suspend in the background", "pass", `held for ${was}, continued ${new Date().toLocaleTimeString()}`, "the machine went on where it was; the session saved for it was deleted");
		}
		strandedSaved = h.saved; // this machine's own until it is gone
		void clearSession(h.saved).then(() => { if (strandedSaved === h.saved) strandedSaved = null; },
			(e: unknown) => ui.hostLog(`[host] ${byHand ? "pause" : "auto-suspend"}: deleting the held session failed (${(e as Error)?.message ?? e}); a later suspend replaces it`));
		return true;
	}
	/** The hold becomes the stop (its session stays saved; the exit then shows it suspended). */
	async function stopHeld(): Promise<void> {
		const h = holdState;
		if (!h) return;
		h.decide("stop");
		await suspending;
	}

	// --- suspend in the background, and the question on leaving (autosuspend.ts) ------------
	/**
	 * The user has used this machine (typed, tapped or clicked outside the
	 * page's chrome: the dialog, the status line, the question) since it
	 * booted, or it is a resumed session: worth suspending or asking about.
	 */
	let interacted = false;
	const used = (e: Event) => {
		if (interacted || !e.isTrusted) return;
		if ((e.target as Element | null)?.closest?.("#panel, #scrim, #bar, #confirm")) return;
		interacted = true;
	};
	for (const ev of ["keydown", "pointerdown", "input", "paste"]) addEventListener(ev, used, { capture: true, passive: true });
	/** The resumed session's time (SessionMeta.saved): a session still saved as that one is this machine's, not one kept from before (Reboot keeps one without a data disk). */
	let resumedSaved: number | null = null;
	/** The suspend running now was started by AutoSuspend. */
	let autoSuspending = false;
	const facts = (): SuspendFacts => ({
		running: running && !!vm && !ended() && ui.state() === "running" && !suspending,
		suspending: !!suspending && !ended(),
		held: !!holdState && !ended(),
		interacted, hidden: document.visibilityState === "hidden",
	});
	const autoWhat = cfg.autosuspend === null ? "off" : `${autoSuspendLabel(cfg.autosuspendParam).toLowerCase()} when the tab is hidden`;
	ui.check("autosuspend", "Suspend in the background", "info", autoWhat,
		cfg.autosuspend === null ? "Options, Suspend in the background" : "a system used since it booted; it resumes when the tab is shown");
	/** Not suspended while hidden: said once the tab is shown. */
	let autoNote: string | null = null;
	const auto = new AutoSuspend({
		delayS: cfg.autosuspend,
		facts,
		async suspend() {
			// What KW.suspend() refuses for good (it says why when used by hand).
			if (typeof indexedDB === "undefined") throw new AutoSuspendSkip("this browser has no IndexedDB to keep the session in");
			if (smp && vm && vm.stats().cpus !== cfg.cpus) throw new AutoSuspendSkip(`the SMP kernel runs on ${vm.stats().cpus} of ${cfg.cpus} CPUs here`);
			// Both at once: a hidden page may have only seconds to run.
			const [kept, est] = await Promise.all([sessionInfo().catch(() => null), navigator.storage?.estimate?.().catch(() => undefined)]);
			// A session kept from before (the load after Reboot keeps one) would be replaced: only Suspend by hand does that.
			// Not this machine's own record (resumed from, or left by a save given up whose removal failed).
			if (kept && kept.saved !== resumedSaved && kept.saved !== strandedSaved)
				throw new AutoSuspendSkip(`the session suspended ${ago(kept.saved)} is kept, and this would replace it (Suspend by hand to replace it)`);
			// A save that cannot fit would only fail (the machine runs on), after parking it and writing for nothing.
			const room = sessionRoom(cfg.cpus);
			if (est?.quota && est.usage !== undefined && est.quota - est.usage < room)
				throw new AutoSuspendSkip(`the browser's storage has ${fmtMiB(est.quota - est.usage)} free, less than the ${fmtMiB(room)} a suspended session may need`);
			if (document.visibilityState !== "hidden") throw new AutoSuspendSkip("the tab is shown again", true);
			autoSuspending = true;
			let r: Awaited<ReturnType<NonNullable<typeof KW.suspend>>>;
			try {
				r = await KW.suspend!({ hold: true });
			} finally {
				autoSuspending = false;
			}
			setResumeRequest(true); // a reload after the browser discarded the tab resumes it quietly
			ui.check("autosuspend", "Suspend in the background", "pass", `${r.held ? "saved and held" : "suspended"} ${new Date().toLocaleTimeString()}`,
				r.held ? "it goes on when the tab is shown (if the browser discards the page meanwhile, the next load resumes it)" : "it resumes when the tab is shown");
			return r.held ? "held" : "stopped";
		},
		continue: () => continueHeld(),
		stopHeld,
		holdMs: AUTO_SUSPEND_HOLD_MS,
		resume: () => {
			ui.toast("Resuming…");
			ui.resumeAuto(); // the load restores the screen quietly
		},
		log: (m) => ui.hostLog(`[host] auto-suspend: ${m}`),
		failed: (m) => {
			ui.check("autosuspend", "Suspend in the background", "warn", "not suspended", m);
			if (document.visibilityState === "hidden") {
				autoNote = m;
				void KW.sync!().then(dataStatus); // what hiding the tab does otherwise
			} else ui.toast(m);
		},
		setTimeout: (fn, ms) => setTimeout(fn, ms),
		clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
	});
	/** The resumed session's time while the tab is hidden: its toast shows once the tab is shown, once. */
	let resumedPending: number | null = null;
	/**
	 * Every resume of a saved session (a reload: the Resume button, a plain
	 * load, after a suspend in the background, on another CPU count) says so
	 * the same way, once the machine is back: this toast (informational: Reboot
	 * is the way to a fresh boot). A hidden tab gets it when shown.
	 */
	function sayResumed(saved: number) {
		if (document.visibilityState === "hidden") { resumedPending = saved; return; }
		resumedPending = null;
		ui.toast(resumedNote(ago(saved)), { ms: RESUMED_TOAST_MS });
	}
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState !== "visible") return;
		const note = autoNote;
		autoNote = null;
		if (resumedPending !== null) {
			sayResumed(resumedPending);
			// A note from the background too (rare): after the resume's toast, not over it.
			if (note) setTimeout(() => ui.toast(note), RESUMED_TOAST_MS);
		} else if (note) ui.toast(note);
	});
	// Pause by hand (autosuspend.ts Pause): the same save and hold, with the tab shown, until Continue
	// (the notice's button, or a key for the guest); visibilitychange does not end it.
	const pause = new Pause({
		async suspend() {
			const r = await KW.suspend!({ hold: true }); // kw-resume "auto" once stored: a closed tab resumes it quietly
			return r.held ? "held" : "stopped";
		},
		continue: () => continueHeld(true),
		stopHeld,
		holdMs: AUTO_SUSPEND_HOLD_MS,
		notice: (on) => ui.setPaused(on),
		log: (m) => ui.hostLog(`[host] pause: ${m}`),
		failed: (m) => {
			const why = /^the session was not saved \((.*)\); the system runs on$/.exec(m)?.[1] ?? m.replace(/; the system runs on$/, "");
			ui.toast(`Not saved: ${why}; the system runs on`, { ms: 8000 });
		},
		setTimeout: (fn, ms) => setTimeout(fn, ms),
		clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
	});
	KW.pause = () => pause.pause();
	KW.continuePaused = () => pause.continue();
	/** The toast that offers Pause after the user stayed on the page, while it shows. */
	let offer: number | null = null;
	guestKey = () => {
		if (offer !== null) { ui.toastHide(offer); offer = null; }
		if (pause.state === "paused") pause.continue();
	};

	// The question on leaving (the browser's own text, after the user interacted; mostly not on phones).
	// Nothing can be saved from inside it, and a user who stays may simply go on working, so nothing
	// happens by itself: a small toast offers Pause (save and hold; the tab can then be closed).
	let leaveTimer: ReturnType<typeof setTimeout> | undefined;
	let leaveFocus: (() => void) | null = null;
	const leaveStop = () => {
		clearTimeout(leaveTimer);
		if (leaveFocus) removeEventListener("focus", leaveFocus);
		leaveFocus = null;
	};
	addEventListener("beforeunload", (e) => {
		if (!wantLeavePrompt(facts(), { enabled: cfg.askLeave, leaving: pageLeaving() })) return;
		e.preventDefault();
		e.returnValue = ""; // engines before the preventDefault() form
		leaveStop();
		// Timers wait while Chrome and Safari ask; Firefox asks from its parent process, so the page also
		// waits to have the focus back (the question has it). This runs once the user stayed (or, briefly,
		// while a navigation commits).
		leaveTimer = setTimeout(() => {
			const stayed = () => { leaveStop(); leaveStayed(); };
			if (document.hasFocus()) stayed();
			else { leaveFocus = stayed; addEventListener("focus", stayed); }
		}, LEAVE_STAYED_MS);
	});
	/** The user stayed on the page: offer Pause, for a moment; doing nothing keeps it running. */
	function leaveStayed() {
		if (!facts().running || pause.state !== "idle") return; // stopped, or a suspend already runs
		offer = ui.toast("Pause to save this session before closing?", {
			action: "Pause", ms: LEAVE_OFFER_MS,
			run: () => {
				offer = null;
				if (facts().running) pause.pause(); // else it stopped or a suspend runs meanwhile
				if (!cfg.coarse) KW.term?.focus();
			},
		});
	}
	// Left after all (or into the back-forward cache): nothing more to do.
	addEventListener("pagehide", leaveStop);

	// --- several CPUs: what falls back to one ---------------------------------------
	/**
	 * Reload this tab once on one CPU (config.ts reads UP_ONCE_KEY; ?cpus= stays
	 * in the URL, so the next Reboot tries again), optionally resuming the
	 * suspended session. False if sessionStorage refuses the note, which would
	 * make the reload try the same again: then the caller reports the failure.
	 */
	function bootUpOnce(reason: string, resume = false, inline = false): boolean {
		try {
			sessionStorage.setItem(inline ? INLINE_ONCE_KEY : UP_ONCE_KEY, reason);
		} catch {
			return false;
		}
		const what = inline ? "on the page's thread" : "on one CPU";
		ui.hostLog(`[host] booting ${what} instead: ${reason}`);
		KW.term?.notice(`[host] booting ${what} instead: ${reason}`);
		if (resume) { if (resumeRequest === "auto") ui.resumeAuto(); else ui.resume(); } // sets kw-resume and reloads
		else { allowLeave(); location.reload(); }
		return true;
	}
	const cpusText = (n: number) => `${n} CPU${n === 1 ? "" : "s"}`;
	/** The page's kernel for `n` CPUs (the SMP one is null without the bundle's patch). */
	const kernelFor = (n: number) => (n > 1 ? cfg.kernelSmpUrl : cfg.kernelUrl);
	/** Why this page cannot start `n` CPUs now, or null (config.ts: smpBlocker(), this tab's fallback to one CPU, the host's threads). */
	const cpusBlocker = (n: number): string | null => n < 2 ? null
		: cfg.smpBlocked ?? cfg.smpWhy ?? (n > cfg.cpuMax ? `this device reports ${cfg.cpuMax} CPU threads` : null);
	/** Reload this tab once on `n` CPUs (config.ts reads CPUS_ONCE_KEY) and resume the suspended session. False if sessionStorage refuses. */
	function resumeOnCpus(n: number, reason: string): boolean {
		try {
			sessionStorage.setItem(CPUS_ONCE_KEY, String(n));
		} catch {
			return false;
		}
		ui.hostLog(`[host] booting on ${n} CPUs instead: ${reason}`);
		// A quiet resume (its session was resumed on another count than the URL's) stays quiet.
		if (resumeRequest === "auto") { ui.resumeAuto(); return true; }
		KW.term?.notice(`[host] booting on ${n} CPUs instead: ${reason}`);
		ui.resume(); // sets kw-resume and reloads
		return true;
	}
	/** Do not boot: the suspended session stays, with its data disk as it was. Always true (the page stops here). */
	function keepSession(why: string): boolean {
		ui.hostLog(`[host] not booting: ${why}`);
		ui.check("session", "Suspended session", "warn", "kept; not booted", why);
		ui.setState("halted", "Not started");
		setLive(null);
		unquiet();
		void termReady.then(() => KW.term?.notice(`[host] not booted: ${why} — reload the page to be asked again`), () => {});
		return true;
	}
	/**
	 * A suspended session saved on another CPU count than this load's (a
	 * task resumes on the CPU it ran on, so it needs exactly its count;
	 * sessions from before SMP ones ran on one): offer to reload on that
	 * count, where this page can start it now. Where it cannot, this load
	 * boots its own count, and asks first if the session has a data disk:
	 * that boot changes the disk, which makes the session useless. True:
	 * the page reloads or stops here. Asked before the kernel is needed,
	 * since the answer picks it.
	 */
	async function offerResumeCpus(info: Promise<SessionMeta | null>): Promise<boolean> {
		let meta: SessionMeta | null;
		try {
			meta = await info;
		} catch (e) {
			ui.hostLog(`[host] suspended session: cannot read it: ${(e as Error)?.message ?? e}`);
			return false;
		}
		const n = meta ? sessionCpus(meta) : cfg.cpus;
		if (!meta || n === cfg.cpus) return false;
		const label = `saved ${ago(meta.saved)}, ${fmtMiB(meta.bytes)}, ${cpusText(n)}`;
		const why = sessionMismatch(meta, kernelFor(n), sessionDevicesFor(meta), distroRef) ??
			(cfg.data && meta.devices.data && data?.lock && !data.lock.held ? "the data disk is open in another tab" : null);
		if (why) {
			ui.check("session", "Suspended session", "info", `${label}; not resumed`, why);
			ui.hostLog(`[host] suspended session (${label}) not offered: ${why}`);
			return false;
		}
		const m = cfg.cpus;
		const blocked = cpusBlocker(n);
		if (blocked) {
			const msg = `the session suspended ${ago(meta.saved)} runs on ${cpusText(n)}, which this page cannot start now (${blocked})`;
			ui.check("session", "Suspended session", "warn", `${label}; not resumed`, msg);
			ui.hostLog(`[host] suspended session (${label}) not offered: ${msg}`);
			if (meta.devices.data) {
				if (!await ui.ask({ title: "resume", msg: `The session suspended ${ago(meta.saved)} runs on ${cpusText(n)}, which this page cannot start now (${blocked}). Booting on ${cpusText(m)} discards it: that boot changes the data disk.`, ok: `Boot on ${cpusText(m)}`, cancel: "Keep it" }))
					return keepSession(`the session suspended ${ago(meta.saved)} needs ${cpusText(n)} (${blocked})`);
				ui.hostLog(`[host] suspended session (${label}): booting on ${cpusText(m)} instead, discarded`);
				await clearSession().catch(() => {});
				return false;
			}
			warn(`Not resuming the session suspended ${ago(meta.saved)}: it runs on ${cpusText(n)}, which this page cannot start now (${blocked}); it is kept`);
			ui.toast(`Not resumed: the session needs ${cpusText(n)}`);
			return false;
		}
		const dataNote = meta.devices.data ? ` Booting on ${cpusText(m)} discards it: that boot changes the data disk.` : ` Booting on ${cpusText(m)} keeps it for later.`;
		if (!resumeAsked && !await ui.ask({ title: "resume", msg: `Resume the session suspended ${ago(meta.saved)} (${fmtMiB(meta.bytes)}, ${meta.memoryMiB} MiB of memory)? It resumes on ${cpusText(n)}, as it was saved.${dataNote}`, ok: `Resume on ${cpusText(n)}`, cancel: `Boot on ${cpusText(m)}` })) {
			ui.hostLog(`[host] suspended session (${label}): booting on ${cpusText(m)} instead`);
			ui.check("session", "Suspended session", "info", `${label}; not resumed`, `booted on ${cpusText(m)} instead${meta.devices.data ? " (discarded: the data disk changes)" : ""}`);
			if (meta.devices.data) await clearSession().catch(() => {});
			return false;
		}
		const reason = `resuming the session suspended ${ago(meta.saved)}, which runs on ${cpusText(n)}`;
		return (n === 1 ? bootUpOnce(reason, true) : resumeOnCpus(n, reason)) ||
			keepSession(`this browser refuses sessionStorage, which the reload on ${cpusText(n)} needs (set CPUs to ${n} under Options and Reboot to resume)`);
	}

	// --- the distro image and what the base made of it ---------------------------------
	/** The distro image's HttpBase counters (inline only: the worker reads it there). */
	const distroStats = () => (distroDisk?.inner as { base?: { stats?: { requests: number; bytes: number } } } | undefined)?.base?.stats;
	/** The image as the host read it (its superblock), as a boot line and the Distro row. */
	function showDistro(info: { fs: string; size: number; label: string; uuid: string }, ms: number | null) {
		if (!distro) return;
		ok(`Attached the ${distro.name[0]!.toUpperCase()}${distro.name.slice(1)} image (${fmtMiB(info.size)}, streamed)`, ms);
		ui.check("distro", "Distro", cfg.distroWhy ? "warn" : "pass", distro.name, `${cfg.distroWhy ? `${cfg.distroWhy}; ` : ""}${distro.url}: ${info.fs}, ${fmtMiB(info.size)}, label ${info.label}, uuid ${info.uuid}; read-only /dev/wda, read with Range requests as the guest needs it`);
		ui.hostLog(`[host] distro: ${distro.url} (${info.fs}, ${info.size} bytes, uuid ${info.uuid})${ms != null ? ` opened in ${fmtS(ms)}` : ""}`);
	}
	/** Once user space runs: /run/kw-base (guest/base/initramfs/init) says which image booted and where its changes go. */
	async function showBase(vm: KernelHandle) {
		try {
			// Shell builtins only: a program (cat) would be read from the distro image, over HTTP.
			const r = await vm.exec("/bin/sh", ["-c", 'while IFS= read -r l; do echo "$l"; done < /run/kw-base']);
			if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `exit ${r.exitCode}`);
			const kv: Record<string, string> = {};
			for (const l of r.stdout.split("\n")) if (l.includes("=")) kv[l.slice(0, l.indexOf("="))] = l.slice(l.indexOf("=") + 1);
			const st = distroStats();
			const reads = st ? `; ${st.requests} range requests, ${fmtMiB(st.bytes)} of the image read so far` : "";
			ui.hostLog(`[host] base: name=${kv.name ?? ""} image=${kv.image ?? ""} upper=${kv.upper ?? ""} why=${kv.why ?? ""}${reads}`);
			if (kv.upper === "none") return; // the base shell: watchUser() said why
			if (kv.image) ui.distroBooted(kv.image);
			if (distro) ui.check("distro", "Distro", cfg.distroWhy ? "warn" : "pass", kv.image || distro.name,
				`${cfg.distroWhy ? `${cfg.distroWhy}; ` : ""}${distro.url}${vm.distro ? `: ${vm.distro.fs}, ${fmtMiB(vm.distro.size)}` : ""}; read-only /dev/wda${reads}`);
			const why = kv.why ?? "";
			if (kv.upper === "data") ui.check("overlay", "Root", "pass", "overlay, changes on the data disk", `${kv.state}/upper over the ${kv.name} image`);
			else if (why === "kw.root=initramfs") ui.check("overlay", "Root", "warn", "safe mode (kw.root=initramfs)", `the plain ${kv.name} image; changes in memory, ${kv.state}/upper unused this boot`);
			else if (!why.startsWith("safe mode")) ui.check("overlay", "Root", "info", "overlay, changes in memory", why); // safe mode: watchUser() said why
		} catch (e) {
			ui.hostLog(`[host] /run/kw-base: ${(e as Error)?.message ?? e}`);
		}
	}

	/**
	 * Guest GL (on by default on Debian; ?gl=0): the Environment tab's "Guest
	 * GL" row. The renderer loads on the guest's first GL use (vm.gl.status,
	 * vm.gl.loaded), so until then the row says it is not loaded (or why it
	 * cannot be: no WebGL2 context when the SDK tried one before the boot);
	 * once loaded, the WebGL2 renderer the guest's Mesa draws on and how long
	 * the load took, also in the console and the Kernel log; a software
	 * renderer (SwiftShader, llvmpipe, WARP) is a warning, since GL is then no
	 * faster than the host's CPU. Then the bridges and clients served
	 * (vm.gl.stats), every 2 s while they change, and where a frame's time
	 * went in the renderer over the last 2 s with readbacks (glFrameTimes),
	 * and the device's counters (gpuFrames).
	 */
	function showGl(vm: KernelHandle) {
		if (!cfg.gl) {
			if (cfg.glWhy) ui.check("gl", "Guest GL", cfg.glAsked && !glOwn ? "warn" : "info", "off", cfg.glWhy);
			return;
		}
		const gl = vm.gl;
		if (!gl) {
			ui.check("gl", "Guest GL", "fail", "unavailable", "the SDK started no GL renderer (the Kernel log says why)");
			return;
		}
		const how = cfg.gpu
			? "virtio-gpu: Mesa uses /dev/dri with no variables (the vtest link: GALLIUM_DRIVER=virpipe LIBGL_ALWAYS_SOFTWARE=1 cmd; ?gpu=0 for its shells); Mesa: sudo apt-get install mesa-utils (eglinfo -B -p gbm), kmscube, glmark2-es2-drm ..."
			: "Guest shells have GALLIUM_DRIVER=virpipe LIBGL_ALWAYS_SOFTWARE=1 (no virtio-gpu: ?gpu=0 or ?display=0); Mesa: sudo apt-get install mesa-utils (eglinfo -B), glmark2-es2-x11 ...";
		const fallback = cfg.gpu ? "GL programs fall back to software rendering (llvmpipe), KMS with dumb buffers works" : "GL programs on the vtest link fail; without GALLIUM_DRIVER they use llvmpipe";
		ui.check("gl", "Guest GL", "info", "starting", "starting the guest's forwarder; the renderer (virgl.mjs, virgl.wasm) loads on the guest's first GL use");
		let webgl = "", soft = false, loadNote = "", linked = false, failed = false;
		let shown = "", times = "", prev: VirglTotals | undefined, prevAt = performance.now();
		let gpuTimes = "", gpuPrev: GpuRendererStats | undefined, gpuPrevAt = prevAt;
		const show = () => {
			if (failed) return;
			const st = gl.stats, s = gl.status, at = performance.now();
			if (st.renderer) {
				times = glFrameTimes(st.renderer, prev, at - prevAt) ?? times;
				prev = st.renderer;
				prevAt = at;
			}
			if (st.gpu) {
				gpuTimes = gpuFrames(st.gpu, gpuPrev, at - gpuPrevAt);
				gpuPrev = st.gpu;
				gpuPrevAt = at;
			}
			const now = `vtest: ${st.streams} forwarder link${st.streams === 1 ? "" : "s"}, ${st.clients} GL client${st.clients === 1 ? "" : "s"} now, ${st.opened} so far` +
				`${cfg.glStrictWaits ? "; busy waits answered as vtest does (?glwait=strict)" : ""}${times ? `. ${times}` : ""}${gpuTimes ? `. ${gpuTimes}` : ""}`;
			const key = `${s.state} ${now}`;
			if (key === shown) return;
			shown = key;
			const losses = s.losses ? `; the WebGL2 context was lost ${s.losses === 1 ? "once" : `${s.losses} times`} and a new renderer made ${s.renewals === 1 ? "once" : `${s.renewals} times`} (the GL programs running at a loss had to be restarted)` : "";
			if (s.state === "lost" || (s.state === "ready" && st.gpu?.contextLost))
				ui.check("gl", "Guest GL", "warn", "WebGL context lost", `the browser dropped the renderer's WebGL2 context (memory pressure, a GPU reset, the GPU process ended; ${s.losses} so far): ` +
					`every GL object of the guest went with it, so the GL programs that were running fail: restart them; the next GL program gets a new renderer, no page reload needed` +
					`${s.error ? ` (the last try failed: ${s.error})` : ""}. ${now}.`);
			else if (s.state === "ready") {
				const name = s.webgl ?? webgl;
				ui.check("gl", "Guest GL", soft ? "warn" : "pass", name, `WebGL2: ${name}${soft ? " (a software renderer: no GPU behind it)" : ""}; ${s.what}${cfg.gpu ? ", virtio-gpu 3D" : ""}; ${loadNote}${losses}. ${how} ${now}.`);
			} else if (s.state === "loading")
				ui.check("gl", "Guest GL", "info", "loading", `${s.losses ? "a GL program after the WebGL2 context was lost: making a new renderer" : "the guest's first GL use: loading the renderer (virgl.mjs, virgl.wasm, a WebGL2 context)"} for ${fmtS(at - (s.startedAt ?? at))}. ${how}`);
			else if (linked)
				ui.check("gl", "Guest GL", "info", "on, not loaded yet", `the renderer (virglrenderer in wasm, virgl.mjs and virgl.wasm, about 480 KB) is fetched and started on this browser's WebGL2 on the guest's first GL use (a program opening /dev/dri for 3D, or a vtest client), which waits for it; nothing of it was loaded at boot. ${how} ${now}.`);
		};
		let timer: ReturnType<typeof setInterval> | undefined;
		const tick = () => {
			if (ended()) clearInterval(timer);
			else show();
		};
		gl.ready.then(() => {
			linked = true;
			show();
			timer ??= setInterval(tick, 2000);
		}, (e: unknown) => {
			const why = (e as Error)?.message ?? String(e);
			failed = true;
			if (gl.status.state === "failed" && gl.status.startedAt === null) {
				// Known before the boot (no WebGL2 context): the device is 2D, nothing was tried.
				ui.check("gl", "Guest GL", cfg.glAsked ? "warn" : "info", "unavailable", `${why}. The guest has no GL renderer: ${cfg.gpu ? "its virtio-gpu device is 2D (KMS with dumb buffers), and " : ""}GL programs use software rendering (llvmpipe)`);
				if (cfg.glAsked) ui.toast(`Guest GL is unavailable: ${why}`);
				return;
			}
			ui.check("gl", "Guest GL", "fail", "failed", why);
			ui.toast(`Guest GL failed: ${why}`);
		});
		gl.loaded.then((what) => {
			const s = gl.status;
			webgl = s.webgl ?? what.slice(what.lastIndexOf("; ") + 2);
			soft = /SwiftShader|llvmpipe|softpipe|Software|Basic Render|WARP/i.test(webgl);
			loadNote = s.loadMs === null ? "loaded" : s.eager
				? `loaded before the boot in ${fmtS(s.loadMs)} (?glload=eager)`
				: `loaded in ${fmtS(s.loadMs)} on the guest's first GL use, ${fmtS(s.startedAt ?? 0)} after the page opened`;
			console.log(`[unkernel] guest GL: WebGL2 renderer ${webgl}${soft ? " (software rendering)" : ""}; ${loadNote}`);
			ui.hostLog(`[host] guest GL: renderer ${what}${soft ? " (software rendering)" : ""}; ${loadNote}`);
			if (soft) ui.toast(`Guest GL runs on a software WebGL renderer (${webgl}), not a GPU`);
			show();
			timer ??= setInterval(tick, 2000);
		}, (e: unknown) => {
			if (failed) return; // said above
			failed = true;
			const why = (e as Error)?.message ?? String(e);
			ui.check("gl", "Guest GL", "fail", "renderer failed", `the renderer did not load on the guest's first GL use: ${why}; ${fallback}`);
			ui.toast(`Guest GL: the renderer did not load (${why}); ${fallback}`, { ms: 8000 });
		});
	}

	/**
	 * The virtio-gpu device's 3D counters (vm.gl.stats.gpu; js.md, virtio-gpu
	 * 3D): presented frames (RESOURCE_FLUSH of the scanout, which Display.tsx
	 * draws from the renderer's texture), fenced commands that waited for the
	 * GPU (parks: by default only behind a presented frame), readbacks and
	 * refused commands, over the last MS and in all.
	 */
	function gpuFrames(g: GpuRendererStats, p: GpuRendererStats | undefined, ms: number): string {
		type Counter = Exclude<keyof GpuRendererStats, "lastError" | "contextLost">;
		const d = (k: Counter) => g[k] - (p?.[k] ?? 0);
		const rate = p && ms > 0 && (d("presents") || d("commands"))
			? `last ${(ms / 1000).toFixed(0)} s: ${(d("presents") * 1000 / ms).toFixed(1)} presents/s, ${d("parks")} parks, ${(d("parks") ? d("parkedMs") / d("parks") : 0).toFixed(2)} ms parked each; `
			: "";
		return `virtio-gpu: ${rate}${g.presents} presents, ${g.commands} commands (${g.fenced} fenced: ${g.parks} parked, ${g.parkedMs.toFixed(0)} ms in all), ` +
			`${g.reads} readbacks, ${g.errors} errors${g.contextLost ? " (the WebGL2 context is lost: restart the GL programs; the next one gets a new renderer)" : g.lastError ? ` (last: ${g.lastError})` : ""}`;
	}

	/**
	 * Where the renderer's time went per readback (TRANSFER_GET2, about one a
	 * frame for a program that shows its frames) between two of its counters
	 * (vm.gl.stats.renderer; .agents/gl.md, Stats), MS apart; null without a
	 * readback in between. Parked: busy waits held until WebGL said the GPU
	 * was done; reading: glReadPixels or getBufferSubData, which wait for the
	 * GPU work they read; issuing: decoding command buffers into GL calls. The
	 * rest of a frame is outside the renderer (the guest, Mesa, kwvsock).
	 */
	function glFrameTimes(r: VirglTotals, p: VirglTotals | undefined, ms: number): string | null {
		const d = (k: keyof VirglTotals) => r[k] - (p?.[k] ?? 0);
		const n = d("reads");
		// n < 0: a new renderer after a loss counts from 0 again
		if (n <= 0 || ms <= 0) return null;
		const per = (k: keyof VirglTotals) => `${(d(k) / n).toFixed(2)} ms`;
		const busy = d("submitMs") + d("readMs") + d("writeMs") + d("otherMs");
		const atOnce = d("waitsRead") + d("waitsDone") + d("waitsAhead");
		return `Last ${(ms / 1000).toFixed(0)} s: ${(n * 1000 / ms).toFixed(0)} readbacks/s (about one a frame), ${(ms / n).toFixed(2)} ms apart: ` +
			`${per("parkedMs")} parked in busy waits, ${per("readMs")} reading back (waits for the GPU), ${per("submitMs")} issuing GL, ` +
			`${per("writeMs")} uploading; renderer busy ${(100 * busy / ms).toFixed(0)}% of the time; busy waits ${d("waits")}: ${atOnce} answered at once ` +
			`(${d("waitsAhead")} ahead of the GPU), ${d("parks")} parked (longest so far ${r.parkMaxMs.toFixed(1)} ms)`;
	}

	// --- boot --------------------------------------------------------------------
	async function boot() {
		ui.setState("loading", "Downloading");
		setLive(" .... ", "Downloading");
		const t0 = performance.now();
		// The kernel downloads and compiles on this thread in both modes (the engine compiles
		// off-thread while it streams), so it overlaps the terminal's start and, in worker
		// mode, the data disk lock; the worker then gets the compiled Module.
		const load = (url: string) => {
			const p = loadKernelModule(url, { what: "kernel", onProgress: onDownload }).catch((e: unknown) => {
				const compile = e instanceof BootError && e.stage === "compile";
				throw tag(e, compile ? "compile" : "fetch", compile ? "compile" : "kernel");
			});
			p.catch(() => {}); // awaited below; a failure there is the one reported
			return p;
		};
		// Several CPUs: the SMP kernel, once a suspended session was offered (below).
		let loading = smp ? null : load(kernelUrl);
		// The image to boot (worker mode: the worker opens it from its URL).
		if (cfg.distroWhy) {
			warn(cfg.distroWhy);
			ui.toast(cfg.distroWhy);
		}
		ui.check("distro", cfg.portable ? "Machine" : "Distro", cfg.distroWhy ? "warn" : "info",
			cfg.portable ? cfg.portable.name : distro?.name ?? "none (base shell)",
			cfg.portable ? `mutable NixOS root seeded once from ${cfg.portable.url}` : cfg.distroWhy ?? (distro ? `${distro.url}, ${fmtMiB(distro.size)}` : "?distro=none: the base initramfs's shell, no distro image"));
		// Inline: opened while the kernel downloads (one Range request and the first 64 KiB).
		const tDistro = performance.now();
		const distroOpening = distro && !cfg.worker
			? openDistroDisk(distro.url, { log: (m) => { console.log(m); ui.hostLog(m); } }).then((d) => ({ d, ms: performance.now() - tDistro }))
			: null;
		distroOpening?.catch(() => {}); // awaited below
		const session = sessionInfo();
		session.catch(() => {});
		if (resumeRequest === null && quietResume) {
			// A plain load: quiet only if there is a session it can resume as it is (offerResume() decides for good,
			// also on the data disk); else the boot lines show at once. An IndexedDB that does not answer: shown.
			const settle = setTimeout(unquiet, 2000);
			session.then((m) => {
				clearTimeout(settle);
				if (quietResume && m && sessionCpus(m) === cfg.cpus && !sessionMismatch(m, kernelUrl, sessionDevicesFor(m), distroRef))
					ui.splash("Resuming", "Restoring the suspended session…");
				else unquiet();
			}, () => { clearTimeout(settle); unquiet(); });
		}
		let dataDisks: BlockDevice[] | DiskSpec[] = [];
		if (cfg.worker) {
			// The worker builds the data disk and the network from specs.
			ui.check("worker", "Worker mode", "pass", cfg.workerParam ? (cfg.workerAsked ? "on (?worker=1)" : "on (default)") : `for ${cfg.cpus} CPUs (${cfg.resumeCpus ? "the suspended session's" : `?cpus=${cfg.smpParam}`})`,
				"the kernel, the data disk, the network, the display, input and sound devices run in a Web Worker" + (smp ? ", which starts the other CPUs as workers of its own" : ""));
			ui.hostLog(`[host] worker mode: the kernel runs in a Web Worker, with the data disk, the network, the display, input and sound${smp ? `; ${cfg.cpus} CPUs` : ""}`);
			dataDisks = await dataSpec();
		}
		if (await offerResumeCpus(session)) return; // reloading to resume on the session's CPU count, or kept
		if (smp) loading = load(kernelUrl);
		let module: WebAssembly.Module;
		try {
			module = await loading!;
		} catch (e) {
			if (smp && bootUpOnce(`the SMP kernel did not load (${(e as Error)?.message ?? e})`)) return;
			throw e;
		}
		dropLegacyScope(); // an older build's offline copy (sw.ts)
		if (ui.stageState("compile") !== "active") ui.stage("compile", "active"); // no progress events (e.g. a cached module)
		ui.stage("compile", "done", `${WebAssembly.Module.imports(module).length} imports, ${WebAssembly.Module.exports(module).length} exports`);
		setLive(null);
		ok("Compiled the kernel", ui.stageTime("compile"));
		ui.hostLog(`[host] kernel downloaded and compiled in ${fmtS(performance.now() - t0)}`);
		const bundle = bundledBoot(module);
		const b = bundle.initrd;
		if (!cfg.portable) {
			if (!b) throw tag(new Error(`${kernelUrl} has no bundled base initramfs`), "compile", "kernel");
			ui.hostLog(`[host] base initramfs: bundled in ${kernelUrl} (${fmtMiB(b.length)} gzipped)`);
			ok(`Found the base initramfs (${fmtMiB(b.length)})`);
		} else {
			ui.hostLog("[host] direct-root boot: the bundled initramfs is not used");
			ok("Selected the mutable NixOS root");
		}
		// The bundle's own command line unless ?append= gives one, with ?root= (kw.root=) after it.
		if (!cfg.portable && !cfg.append && bundle.cmdline) cfg.cmdline = cfg.root ? `${bundle.cmdline} kw.root=${cfg.root}` : bundle.cmdline;
		// Guest GL: the guest's shells point Mesa at virgl, at the vtest link where there is no
		// /dev/dri render node (kw-gl.sh in the base's kw layer).
		if (cfg.gl) cfg.cmdline += " kw.gl=1";
		// The Wayland desktop: with kwshm the page listens for wland's relay (attachWayland()), and
		// kw.wayland=1 has the guest start the relay at boot, which dials only when an app connects,
		// and give its shells the session (wland --boot and kw-wayland.sh in the base's kw layer).
		// This load's own kwshm, like kw.gl=1: a resume keeps the saved kernel's command line.
		if (cfg.shm) cfg.cmdline += " kw.wayland=1";
		if (distroOpening) {
			try {
				const { d, ms } = await distroOpening;
				distroDisk = d;
				showDistro(d.info, ms);
			} catch (e) {
				throw tag(e, "distro", "kernel");
			}
		}
		if (!cfg.worker) dataDisks = await openData(module);

		await termReady.catch((e: unknown) => { throw tag(e, "terminal", ""); }); // the console needs it (and its size)
		const memoryStage = () => {
			ui.setState("booting", "Booting");
			ui.stage("memory", "active", `${cfg.memMiB} MiB requested (${cfg.memWhy})`);
		};
		if (!cfg.worker) memoryStage(); // worker mode: once the worker runs
		// A failed read of the distro image (the server went away, or the image was rebuilt:
		// the SDK's strict HttpBase refuses a changed one) is an I/O error in the guest: say so.
		let distroReadFailed = false;
		const log = (m: string) => {
			console.log(m);
			ui.hostLog(m);
			if (distro && !distroReadFailed && /^\[host\] block: wda op 0 /.test(m)) {
				distroReadFailed = true;
				KW.report("distro", `Reading the ${distro.name} image failed: the guest gets I/O errors from its root. If the image was rebuilt or the server stopped, reload the page.`, m, false);
			}
		};
		// Worker mode: a worker that never reports back must not leave the page waiting.
		let workerWatchdog: ReturnType<typeof setTimeout> | undefined;
		if (cfg.worker) {
			setLive(" .... ", "Starting the kernel worker");
			workerWatchdog = setTimeout(() => {
				// A default worker: the page's thread once instead (an asked one is reported).
				if (!cfg.workerAsked && bootUpOnce("the kernel worker did not report back within 20 s", false, true)) return;
				unquiet();
				ui.fail("worker", "The kernel worker did not report back within 20 s (it may have failed to load; the browser console may say why)", "",
					{ title: "Worker mode failed" });
			}, 20000);
		}
		const onProgress = (p: BootProgress) => {
			if (p.stage === "worker") {
				// Worker mode: the worker runs. JSPI in a worker is checked by nobody but this.
				clearTimeout(workerWatchdog);
				ui.check("worker-jspi", "JSPI in the worker", p.jspi ? "pass" : "fail", p.jspi ? "yes" : "no",
					p.jspi ? "WebAssembly.Suspending and promising exist in the Web Worker" : "the page has JSPI but its Web Worker does not, so worker mode cannot run in this browser (leave out ?worker=1)");
				ui.hostLog(`[host] kernel worker started; JSPI in the worker: ${p.jspi ? "yes" : "no"}`);
				memoryStage();
			} else if (p.stage === "download") {
				onDownload(p);
			} else if (p.stage === "memory") {
				KW.memActualMiB = p.mib;
				const fell = p.failures.length > 0;
				const kind = p.memory64 ? "64-bit" : "32-bit";
				ui.stage("memory", "done", fell ? `${p.mib} MiB ${kind} (${p.requestedMiB} MiB failed: ${p.failures.join("; ")})` : `${p.mib} MiB ${kind}`);
				ui.check("mem", "Kernel memory", fell ? "warn" : "pass", `${p.mib} MiB`, fell ? `wanted ${p.requestedMiB} MiB: ${p.failures.join("; ")}` : cfg.memWhy);
				if (fell) {
					ui.toast(`Using ${p.mib} MiB: ${p.requestedMiB} MiB could not be allocated`);
					warn(`Allocated ${p.mib} MiB of memory (${p.requestedMiB} MiB failed)`, ui.stageTime("memory"));
				} else ok(`Allocated ${p.mib} MiB of memory`, ui.stageTime("memory"));
			} else if (p.stage === "instantiate") {
				ui.stage("boot", "active", "instantiating the module");
			} else if (p.stage === "start") {
				ui.stage("boot", "active", `cmdline: ${cfg.cmdline}`);
				// The transient line, which the kernel's messages then follow; its result,
				// "Started Linux", heads the screen once user space runs. ?verbose=1 never
				// writes that, and lists every kernel line: a header line instead.
				if (cfg.verbose) bootLine(`         Starting Linux${cmdlineNote()}\r\n`);
				else setLive(" .... ", "Starting Linux");
			}
		};
		const common = {
			cmdline: cfg.cmdline, initrd: cfg.portable ? null : undefined,
			memoryMiB: cfg.memMiB, memoryFallbackMiB: cfg.memFallbackMiB, jit: cfg.jit,
			consoleSize: { cols: term.cols, rows: term.rows },
			onOutput: consoleWrite, log, onProgress,
			display: cfg.display ? display.size : false, onDisplay: display.onDisplay, onInput: display.onInput,
			sound: cfg.sound ? createAudioOut({ log }) : false, // Web Audio, ?sound=0 (audio.ts)
			vsock: true, // the terminal windows (windows.ts: kwtty sessions)
		};
		// Guest GL on this thread's WebGL2 (Debian, on by default; showGl()), read when the kernel is
		// made: a resumed session keeps its own (adoptSessionGl()). The renderer loads on the guest's
		// first GL use (?glload=eager: before the boot); with it virtio-gpu, the guest's /dev/dri, 3D on
		// that renderer (?gpu=0: none).
		// And kwshm, for the Wayland desktop (wayland.ts; a resumed session keeps its own too).
		const glDevices = () => ({
			gl: cfg.gl && (cfg.glStrictWaits || cfg.glEager ? { ...(cfg.glStrictWaits ? { strictWaits: true } : {}), ...(cfg.glEager ? { eager: true } : {}) } : true),
			gpu: cfg.gpu,
			shm,
		});
		// A session on this load's CPU count (another: offerResumeCpus(), above).
		const resume = await offerResume(session, dataDisks);
		if (!resume) unquiet(); // a fresh boot
		kernelStarting = true;
		try {
			const create = (restore?: KernelSnapshot) => {
				// Worker mode: the SDK posts the Module compiled above to the worker. An engine
				// that cannot post one (not seen so far; Safari is untested) gets the kernel's
				// URL instead, absolute because the worker has no base of its own, and the
				// worker downloads (from the HTTP cache) and compiles it.
				const inWorker = (kernel: WebAssembly.Module | string) => createKernel({
					...common, ...glDevices(), worker: true, kernel, compileInWorker: typeof kernel === "string",
					cpus: smp ? cfg.cpus : undefined, // the worker starts the other CPUs (js/web/cpu.ts)
					shared: cfg.shared ? undefined : false, // shared memory where the page is cross-origin isolated (?shared=0: never)
					disks: dataDisks as DiskSpec[], onDiskError: (_i, e) => saveError(e),
					distro: distro?.url, // a spec the page makes (relative to the page); the worker opens it
					net: browserNetSpec({ enabled: cfg.net, servers: cfg.wisp, routes: cfg.routes }), // Wisp, in the worker (net.ts)
					restore, transferRestore: true, // the snapshot is read for this boot only
				});
				return cfg.worker
					? inWorker(module).catch((e: unknown) => {
						if (!(e instanceof BootError && e.stage === "support" && /cannot send the kernel/.test(e.message))) throw e;
						ui.hostLog(`[host] ${e.message}; the worker loads the kernel itself`);
						return inWorker(new URL(kernelUrl, location.href).href);
					})
					: createKernel({
						...common, ...glDevices(), kernel: module, disks: dataDisks as BlockDevice[], restore, distro: distroDisk ?? undefined,
						net: browserNet({ enabled: cfg.net, servers: cfg.wisp, routes: cfg.routes, log }), // Wisp (net.ts)
					});
			};
			if (resume) {
				try {
					vm = await create(resume.snap);
					resumed = { note: resumedNote(ago(resume.meta.saved)), saved: resume.meta.saved, screen: resume.meta.screen, preview: resume.meta.preview ?? null, windows: resume.meta.windows, win: resume.meta.win };
					interacted = true; // it was worth saving
					resumedSaved = resume.meta.saved;
					if (resume.meta.screen) screenTail.push(resume.meta.screen);
					ui.check("session", "Suspended session", "pass", `resumed (saved ${ago(resume.meta.saved)})`, `${fmtMiB(resume.meta.bytes)}; saved ${cfg.worker === resume.meta.worker ? "in this mode" : resume.meta.worker ? "in worker mode" : "inline"}`);
				} catch (e) {
					const why = (e as Error)?.message ?? String(e);
					// Several CPUs that did not start (the worker, its CPU threads; not a refusal of a disk or
					// device): the session stays, and the page reloads on one CPU, which asks before a boot
					// changes the session's data disk (offerResumeCpus()).
					const n = sessionCpus(resume.meta);
					if (n > 1 && (!/^snapshot: /.test(why) || /^snapshot: the snapshot has \d+ CPUs?, this machine has/.test(why)) &&
						bootUpOnce(`resuming on ${n} CPUs failed (${why})`)) return;
					// Refused (a disk or device that differs, another kernel build) or failed: boot fresh.
					unquiet();
					warn(`Could not resume the suspended session (${why}); booting fresh`);
					ui.toast(`Could not resume: ${why}`);
					ui.check("session", "Suspended session", "warn", "not resumed", why);
					dropSessionGl();
					vm = await create();
				}
				// Resumed or refused, it is used up: the running machine changes the disk. Resumed on several
				// CPUs, once user space answers: its tasks resume only after every CPU came back, so a CPU
				// that fails to start meanwhile leaves the disk, and so the session, as saved.
				if (resumed && sessionCpus(resume.meta) > 1) {
					const saved = resume.meta.saved;
					void vm.exec("/bin/sh", ["-c", ":"]).then(() => clearSession(saved)).catch(() => {});
				} else await clearSession().catch(() => {});
			} else vm = await create();
		} catch (e) {
			kernelStarting = false;
			clearTimeout(workerWatchdog);
			// The distro image (worker mode opens it in the worker): not a reason to try one CPU.
			if (/^distro: /.test((e as Error)?.message ?? "")) throw tag(e, "distro", "kernel");
			const be = e instanceof BootError ? e : undefined;
			// A default worker that could not start (its JSPI, the module): the page's thread, one CPU.
			if (cfg.worker && !cfg.workerAsked && be?.stage === "support" && bootUpOnce(`the kernel worker did not start (${be.message})`, false, true)) return;
			// Several CPUs that did not start (the worker, its JSPI, the shared memory): one CPU.
			if (smp && bootUpOnce(`booting on ${cfg.cpus} CPUs failed (${(e as Error)?.message ?? e})`)) return;
			if (cfg.worker && be?.stage === "support") throw tag(e, "worker", "boot");
			if (cfg.worker && be?.stage === "download") throw tag(e, "fetch", "kernel");
			if (cfg.worker && be?.stage === "compile") throw tag(e, "compile", "compile");
			const stage = be?.stage === "memory" ? "memory" : "boot";
			throw tag(e, stage, stage);
		}
		kernelStarting = false;
		clearTimeout(workerWatchdog);
		// The guest's WASI programs (.wasm files, run by kwwasi over vsock port 1021)
		// on the page's wasm engine, each in a Web Worker (js/web/wasi.ts).
		const wasi = vm.vsock ? serveWasiPrograms(vm.vsock, { log }) : undefined;
		void vm.exited.then(() => { vmExited = true; wasi?.close(); });
		g.vm = vm;
		KW.vm = vm;
		// The guest preview (preview.ts) relays /vm/<id>/<port>/ to vm.fetch().
		attachPreview(vm);
		// Wayland apps (wayland.ts): wland's relay connects to vsock port 1023 when the guest's first Wayland app starts.
		const stopWayland = attachWayland(vm, (l) => ui.hostLog(l));
		KW.wayland = waylandApi;
		// The guest's open and xdg-open (open.ts): its URLs, in the preview or a
		// new tab once the user confirms. Added once the kernel runs rather than
		// as createKernel's commands: spawn() and exec() (the windows, the demos)
		// would wait for those, and fail if linking them failed.
		const openUrl = openCommand({
			ask: (q) => ui.ask(q), dismiss: () => ui.answer(false), previewSupported,
			preview: (port, path) => { openPreview(port, path); },
			tab: (url) => { window.open(url, "_blank", "noopener,noreferrer"); },
		});
		for (const name of ["open", "xdg-open"])
			vm.addCommand(name, openUrl, { timeout: 120000 }).catch((e: Error) => ui.hostLog(`[host] the guest's ${name}: ${e.message}`));
		checkReady();
		const inst = local();
		if (inst) {
			g.kernel = inst.kernel;
			KW.kernel = inst.kernel;
		}
		if (cfg.worker && vm.distro) showDistro(vm.distro, null);
		if (vm instanceof WorkerKernel) {
			workerDataAttached(vm, performance.now() - t0);
			const shared = vm.transport === "shared";
			const why = shared ? "the page is cross-origin isolated" : !cfg.shared ? "?shared=0" : "the page is not cross-origin isolated, so it has no SharedArrayBuffer";
			ui.check("worker-transport", "Worker input and frames", shared ? "pass" : "info", shared ? "shared memory" : "messages",
				shared ? `${why}: the worker reads input and frame requests while the kernel runs (about 1 ms)`
					: `${why}: they wait for the kernel's next yield, up to 20 ms while the guest is busy`);
			ui.hostLog(`[host] kernel worker: console and evdev input and frames by ${shared ? "shared memory" : "messages"} (${why})`);
		}
		if (smp) {
			// The worker gives the SMP kernel one CPU where it cannot start their threads (it logs why).
			const got = vm.stats().cpus;
			ui.check("smp", "Guest CPUs", got > 1 ? "pass" : "warn", got > 1 ? `${got} (${cfg.resumeCpus ? "the suspended session's" : `?cpus=${cfg.smpParam}`})` : `1 (asked for ${cfg.cpus})`,
				got > 1 ? "the SMP kernel, each CPU in a Web Worker on one shared memory"
					: "the kernel worker could not start CPU threads (the Kernel log says why): the SMP kernel runs on one CPU");
			ui.hostLog(`[host] SMP kernel on ${got} CPU${got > 1 ? "s" : ""} (${cfg.cpus} asked)`);
			if (got < cfg.cpus) ui.toast(`Running on ${got} CPU${got > 1 ? "s" : ""}: the worker could not start more`);
		}
		const booted = vm;
		KW.jitStats = () => booted.stats().jit;
		// kwemu's JIT counters in the System tab (and Copy diagnostics), for devices without devtools.
		let jitShown = "";
		const showJit = () => {
			const j = booted.stats().jit;
			const value = !j.enabled ? (cfg.jit ? "unavailable" : "off (?jit=0)") : !j.requested ? "kernel without the JIT tier"
				: `${j.compiled} compiled, ${j.live} live (max ${j.maxLive}), ${j.freed} freed, ${j.failed} failed`;
			const gc = j.collected < 0 ? "" : `; ${j.collected} collected, ${j.retained} freed but uncollected (max ${j.maxRetained})` +
				(j.gcNudges ? `, ${j.gcNudges} GC nudges` : "") + (j.refused ? `, ${j.refused} refused` : "");
			const note = j.compiled ? `${j.compileMs.toFixed(0)} ms compiling, ${fmtMiB(j.bytes)} of modules${gc}` : "";
			if (value + note === jitShown) return;
			jitShown = value + note;
			ui.check("jit", "JIT tier", j.failed ? "warn" : j.compiled ? "pass" : "info", value, note);
		};
		showJit();
		showGl(vm);

		// Not fatal, but worth flagging: the kernel started and printed nothing.
		const bootTime = inst ? inst.kernel.bootTime : performance.now();
		const jitTimer = setInterval(() => (ended() ? clearInterval(jitTimer) : showJit()), 2000);
		const quiet = setInterval(() => {
			if (ended()) return clearInterval(quiet);
			if (!sawOutput && performance.now() - bootTime > 30000) {
				clearInterval(quiet);
				KW.report("watchdog", "No console output 30 s after the kernel started", `cmdline: ${cfg.cmdline}`, false);
			}
		}, 2000);

		if (resumed) {
			markRunning("resumed"); // the guest prints nothing by itself
			reopenPreview(vm, resumed.preview);
			// Terminal windows 1-9: their sessions wait detached in the guest (windows.ts).
			if (Array.isArray(resumed.windows)) windows.reattach(resumed.windows, resumed.win);
			// Every resume says so, the same way (a machine that went on in place, never stopped, says nothing).
			sayResumed(resumed.saved);
		}
		const res = await vm.exited;
		clearInterval(quiet);
		unquiet(); // it ended before the screen was restored
		attachPreview(null); // previews now get 503
		stopWayland?.();
		stopWindows(`the kernel stopped (${res.kind})`);
		if (holdState) {
			// Held, the session saved: stopped after AUTO_SUSPEND_HOLD_MS (or by Suspend), or ended otherwise
			// (its worker died). Nothing is lost: the tab, when shown, resumes the saved session.
			const h = holdState;
			holdState = null;
			await suspending;
			ui.setState("halted", "Suspended");
			if (pause.ended()) {
				// Paused by hand: offered as after Suspend (the Resume card), not resumed by itself.
				if (res.kind !== "stopped" || h.lost) ui.hostLog(`[host] the paused system ended (${res.reason}); its session stays saved`);
				ui.setSuspended(h.bytes);
				write(`\r\n${okLine("Suspended — Resume (or reload the page) to continue")}\r\n`);
				return;
			}
			if (res.kind !== "stopped" || h.lost) ui.hostLog(`[host] the held system ended (${res.reason}); its saved session resumes when the tab is shown`);
			auto.heldEnded();
			return;
		}
		if (suspending && res.kind === "stopped") {
			// The kernel stops only once the session is saved; failed: it was stopped meanwhile by something else.
			const failed = await suspending;
			ui.setState("halted", failed ? "Stopped" : "Suspended");
			// The machine is lost: say so, in red.
			if (failed) KW.term!.notice(`[host] the kernel stopped while it was being suspended, and the session was not saved (${failed}) — use Reboot in the status panel to start again`);
			else if (auto.state !== "saving" && auto.state !== "done") {
				ui.setSuspended(suspendedBytes); // the Resume card
				write(`\r\n${okLine("Suspended — Resume (or reload the page) to continue")}\r\n`);
			}
			// Else suspended in the background: no card and nothing on the screen, which the resume
			// restores as it is once the tab is shown (autosuspend.ts; the Kernel log and the Environment row say it).
			return;
		}
		if (res.kind === "halt") {
			const label = res.code === 0 ? "Powered off" : `Halted (${res.code})`;
			ui.hostLog(`[host] kernel halted (code ${res.code})`);
			if (!running) { ui.stage("boot", "done"); ui.stage("userspace", "skip"); }
			// `reboot` in the guest (code 2): start again, unless it keeps doing that.
			if (res.code === 2 && autoRebootAllowed()) {
				ui.setState("halted", "Restarting");
				KW.term!.notice("[host] restart requested — rebooting");
				await data?.disk?.saving?.catch(() => {}); // the last flush's transaction
				ui.reboot();
				return;
			}
			ui.setState("halted", label);
			const why = res.code === 2 ? ` (restart requested ${AUTO_REBOOT_MAX} times within a minute, so not rebooting on its own)` : "";
			KW.term!.notice(`[host] ${label.toLowerCase()}${why} — use Reboot in the status panel to start again`);
			return;
		}
		const titles: Record<string, string> = { panic: "Kernel panic", trap: "WebAssembly trap in the kernel", fatal: "Host runtime error" };
		ui.fail(res.kind, res.reason, (res.error as Error | undefined)?.stack ?? "", { title: titles[res.kind] ?? "Kernel stopped" });
	}

	boot().catch((e: StageError) => {
		console.error(e);
		stopWindows("the boot failed");
		unquiet();
		failed(e.kind === "distro" ? `Open the ${cfg.guest} image` : STEP[e.stageId ?? ""] ?? "Boot");
		if (e.stageId) ui.stage(e.stageId, "fail", e.message);
		const titles: Record<string, string> = { fetch: "Download failed", compile: "Kernel failed to compile", memory: "Not enough memory", boot: "Boot failed", terminal: "The terminal failed to start",
			worker: "Worker mode cannot run in this browser", distro: "The distro image could not be opened" };
		const hint = e.kind === "distro" ? `The page reads ${cfg.distro?.url ?? "the image"} from its own server with Range requests (web/scripts/kernel.ts picks the images; kernel/build.sh distro builds them). ` +
			"Pick another distro under Options and Reboot, or boot with ?distro=none for the base shell." : undefined;
		ui.fail(e.kind ?? "boot", e.message, (e.cause as Error | undefined)?.stack ?? e.stack, { title: titles[e.kind ?? ""] ?? "Boot failed", ...(hint ? { hint } : {}) });
	});
}
