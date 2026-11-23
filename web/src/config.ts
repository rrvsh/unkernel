// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The page's configuration. The kernel is the page's own (sdk.ts): the base
// bundle unkernel.wasm, with the distro image ?distro= picks
// (virtual:unkernel-kernel's list) attached read-only.
//
// The settings below are kept in localStorage (SETTINGS_KEY: {name: value},
// only those that differ from the defaults). Each one except ?simulate,
// ?showcase and ?routes has a control under Options in the status panel; Reboot saves
// them there (ui.ts nextSettings()) and loads the page's bare URL. A URL
// parameter of the same name overrides the saved one for that load (links,
// the browser tests); the page never writes the URL. ?simulate, ?showcase
// and ?routes are read from the URL only.
//
//   ?mem=MiB                           kernel memory (default: auto, from the SDK's autoMemoryMiB():
//                                      512 on phones, 2048 otherwise, less on low-memory devices)
//   ?append=<cmdline>                  kernel command line
//   ?net=0                             no network device (else: the Wisp server(s), default:
//                                      the project's)
//   ?wisp=<url>[,<url>...] | ?wisp=0   Wisp servers to race (0 = no network device)
//   ?routes=0                          URL only: plain HTTP to the hosts of DEFAULT_ROUTES goes
//                                      through Wisp too (default: answered with fetch() from
//                                      their CORS mirrors, the SDK's fetchRoutes(); net.ts)
//   ?jit=0                             kwemu interprets only (default: its JIT tier compiles hot
//                                      guest code to WebAssembly; counters in KW.jitStats())
//   ?verbose=1                         write every kernel message to the terminal, in gray
//                                      (default: kernel messages go to the Kernel log tab, and
//                                      during boot the newest one shows on the transient line)
//   ?data=0                            no data disk. By default (when IndexedDB exists) the data
//                                      disk, an ext4 fs labelled kwdata, is attached as /dev/wda
//                                      and kept in IndexedDB (data.ts); the guest's root is an
//                                      overlay whose changes live on it. Its template is the
//                                      kernel bundle's section unkernel.datadisk. One tab at a
//                                      time: another tab gets an unsaved in-memory copy.
//                                      KW.exportData(), KW.importData(file), KW.resetData() (also
//                                      buttons in the panel). Hiding or leaving the page and
//                                      Reboot ask the guest to sync first (KW.sync(), the SDK's
//                                      sync()).
//   ?display=0                         no display. By default the guest gets /dev/fb0 (kwfb,
//                                      640x480), and a canvas over the terminal shows it while a
//                                      program has it open (try `glimmer`). Nothing is
//                                      allocated until then.
//   ?sound=0                           no sound card. By default the guest gets ALSA hw:0,0 and
//                                      /dev/dsp (kwsnd, playback), played with Web Audio
//                                      (audio.ts; try `glimmer`). Nothing runs until a program
//                                      plays; the first tap or key press after that unmutes.
//   ?distro=<name> | ?distro=none     the distro image to boot (default debian, else the first;
//                                      an unknown name boots the default and says so; none: no
//                                      image, the base shell). Its changes to the root
//                                      live in /data/distros/<name>/ on the data disk.
//   ?gl=0 | ?gl=1                      guest GL (Debian only; default on where the display is,
//                                      ?display=0 turns it off unless ?gl=1): the guest's Mesa
//                                      renders through this browser's WebGL2 (virglrenderer
//                                      compiled to wasm, on the page's thread; the SDK's
//                                      createKernel({ gl }), .agents/gl.md). It also gives the
//                                      guest a virtio-gpu device (createKernel({ gpu }): /dev/dri,
//                                      where stock Mesa finds its virgl driver with no variables,
//                                      and KMS clients show on the display), and adds kw.gl=1 to
//                                      the command line, for which the guest's shells set
//                                      GALLIUM_DRIVER=virpipe and LIBGL_ALWAYS_SOFTWARE=1 (the
//                                      vtest link) only where there is no /dev/dri render node
//                                      (kw-gl.sh). Mesa is not in the image: apt-get install it.
//                                      virgl.mjs and virgl.wasm are fetched only on the guest's
//                                      first GL use (a program asking the device for its
//                                      capsets, or a vtest client), not at boot; before the boot
//                                      the SDK only tries a WebGL2 context (a few ms) and offers
//                                      3D on the device where it gets one. Off with another
//                                      distro, without WebGL2 on the page's thread, or in a build
//                                      without the renderer (glBlocker()).
//   ?gpu=0                             with guest GL, this load only: no virtio-gpu device, so the
//                                      guest's shells use the vtest link (guest GL as it was
//                                      before the device, for comparison). Also none with
//                                      ?display=0.
//   ?shm=0                             this load only: no kwshm device, so no Wayland desktop
//                                      (wayland.ts; the launcher's Wayland demos are disabled).
//                                      A resumed session keeps the device it was saved with.
//   ?wlgpu=0                           this load only: the Wayland desktop takes no GPU buffers
//                                      (no gpu source for wland: GL apps render in software,
//                                      llvmpipe over wl_shm, instead of by resource on the
//                                      page's renderer; for comparison).
//   ?glload=eager                      with guest GL, this load only: load the renderer before
//                                      the boot (the SDK's gl.eager), as the page did before it
//                                      loaded on first use.
//   ?glwait=strict                     with guest GL: the renderer answers the guest's busy waits
//                                      as vtest does, once WebGL tells that the fences have
//                                      retired (the SDK's gl.strictWaits), for comparing frame
//                                      times; the Guest GL row shows them. Default: at once where
//                                      safe (.agents/gl.md, Busy waits).
//   ?root=initramfs                   safe mode for this boot (kw.root=initramfs): the plain
//                                      image root instead of the overlay root; /data stays
//                                      mounted (the panel's Safe mode button; .agents/data-disk.md)
//   ?worker=1                          run the kernel in a Web Worker (the SDK's
//                                      createKernel({ worker: true })), so it never blocks the
//                                      page. The data disk and the Wisp network are built in the
//                                      worker from specs; the display, input devices and sound
//                                      work as on the page's thread. Console and evdev input and
//                                      frames go through shared memory when the page is
//                                      cross-origin isolated (https or localhost; a plain-http
//                                      LAN page has no SharedArrayBuffer), else as messages,
//                                      which wait up to 20 ms while the guest is busy. Default:
//                                      on where the page is cross-origin isolated (a worker that
//                                      fails to start then reloads once on the page's thread,
//                                      boot.ts bootUpOnce()), else off; ?worker=0: the page's
//                                      thread, one CPU unless ?cpus= asks for more.
//   ?shared=0                          in worker mode: messages even where shared memory works
//                                      (to compare the two)
//   ?cpus=N                            boot the SMP kernel on N CPUs (2 to 16, at most
//                                      navigator.hardwareConcurrency), each CPU in a Web Worker
//                                      of its own on one shared memory; implies ?worker=1 (CPU 0
//                                      blocks while it waits for another CPU, which a page's main
//                                      thread may not). Needs the page's SMP kernel (sdk.ts
//                                      kernelSmpUrl: a base bundle with an SMP patch) and
//                                      cross-origin isolation (https or localhost); otherwise, or
//                                      when the SMP kernel fails to load or start, the page boots
//                                      on one CPU as usual (smpBlocker(), boot.ts). A session
//                                      suspended on N CPUs resumes on N (a load that boots
//                                      another count offers to reload on N: CPUS_ONCE_KEY).
//                                      Default in worker mode: the suggested count (half the
//                                      threads, at most SUGGESTED_CPUS: 4 on desktops, 2 in
//                                      Firefox; one on phones, on fewer than 4 threads and in
//                                      WebKit, where several CPUs ran slower), else one.
//                                      ?cpus=1: one CPU, the UP kernel.
//   ?autosuspend=now|<s>|0             save the machine and pause it by itself once the tab has been
//                                      hidden that long (now: at once; seconds; 0: never); it goes
//                                      on (or, after the page was dropped, resumes) when the tab is
//                                      shown again (autosuspend.ts, boot.ts); only
//                                      a machine the user has used since it booted. Default: now
//                                      on phones and tablets (a background tab may be frozen or
//                                      discarded at any time), off elsewhere.
//   ?askleave=0                        no question when the page is closed or left while such a
//                                      machine runs (beforeunload; staying suspends)
//   ?showcase[=warm,<step>,...]        URL only: a fast scripted tour of the demos with captions;
//                                      warm pre-installs them, step ids pick a subset
//                                      (showcase.ts); read in launcher.ts
//   ?simulate=nojspi,oom,lowmem        URL only: fake a failure (for tests)
import { DEFAULT_MEMORY_FALLBACK_MIB, autoMemoryMiB, glUrl, kernelSmpUrl, kernelUrl, webCpuBlocker } from "./sdk.ts";
import { distros as DISTROS } from "virtual:unkernel-kernel";
import { autoSuspendDefault, parseAutoSuspend } from "./autosuspend.ts";

/** A distro image the page offers (virtual:unkernel-kernel). */
export interface DistroEntry {
	name: string;
	/** On the page's origin, read with Range requests (in a build, a name with its sha256: immutable). */
	url: string;
	size: number;
	/** Its /usr/lib/kw-image where the list knows it (else boot.ts reads it from the guest). */
	imageId?: string;
}

/** The images offered, debian first. */
export const DISTROS_OFFERED: readonly DistroEntry[] = DISTROS;
/** The ?distro= default. */
export const DEFAULT_DISTRO = DISTROS_OFFERED.find((d) => d.name === "debian")?.name ?? DISTROS_OFFERED[0]?.name ?? "none";

/**
 * Plain-HTTP hosts the guest's network answers with fetch() (net.ts), each
 * from a CORS-enabled mirror with the same paths under the base: Debian's
 * apt sources. ?routes=0 turns them off.
 */
export const DEFAULT_ROUTES: Readonly<Record<string, string>> = Object.freeze({
	"deb.debian.org": "https://mirror.unkernel.dev/deb",
});

/** The project's source, linked from About and the boot notes. */
export const REPO = "https://github.com/pithings/unkernel";

/** The command line without ?append=. */
export const DEFAULT_CMDLINE = "console=hvc0 rdinit=/init";

/** localStorage: the saved settings (the header above), a JSON object of strings. */
export const SETTINGS_KEY = "kw.settings";
/** The settings' names. ?net=0 is read as ?wisp=0 and never saved. */
export const SETTING_NAMES: readonly string[] = ["mem", "append", "net", "wisp", "jit", "verbose", "display", "sound", "data", "distro", "root", "worker", "shared", "cpus", "autosuspend", "askleave", "gl"];

/** The saved settings ({} where there are none or localStorage refuses). */
export function loadSettings(): Record<string, string> {
	try {
		const v: unknown = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
		if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([k, x]) => SETTING_NAMES.includes(k) && typeof x === "string"));
	} catch {}
	return {};
}

/** Saves the settings for the next load (none: removes the key); false where localStorage refuses. */
export function saveSettings(s: Record<string, string>): boolean {
	const keep = Object.entries(s).filter(([k]) => SETTING_NAMES.includes(k) && k !== "net");
	try {
		if (keep.length) localStorage.setItem(SETTINGS_KEY, JSON.stringify(Object.fromEntries(keep)));
		else localStorage.removeItem(SETTINGS_KEY);
		return true;
	} catch {
		return false;
	}
}

export interface PortableRoot {
	url: string;
	name: string;
	version: string;
	seed: string;
	generationUrl: string | null;
}

export interface Config {
	/** A mutable direct-root browser machine seeded from ?disk=, or null for the distro flow. */
	portable: PortableRoot | null;
	/** The settings this load read: the saved ones with the URL's on top (?net=0 as wisp=0). */
	settings: Record<string, string>;
	/** The kernel this page boots on one CPU: the base bundle unkernel.wasm (its UP kernel). */
	kernelUrl: string;
	/** The image this load boots, or null (?distro=none). */
	distro: DistroEntry | null;
	/** The Distro option: an image's name or "none". */
	distroParam: string;
	/** Why this load does not boot what ?distro= asked for, or null. */
	distroWhy: string | null;
	/** The user space this load runs: the image's name ("alpine", "debian", ...), or "none" (the base shell). */
	guest: string;
	/** ?append= as given, or null (the kernel bundle's own command line then, boot.ts). */
	append: string | null;
	memMiB: number;
	memWhy: string;
	/** What auto would pick on this device, even when ?mem= is given. */
	memAutoMiB: number;
	/** ?mem= as given, or null for auto. */
	memParam: string | null;
	memFallbackMiB: number[];
	cmdline: string;
	/** The command line as ?append= sets it (cmdline without kw.root=). */
	baseCmdline: string;
	/** ?append= or ?root= was given (the command line is shown only then). */
	cmdlineGiven: boolean;
	/** The guest network device (?net=0 or ?wisp=0 removes it). */
	net: boolean;
	/** ?wisp= servers, or null for the SDK's DEFAULT_WISP_SERVERS. */
	wisp: string[] | null;
	/** Plain-HTTP hosts answered with fetch(): DEFAULT_ROUTES, or null with ?routes=0. */
	routes: Record<string, string> | null;
	/** kwemu's JIT tier (?jit=0 turns it off). */
	jit: boolean;
	/** A display, /dev/fb0 (on unless ?display=0). */
	display: boolean;
	/** A sound card, played with Web Audio (on unless ?sound=0). */
	sound: boolean;
	/** Attach the data disk (?data=0 turns it off). */
	data: boolean;
	/** ?root=initramfs: safe mode (kw.root=initramfs) for this boot, else null. */
	root: "initramfs" | null;
	/** The kernel runs in a Web Worker (with the data disk, network, display, input and sound): ?worker=1, or more than one CPU. */
	worker: boolean;
	/** The Worker thread option: ?worker=1 or ?worker=0, else workerDefault. */
	workerParam: boolean;
	/** Worker mode by default: where shared memory works (cross-origin isolated), unless this load falls back to the page's thread (INLINE_ONCE_KEY). */
	workerDefault: boolean;
	/** ?worker= was given. */
	workerAsked: boolean;
	/** The SMP kernel's URL (sdk.ts kernelSmpUrl), or null when the page has none. */
	kernelSmpUrl: string | null;
	/** The CPUs option: ?cpus= as given (1 to 16), else cpuDefault. */
	smpParam: number;
	/** The CPUs this device boots with by default: cpuSuggested where the page can boot the SMP kernel, else 1. */
	cpuDefault: number;
	/** CPUs this load boots with: resumeCpus, else smpParam where possible (capped at cpuMax), else 1. */
	cpus: number;
	/** This load boots on the suspended session's CPU count to resume it (CPUS_ONCE_KEY, boot.ts), else 0. */
	resumeCpus: number;
	/** Why this page cannot boot more than one CPU (smpBlocker()), or null. */
	smpBlocked: string | null;
	/** Why this load boots on one CPU although ?cpus= asks for more, or after a fallback to one (boot.ts bootUpOnce()), or null. */
	smpWhy: string | null;
	/** The most CPUs offered: navigator.hardwareConcurrency, at most 16 (the kernel's limit). */
	cpuMax: number;
	/** The count the CPUs option suggests (half the threads, at most SUGGESTED_CPUS), or 0 when this device has too few threads to suggest one. */
	cpuSuggested: number;
	/** Worker mode: shared memory for input and frames where it works (?shared=0: messages). */
	shared: boolean;
	verbose: boolean;
	simulate: string[];
	/** Seconds the tab is hidden before the page suspends the machine by itself (0: at once), or null: never (?autosuspend=, autosuspend.ts). */
	autosuspend: number | null;
	/** The Auto-suspend option: "0", "now" or seconds. */
	autosuspendParam: string;
	/** Its default on this device: "now" on phones and tablets, else "0". */
	autosuspendDefault: string;
	/** Guest GL this load (the GL option, on a distro of GL_DISTROS, where glBlocker() allows). */
	gl: boolean;
	/** The GL option: ?gl=1, or by default where the display is (?gl=0 or ?display=0: off). */
	glParam: boolean;
	/** The GL option was set (?gl= in the URL or the saved settings), not the default. */
	glAsked: boolean;
	/** ?glload=eager: the SDK's gl.eager (the renderer loads before the boot). */
	glEager: boolean;
	/** This load's URL names ?gl= or ?gpu=: a suspended session must match them (else its own GL devices are kept for its resume, boot.ts). */
	glFromUrl: boolean;
	/** Why this page cannot offer guest GL (glBlocker()), or null. */
	glBlocked: string | null;
	/** Why this load runs without GL although ?gl=1 asks for it, or null. */
	glWhy: string | null;
	/** ?glwait=strict: the SDK's gl.strictWaits. */
	glStrictWaits: boolean;
	/** With guest GL, the virtio-gpu device (createKernel({ gpu })): unless ?gpu=0 or ?display=0. */
	gpu: boolean;
	/** kwshm, for the Wayland desktop (wayland.ts): unless ?shm=0 (this load's URL only). */
	shm: boolean;
	/** The Wayland desktop shows GPU apps' buffers by resource (wayland.ts): unless ?wlgpu=0 (this load's URL only). */
	wlGpu: boolean;
	/** Ask before the page is closed or left while a used machine runs (?askleave=0: never). */
	askLeave: boolean;
	/** A touch device or a mobile user agent. */
	mobile: boolean;
	coarse: boolean;
	mobileUA: boolean;
	fontSize: number;
}

/** The distros whose Mesa has the virgl driver (Alpine's has none). */
export const GL_DISTROS: readonly string[] = ["debian"];

/** The GL option's default: on where the display is (?display=0: off). */
export function glDefault(display: boolean): boolean {
	return display;
}

/**
 * Why this page cannot offer guest GL, or null: no GL renderer in the
 * page's build (sdk.ts glUrl; web/scripts/kernel.ts), or no WebGL2 on the
 * page's thread, where the renderer runs in both modes (OffscreenCanvas;
 * whether the browser then gives a WebGL2 context shows at boot).
 */
export function glBlocker(): string | null {
	if (!glUrl) return "this page's build has no GL renderer (virgl.mjs: gl/wasm/build.sh, or a release that carries it)";
	if (typeof OffscreenCanvas !== "function" || typeof WebGL2RenderingContext !== "function") return "this browser has no WebGL2 on the page's thread (OffscreenCanvas)";
	return null;
}

/** The kernel's limit (NR_CPUS in kw_smp.config). */
export const MAX_CPUS = 16;

/**
 * Why this page cannot boot the SMP kernel, or null: no SMP kernel in the
 * page's bundle, no cross-origin isolation (shared memory), no Web
 * Workers or no Atomics.waitAsync (webCpuBlocker()), or one CPU thread.
 * JSPI and nested workers in the kernel worker are checked there: a worker
 * that cannot start CPUs boots the SMP kernel on one CPU (boot.ts says so).
 */
export function smpBlocker(): string | null {
	if (!kernelSmpUrl) return "this page's kernel has no SMP build (its base bundle carries no SMP patch: kernel/build.sh smp, then base)";
	const why = webCpuBlocker({ worker: true });
	if (why) return why;
	if ((navigator.hardwareConcurrency || 1) < 2) return "this device reports a single CPU thread";
	return null;
}

/**
 * The most CPUs suggested (and booted by default): half the threads up to
 * this. Profiled with /profile.html (2026-11-19, a 14-thread desktop,
 * Chrome): 4 CPUs ran 4-wide work 2.5x and 8-wide 3.5x as fast as one; 8
 * CPUs only gained on 8-wide work (4-5x), 14 no more, for 3-7% on
 * single-threaded work, 40 ms more boot per CPU past 4 and 9 MiB each.
 * Firefox and phones are not measured yet: two and one. WebKit
 * (webkitEngine()) suggests none: in desktop Safari 27.2 (same machine,
 * 2026-11-19) parallel work got slower with every CPU added (8 CPUs: 0.25-0.4x
 * of one), so it boots one by default.
 */
export const SUGGESTED_CPUS = { desktop: 4, firefox: 2, mobile: 1 };

/** JavaScriptCore: Safari, and every browser on iOS (CriOS and FxiOS are WebKit too, without "Chrome/"). */
export function webkitEngine(ua = navigator.userAgent): boolean {
	return /AppleWebKit\//.test(ua) && !/Chrome\/|Chromium\//.test(ua);
}

/** sessionStorage: boot this tab's next load on one CPU (boot.ts bootUpOnce()), with why. */
export const UP_ONCE_KEY = "kw-up-once";
/** sessionStorage: boot this tab's next load on the page's thread, one CPU (boot.ts bootUpOnce(..., inline)), with why. */
export const INLINE_ONCE_KEY = "kw-inline-once";
/** sessionStorage: boot this tab's next load on this many CPUs, to resume the session suspended on them (boot.ts offerResumeCpus()). */
export const CPUS_ONCE_KEY = "kw-cpus-once";
function takeOnce(key: string): string | null {
	try {
		const v = sessionStorage.getItem(key);
		sessionStorage.removeItem(key);
		return v;
	} catch {
		return null;
	}
}

export function readConfig(search: string = location.search, saved: Record<string, string> = loadSettings()): Config {
	const url = new URLSearchParams(search);
	const params = new URLSearchParams(saved);
	for (const k of SETTING_NAMES) if (url.has(k)) params.set(k, url.get(k)!);
	if (params.get("net") === "0") params.set("wisp", "0");
	params.delete("net");
	const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
	const mobileUA = /Android|iPhone|iPad|Mobi/i.test(navigator.userAgent);
	const mobile = coarse || mobileUA;
	const memParam = params.get("mem");
	const auto = autoMemoryMiB({ mobile });
	const fixed = memParam !== null && Number(memParam) > 0;
	const disk = url.get("disk");
	const machine = url.get("machine") || "phone";
	const seed = url.get("seed") || disk || "seed";
	const diskVersion = url.get("disk-version") || "v1";
	const generation = url.get("generation");
	const portable = disk ? {
		url: new URL(disk, location.href).href,
		name: machine,
		version: diskVersion,
		seed,
		generationUrl: generation ? new URL(generation, location.href).href : null,
	} : null;
	const append = params.get("append");
	const root = !portable && params.get("root") === "initramfs" ? "initramfs" : null;
	const wispParam = params.get("wisp");
	const wisp = wispParam && wispParam !== "0" ? wispParam.split(",").map((s) => s.trim()).filter(Boolean) : null;
	// Worker mode by default where shared memory works (input and frames then
	// skip the worker's message queue); a default worker that failed to start
	// falls back to the page's thread for one load (boot.ts bootUpOnce()).
	const inlineOnce = takeOnce(INLINE_ONCE_KEY);
	const workerAsked = params.has("worker");
	const workerDefault = !inlineOnce && typeof SharedArrayBuffer === "function" && crossOriginIsolated === true && typeof Worker === "function";
	const workerParam = workerAsked ? params.get("worker") === "1" : workerDefault;
	// CPUs: as many as asked where the page can, never more than the host's
	// threads; by default the suggestion, in worker mode where the page can
	// boot the SMP kernel. The suggestion leaves half the threads to the host
	// (the page, the browser, other tabs): a guest CPU whose thread the host
	// deschedules stalls the others when they wait for it (.agents/status.md, SMP).
	const hc = navigator.hardwareConcurrency || 1;
	const cpuMax = Math.max(1, Math.min(MAX_CPUS, hc));
	const cap = mobile ? SUGGESTED_CPUS.mobile : /Firefox\//.test(navigator.userAgent) ? SUGGESTED_CPUS.firefox : SUGGESTED_CPUS.desktop;
	const half = Math.min(cap, Math.floor(hc / 2));
	const cpuSuggested = half >= 2 && !webkitEngine() ? Math.min(half, cpuMax) : 0;
	const smpBlocked = smpBlocker();
	const cpuDefault = !smpBlocked && workerParam && cpuSuggested ? cpuSuggested : 1;
	const smpParam = params.has("cpus") ? Math.max(1, Math.min(MAX_CPUS, Math.floor(Number(params.get("cpus"))) || 1)) : cpuDefault;
	// Once, to resume a session suspended on that many CPUs (it needs exactly its count), where the page can.
	const cpusOnce = Math.floor(Number(takeOnce(CPUS_ONCE_KEY))) || 0;
	const resumeCpus = cpusOnce > 1 && !smpBlocked && cpusOnce <= cpuMax ? cpusOnce : 0;
	// A fallback to one CPU (boot.ts bootUpOnce()), also after a failed resume on several with ?cpus=1.
	const upOnce = resumeCpus ? null : takeOnce(UP_ONCE_KEY) ?? (smpParam > 1 ? inlineOnce : null);
	const smpWhy = resumeCpus || (smpParam < 2 && !upOnce) ? null : smpBlocked ?? upOnce;
	const cpus = resumeCpus || (smpWhy ? 1 : Math.min(smpParam, cpuMax));
	// The distro: one of the images ("none": the base shell).
	const distroAsked = params.get("distro");
	let distroParam = DEFAULT_DISTRO, distroWhy: string | null = null;
	const names = DISTROS_OFFERED.map((d) => d.name);
	if (distroAsked === "none") distroParam = "none";
	else if (distroAsked && names.includes(distroAsked)) distroParam = distroAsked;
	else if (distroAsked) distroWhy = `distro ${distroAsked} is not an image of this page (${[...names, "none"].join(", ")}): booting ${DEFAULT_DISTRO}`;
	const distro = portable ? null : DISTROS_OFFERED.find((d) => d.name === distroParam) ?? null;
	if (portable) distroParam = "none";
	const autosuspend = parseAutoSuspend(params.get("autosuspend"), mobile);
	// Guest GL: on by default where the display is (the renderer loads on the guest's first GL use).
	const glAsked = params.has("gl");
	const glParam = glAsked ? params.get("gl") === "1" : glDefault(params.get("display") !== "0");
	const glBlocked = glBlocker();
	const glWhy = portable ? "disabled for a direct-root portable machine" : !glParam ? null : glBlocked ?? (GL_DISTROS.includes(distro?.name ?? "none") ? null : `guest GL needs ${GL_DISTROS.join(" or ")} (its Mesa has the virgl driver), not ${distro?.name ?? "the base shell"}`);
	const directCmdline = "console=hvc0 root=/dev/wda rw";
	return {
		portable,
		settings: Object.fromEntries(params),
		kernelUrl: kernelUrl.pathname,
		distro,
		distroParam,
		distroWhy,
		guest: portable ? "nixos" : distro?.name ?? "none",
		append: append || null,
		memMiB: fixed ? Number(memParam) : auto.mib,
		memWhy: fixed ? `set to ${memParam} MiB` : auto.why,
		memAutoMiB: auto.mib,
		memParam: fixed ? memParam : null,
		memFallbackMiB: [...DEFAULT_MEMORY_FALLBACK_MIB],
		cmdline: portable ? append || directCmdline : root ? `${append || DEFAULT_CMDLINE} kw.root=${root}` : append || DEFAULT_CMDLINE,
		baseCmdline: portable ? append || directCmdline : append || DEFAULT_CMDLINE,
		cmdlineGiven: !!append || !!root,
		net: wispParam !== "0",
		wisp: wisp?.length ? wisp : null,
		routes: url.get("routes") === "0" ? null : { ...DEFAULT_ROUTES },
		jit: params.get("jit") !== "0",
		display: params.get("display") !== "0",
		sound: params.get("sound") !== "0",
		data: portable ? true : params.get("data") !== "0",
		root,
		worker: workerParam || cpus > 1,
		workerParam,
		workerDefault,
		workerAsked,
		kernelSmpUrl: kernelSmpUrl?.pathname ?? null,
		smpParam,
		cpuDefault,
		cpus,
		resumeCpus,
		smpBlocked,
		smpWhy,
		cpuMax,
		cpuSuggested,
		shared: params.get("shared") !== "0",
		verbose: params.get("verbose") === "1",
		simulate: (url.get("simulate") || "").split(",").filter(Boolean),
		autosuspend: autosuspend.delayS,
		autosuspendParam: autosuspend.value,
		autosuspendDefault: autoSuspendDefault(mobile),
		askLeave: params.get("askleave") !== "0",
		gl: glParam && !glWhy,
		glParam,
		glAsked,
		glEager: url.get("glload") === "eager",
		glFromUrl: url.has("gl") || url.has("gpu"),
		glBlocked,
		glWhy,
		// Not settings (SETTING_NAMES): this load's URL only.
		glStrictWaits: url.get("glwait") === "strict",
		gpu: glParam && !glWhy && url.get("gpu") !== "0" && params.get("display") !== "0",
		shm: !portable && url.get("shm") !== "0",
		wlGpu: url.get("wlgpu") !== "0",
		mobile,
		coarse,
		mobileUA,
		fontSize: 14,
	};
}
