// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// createKernel({ worker: true }), the owner's side: start a worker that
// runs serveKernel() (worker-serve.ts), tell it where the kernel is, and
// proxy the console, sync, stop, stats, the disks' state, the display,
// evdev and sound over messages (worker-protocol.ts; the devices' owner
// side is worker-devices.ts). Disks and the network cross as specs
// (devices.ts) and are built in the worker. The kernel's memory is not shared;
// everything is copied or transferred, except that where SharedArrayBuffer can
// be posted (Node; cross-origin isolated pages) console and evdev input,
// frames, shm reads and vsock packets for the guest use the shared transport
// (worker-shared.ts) unless `shared: false`.
// The platform starts the worker (Platform.spawnWorker: node/worker.ts,
// web/worker.ts).

import { isDiskSpec, isNetSpec, type DiskSpec, type DiskState, type NetSpec, type SkippedDisk } from "./devices.ts";
import { distroSpecOf, readOnlySpec, type DistroInfo } from "./distro.ts";
import type { DisplayFrame, DisplayMode, DisplayOption, DisplaySize } from "./display.ts";
import type { Evdev, InputState } from "./input.ts";
import type { SoundOption, SoundState } from "./sound.ts";
import { VsockHost, type VsockStats } from "./vsock.ts";
import { ShmClient, ShmError, ShmInPlace, type ShmCall, type ShmCallResult, type ShmLocal } from "./shm.ts";
import { attachOn, connectOn, execOn, spawnOn, ttySessions, type AttachOptions, type ConnectOptions, type ExecOptions, type ExecResult, type GuestSocket, type PipeOptions, type Pty, type PtyOptions, type Subprocess, type TtySessionSnapshot } from "./tty.ts";
import { fetchOver } from "./http.ts";
import { CommandTable, type HostCommand, type parseCommands } from "./commands.ts";
import { MountTable, type FsSource, type Mount, type MountOptions, type parseMounts } from "./mounts.ts";
import type { GlHost } from "./gl.ts";
import type { GpuRenderer } from "./gl-gpu.ts";
import { FrameClient, RemoteEvdev, SoundBridge } from "./worker-devices.ts";
import { SharedOwner, newSharedControl, sharedMemoryAvailable, type KernelTransport } from "./worker-shared.ts";
import type { CreateKernelOptions, InstanceStats, KernelHandle, Platform, BootProgress, VsockOption } from "./instance.ts";
import type { ExitResult } from "./kernel.ts";
import type { ProfileReport } from "./profile.ts";
import { moduleIsMemory64 } from "./kernel.ts";
import { BootError, loadBytes, loadKernelModule, type BootFailStage, type KernelSource } from "./load.ts";
import { ConsoleRing, ConsoleRingReader, newConsoleRing } from "./console-ring.ts";
import { ConsoleOutput, errorText } from "./output.ts";
import { SnapshotCommitError, receivedSnapshot, restoreSnapshotMemory, sentSnapshot, type KernelSnapshot, type SnapshotOptions } from "./snapshot.ts";
import type { FromWorker, ToWorker, WorkerBootSpec, WorkerEndpoint, WorkerExit, WorkerSource } from "./worker-protocol.ts";

/** How long stop() waits for the worker to confirm (it first lets saves in flight commit, up to 10 s) before it ends the worker anyway. */
const STOP_GRACE_MS = 12000;
const SPEC_HINT = 'pass a spec instead: { kind: "file", path } on Node, { kind: "data", template: "bundled" } or { kind: "http", url } in browsers';
const NET_HINT = 'pass a spec instead: { kind: "net", backend: { kind: "direct" } } on Node, or { kind: "net", backend: { kind: "wisp", servers } }';
const STATS_INTERVAL_MS = 500;

/** Throws (BootError "support") if worker mode cannot run with these options on this platform. */
export function checkWorkerOptions(platform: Platform, opts: CreateKernelOptions): void {
	if (!platform.spawnWorker)
		throw new BootError("support", "createKernel({ worker: true }) is not supported on this platform");
	const objects = (opts.disks ?? []).map((d, i) => (isDiskSpec(d) ? -1 : i)).filter((i) => i >= 0);
	if (objects.length)
		throw new BootError("support", `createKernel({ worker: true }): disks[${objects.join("], disks[")}] ${objects.length > 1 ? "are BlockDevice objects, which" : "is a BlockDevice object, which"} cannot cross to the worker; ${SPEC_HINT}`);
	const d = opts.distro;
	if (d !== undefined && typeof d !== "string" && !(d instanceof URL) && !isDiskSpec(d))
		throw new BootError("support", `createKernel({ worker: true }): distro is a BlockDevice object, which cannot cross to the worker; pass its path or URL, or a spec ({ kind: "file", path } on Node, { kind: "http", url })`);
	if (opts.net && !isNetSpec(opts.net))
		throw new BootError("support", `createKernel({ worker: true }): net is a NetDevice or NetBackend object, which cannot cross to the worker; ${NET_HINT}`);
	if (typeof opts.vsock === "object" && opts.vsock.raw)
		throw new BootError("support", "createKernel({ worker: true }): vsock.raw (the guest's packets in a callback) is inline only; use vm.vsock, which works in worker mode");
}

/** Disk specs as they cross: template bytes copied into buffers to transfer, relative URLs made absolute. */
function toWorkerDisks(specs: DiskSpec[], platform: Platform): [DiskSpec[], ArrayBuffer[]] {
	const transfer: ArrayBuffer[] = [];
	const out = specs.map((s): DiskSpec => {
		if (s.kind === "data" && s.template instanceof Uint8Array) {
			const copy = s.template.slice();
			transfer.push(copy.buffer);
			return { ...s, template: copy };
		}
		if ((s.kind === "http" || s.kind === "seed") && !hasScheme(s.url)) {
			const url = platform.absoluteUrl?.(s.url);
			if (!url) throw new BootError("download", `cannot resolve the relative disk URL ${s.url} for the worker`);
			return { ...s, url };
		}
		return { ...s };
	});
	return [out, transfer];
}

/**
 * A snapshot as it crosses to the worker: its memory in a buffer to
 * transfer. Copied (slice, then transferred: about 120-170 ms for 512 MiB,
 * where a structured clone took about 340 ms; Node 24, 2026-11-15), unless
 * `transfer`, which hands over the caller's buffer (it is detached then).
 */
function toWorkerRestore(s: KernelSnapshot | undefined, transfer: boolean): [KernelSnapshot | undefined, ArrayBuffer[]] {
	if (!s) return [undefined, []];
	const m = s.memory;
	const whole = m.buffer instanceof ArrayBuffer && m.byteOffset === 0 && m.byteLength === m.buffer.byteLength;
	if (transfer && whole) return [sentSnapshot(s), [m.buffer as ArrayBuffer]];
	// A sparse copy: the snapshot's zero pages stay untouched in it.
	const memory = new Uint8Array(m.byteLength);
	restoreSnapshotMemory(memory, m, 0);
	return [sentSnapshot({ ...s, memory }), [memory.buffer as ArrayBuffer]];
}

function hasScheme(s: string): boolean {
	return /^[a-z][a-z0-9+.-]+:/i.test(s);
}

/** A kernel or initrd source as something that crosses to the worker, and what to transfer. */
async function toWorkerSource(src: KernelSource, platform: Platform, what: "kernel" | "initrd",
	onProgress: (p: BootProgress) => void, signal?: AbortSignal): Promise<[WorkerSource | WebAssembly.Module, ArrayBuffer[]]> {
	if (src instanceof WebAssembly.Module) return [src, []];
	if (src instanceof URL) return [src.href, []];
	if (typeof src === "string") {
		if (hasScheme(src)) return [src, []];
		const abs = platform.absoluteUrl?.(src) ?? (typeof location === "object" && location?.href ? new URL(src, location.href).href : undefined);
		if (!abs) throw new BootError("download", `cannot resolve the relative ${what} location ${src} for the worker`);
		return [abs, []];
	}
	// Bytes (copied into a buffer of their own, so the caller's stays usable) or a Response (read here).
	const view = src instanceof Response ? await loadBytes(src, { what, onProgress, signal })
		: src instanceof ArrayBuffer ? new Uint8Array(src) : new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
	const copy = view.slice();
	return [copy, [copy.buffer]];
}

/** The display size a `display` option asks for now (a function is called; errors are logged). */
function displayNow(opt: DisplayOption | undefined, log: (msg: string) => void): boolean | DisplaySize {
	if (typeof opt !== "function") return opt ?? false;
	try {
		const s = opt();
		return { width: s.width, height: s.height, dpi: s.dpi };
	} catch (e) {
		log(`[display] size callback failed: ${e}`);
		return true;
	}
}

/** The options WorkerKernel takes over from createKernel(). */
export interface WorkerKernelOptions {
	onOutput?: (bytes: Uint8Array) => void;
	onProgress: (p: BootProgress) => void;
	log: (msg: string) => void;
	onDiskError?: (index: number, error: unknown) => void;
	display?: DisplayOption;
	onDisplay?: (mode: DisplayMode | null) => void;
	onInput?: (state: InputState) => void;
	sound?: SoundOption;
	/** The vsock protocol runs here (VsockHost); the worker's kernel only passes packets. */
	vsock?: boolean | VsockOption;
	/** kwshm: the API (ShmClient) runs here, the calls run in the worker. */
	shm?: boolean;
	/** The shared transport's control block (worker-shared.ts), also sent in the boot spec; absent: messages. */
	shared?: SharedArrayBuffer;
	/** The console ring (console-ring.ts), also sent in the boot spec: read here. */
	console?: SharedArrayBuffer;
	/** virtio-gpu 3D: the renderer side here (gl-gpu.ts), serving the worker's "gpu" requests. */
	gpu?: GpuRenderer;
}

/**
 * A kernel running in a worker: the surface of KernelInstance, proxied over
 * messages. There is no low-level `kernel` object (it lives in the worker).
 * stats() returns the latest snapshot the worker sent (every 500 ms while
 * running, and a final one at exit) with uptimeMs brought up to date. The
 * display, evdev and sound work as inline, with the differences that a
 * thread boundary makes (worker-devices.ts): frame() returns the latest
 * frame the worker sent (readFrame() waits for a fresh one), evdev's open
 * state and return values are this thread's mirror, and a `display`
 * function is asked here, at boot, on resize() and on updateDisplaySize().
 */
export class WorkerKernel implements KernelHandle {
	/** The command line it booted with. */
	cmdline = "";
	/** The distro image (the `distro` option) as the worker read it, or undefined. */
	distro: DistroInfo | undefined = undefined;
	/** Memory actually allocated, in MiB. */
	memoryMiB = 0;
	memory64 = false;
	/** Settles when the kernel exits (see KernelInstance.exited), or 255 "fatal" if the worker dies. */
	readonly exited: Promise<ExitResult>;
	/** @internal Resolves once the kernel has started; rejects with a BootError. */
	readonly started: Promise<void>;
	#endpoint: WorkerEndpoint;
	#out = new ConsoleOutput();
	#input: WritableStream<Uint8Array | string> | undefined;
	#onOutput: ((bytes: Uint8Array) => void) | undefined;
	#onProgress: (p: BootProgress) => void;
	#log: (msg: string) => void;
	#stats: InstanceStats | undefined;
	#statsAt = 0;
	#result: ExitResult | undefined;
	#isStarted = false;
	#resolveExit!: (res: ExitResult) => void;
	#resolveStarted!: () => void;
	#rejectStarted!: (e: Error) => void;
	#syncs = new Map<number, (ok: boolean) => void>();
	#nextSync = 1;
	#disks: DiskState[] = [];
	#skipped: SkippedDisk[] = [];
	#diskOps = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	#onDiskError: ((index: number, error: Error) => void) | undefined;
	#stopTimer: ReturnType<typeof setTimeout> | undefined;
	#displayOpt: DisplayOption | undefined;
	#displaySize: string;
	#onDisplay: ((mode: DisplayMode | null) => void) | undefined;
	#onInput: ((state: InputState) => void) | undefined;
	#evdev: RemoteEvdev | undefined;
	#frames: FrameClient | undefined;
	#sound: SoundBridge | undefined;
	#soundState: SoundState | undefined;
	#shared: SharedOwner | undefined;
	#console: ConsoleRingReader | undefined;
	#encoder: TextEncoder | undefined;
	#vsock: VsockHost | undefined;
	#vsockOut: Uint8Array[] = [];
	#mounts: MountTable;
	#commands: CommandTable;
	#gl: GlHost | undefined;
	#gpu: GpuRenderer | undefined;
	#shm: ShmClient | undefined;
	#shmCalls = new Map<number, { resolve: (v: ShmCallResult) => void; reject: (e: Error) => void }>();
	#nextShm = 1;
	/** shm writes on their way: reads go as messages meanwhile, behind them. */
	#shmWrites = 0;
	/** The kernel's memory, when the worker shared it ("shm-share"): reads in place. */
	#shmInPlace: ShmInPlace | undefined;
	/** It as the ShmClient's local backend. */
	#shmLocal: ShmLocal | undefined;
	/** profile() calls waiting for "profile-result", by id; the last report, from "exit". */
	#profiles = new Map<number, (r: ProfileReport | undefined) => void>();
	#nextProfile = 1;
	#profile: ProfileReport | undefined;
	/**
	 * Snapshots asked of the worker, by id. With a commit: the snapshot the
	 * worker holds the kernel for ("snapshot-held"), the commit's signal, and
	 * whether it succeeded (the worker was told to stop).
	 */
	#snapshots = new Map<number, {
		resolve: (s: KernelSnapshot) => void; reject: (e: Error) => void;
		commit?: SnapshotOptions["commit"]; hold?: SnapshotOptions["hold"];
		held?: KernelSnapshot; abort?: AbortController; committed?: boolean; holding?: AbortController; decided?: boolean;
	}>();

	/** @internal Use createKernel({ worker: true }). */
	constructor(endpoint: WorkerEndpoint, opts: WorkerKernelOptions) {
		this.#endpoint = endpoint;
		this.#onDiskError = opts.onDiskError;
		this.#onOutput = opts.onOutput;
		this.#onProgress = opts.onProgress;
		this.#log = opts.log;
		this.#displayOpt = opts.display;
		this.#displaySize = JSON.stringify(displayNow(opts.display, opts.log));
		this.#onDisplay = opts.onDisplay;
		this.#onInput = opts.onInput;
		const post = (m: ToWorker, transfer?: ArrayBuffer[]) => { if (!this.#result) endpoint.post(m, transfer); };
		if (opts.shared) this.#shared = new SharedOwner(opts.shared, post);
		if (opts.console) {
			// Every CPU's console output, read here as it is written (console-ring.ts).
			this.#console = new ConsoleRingReader(new ConsoleRing(opts.console), (b) => this.#emit(b.bytes));
			this.#console.start();
		}
		if (opts.display) {
			this.#evdev = new RemoteEvdev(post, this.#shared);
			this.#frames = new FrameClient(post, this.#shared);
		}
		const sound = opts.sound;
		if (sound) {
			this.#soundState = { open: false, playing: false, format: null };
			if (typeof sound === "object") this.#sound = new SoundBridge(sound, post, opts.log);
		}
		if (opts.vsock) {
			// Packets for the guest, per burst: through the shared transport's
			// ring (read at the kernel's next clock read), else one message
			// (transferred), which the worker takes at the kernel's next yield.
			const flush = () => {
				const packets = this.#vsockOut;
				this.#vsockOut = [];
				if (!packets.length) return;
				if (this.#shared) this.#shared.vsock(packets);
				else post({ t: "vsock", packets }, packets.map((p) => p.buffer as ArrayBuffer));
			};
			this.#vsock = new VsockHost({
				send: (pkt) => {
					if (this.#vsockOut.push(pkt) === 1) queueMicrotask(flush);
				},
				bufferSize: typeof opts.vsock === "object" ? opts.vsock.bufferSize : undefined,
				log: opts.log,
			});
		}
		this.#mounts = new MountTable(this.#vsock, opts.log);
		this.#commands = new CommandTable(this.#vsock, opts.log);
		if (opts.gpu) {
			const gpu = opts.gpu;
			this.#gpu = gpu;
			gpu.init.then((init) => post({ t: "gpu-init", init }),
				(e: unknown) => post({ t: "gpu-init", error: (e as Error)?.message ?? String(e) }));
		}
		if (opts.shm) {
			// Reads in place where the worker shared the kernel's memory ("shm-share"); other
			// reads through the shared transport's ring (served at the kernel's next clock read);
			// everything else, and every call without the shared transport, is a round trip the
			// worker runs on its ShmDevice when the kernel next suspends (bytes transferred back).
			const message = (call: ShmCall) => new Promise<ShmCallResult>((resolve, reject) => {
				if (this.#result) {
					reject(new ShmError("ECONNABORTED", `${call.op}: the kernel exited`));
					return;
				}
				const rid = this.#nextShm++;
				this.#shmCalls.set(rid, { resolve, reject });
				post({ t: "shm", rid, call });
			});
			const inPlace = () => this.#shmLocal;
			this.#shm = new ShmClient({
				run: (call) => {
					if (call.op === "read" && !this.#shmWrites && !this.#result) {
						const ring = this.#shared?.shmRead(call.id, call.offset, call.length);
						if (ring) return ring;
					}
					if (call.op !== "write") return message(call);
					this.#shmWrites++;
					const done = message(call);
					void done.then(() => this.#shmWrites--, () => this.#shmWrites--);
					return done;
				},
				get local(): ShmLocal | undefined {
					return inPlace();
				},
			});
		}
		this.exited = new Promise((r) => (this.#resolveExit = r));
		this.started = new Promise((resolve, reject) => {
			this.#resolveStarted = resolve;
			this.#rejectStarted = reject;
		});
		endpoint.listen({
			message: (m) => this.#message(m),
			error: (e) => {
				const msg = errorText(e);
				this.#log(`[host] kernel worker error: ${msg}`);
				this.#finish({ code: 255, reason: `kernel worker error: ${(e as Error)?.message ?? e}`, kind: "fatal", error: e });
			},
			exit: () => this.#finish({ code: 255, reason: "the kernel worker exited unexpectedly", kind: "fatal" }),
		});
	}

	#message(m: FromWorker): void {
		switch (m.t) {
		case "ready":
			this.#onProgress({ stage: "worker", jspi: m.jspi });
			break;
		case "output":
			this.#emit(m.bytes);
			break;
		case "log":
			this.#log(m.msg);
			break;
		case "progress":
			this.#onProgress(m.p);
			break;
		case "started":
			this.cmdline = m.cmdline;
			this.distro = m.distro;
			this.memoryMiB = m.memoryMiB;
			this.memory64 = m.memory64;
			this.#setStats(m.stats);
			this.#disks = m.disks;
			this.#skipped = m.skipped;
			this.#isStarted = true;
			this.#resolveStarted();
			break;
		case "boot-error":
			this.#rejectStarted(new BootError(m.stage as BootFailStage, m.message));
			this.#finish({ code: 1, reason: m.message, kind: "fatal" });
			break;
		case "stats":
			this.#setStats(m.stats);
			this.#disks = m.disks;
			break;
		case "disk-error": {
			const e = Object.assign(new Error(m.error.message), { name: m.error.name, stack: m.error.stack });
			try { this.#onDiskError?.(m.index, e); } catch {}
			break;
		}
		case "disk-result": {
			const op = this.#diskOps.get(m.id);
			this.#diskOps.delete(m.id);
			if (m.ok) op?.resolve(m.value);
			else op?.reject(new Error(m.error));
			break;
		}
		case "synced":
			this.#syncs.get(m.id)?.(m.ok);
			this.#syncs.delete(m.id);
			break;
		case "display":
			this.#frames?.setMode(m.mode);
			try { this.#onDisplay?.(m.mode); } catch {}
			break;
		case "input-state":
			this.#evdev?.setMask(m.mask);
			if (this.#evdev) try { this.#onInput?.(this.#evdev.state); } catch {}
			break;
		case "frame":
			this.#frames?.receive(m.id, m.mode, m.data);
			break;
		case "frame-buffer":
			this.#frames?.adoptBuffer(m.buffer, m.cap);
			break;
		case "frame-ready":
			this.#frames?.ready(m.id);
			break;
		case "sound-state":
			this.#soundState = m.state;
			this.#sound?.onState(m.state, m.event);
			break;
		case "sound-chunk":
			this.#sound?.onChunk(m.seq, m.format, m.data);
			break;
		case "vsock":
			if (this.#vsock) for (const p of m.packets) this.#vsock.receive(p);
			break;
		case "vsock-ready":
			this.#vsock?.deviceReady(m.guestCid, m.rxMax);
			break;
		case "gpu": {
			const gpu = this.#gpu;
			if (!gpu) break;
			if (m.rid === undefined) {
				gpu.post(m.req);
				break;
			}
			const rid = m.rid;
			void Promise.resolve(gpu.call(m.req)).then((reply) => {
				if (!this.#result) this.#endpoint.post({ t: "gpu-reply", rid, reply }, reply.data ? [reply.data.buffer as ArrayBuffer] : undefined);
			});
			break;
		}
		case "gpu-start":
			this.#gpu?.start();
			break;
		case "gpu-reset":
			this.#gpu?.reset();
			break;
		case "shm-result": {
			const c = this.#shmCalls.get(m.rid);
			if (!c) break;
			this.#shmCalls.delete(m.rid);
			if (m.ok && m.place) this.#shmInPlace?.set((m.value as { id: number }).id, m.place);
			if (m.ok) c.resolve(m.value);
			else c.reject(new ShmError(m.code, m.message));
			break;
		}
		case "shm-read":
			this.#shared?.shmAnswer(m.seq, m.ok ? m.data : null, m.ok ? null : new ShmError(m.code, m.message));
			break;
		case "shm-share":
			if (this.#shm && !this.#result) {
				const ip = this.#shmInPlace = new ShmInPlace(m.memory, m.table);
				// While a write goes as a message (no current place here) nothing is read in place, so reads stay behind it.
				this.#shmLocal = {
					ready: (id) => !this.#shmWrites && ip.ready(id),
					read: (id, offset, length, out) => ip.read(id, offset, length, out),
					write: (id, offset, data) => ip.write(id, offset, data),
					views: (id, offset, length) => ip.views(id, offset, length),
				};
			}
			break;
		case "shm-attach":
			this.#shm?.update(m.info);
			break;
		case "shm-detach":
			this.#shmInPlace?.drop(m.id);
			this.#shm?.detached(m.id);
			break;
		case "snapshot-held":
			this.#commitHeld(m.id, this.#withTtys(m.snapshot));
			break;
		case "snapshot-result": {
			const w = this.#snapshots.get(m.id);
			this.#snapshots.delete(m.id);
			if (!w) break;
			// A hold not decided here ended in the worker (its kernel ended): as inline, its signal aborts.
			if (w.holding && !w.decided) w.holding.abort(new Error("the kernel has ended"));
			if (m.ok) {
				const snap = m.snapshot ? this.#withTtys(m.snapshot) : w.held;
				if (snap) w.resolve(snap);
				else w.reject(new Error("snapshot: the worker sent no snapshot"));
				break;
			}
			w.abort?.abort(new Error(m.error));
			w.reject(m.commitFailed ? new SnapshotCommitError(m.error, { timedOut: m.timedOut }) : new Error(m.error));
			break;
		}
		case "profile-result":
			this.#profiles.get(m.id)?.(m.report);
			this.#profiles.delete(m.id);
			break;
		case "exit":
			this.#setStats(m.stats);
			this.#disks = m.disks;
			this.#profile = m.profile;
			this.#finish(m.result as WorkerExit);
			break;
		}
	}

	/** @internal Loading the kernel failed before the boot message was sent: end the worker. */
	abandon(reason: string): void {
		this.started.catch(() => {});
		this.#finish({ code: 1, reason, kind: "fatal" });
	}

	#setStats(stats: InstanceStats): void {
		this.#stats = stats;
		this.#statsAt = performance.now();
	}

	#emit(bytes: Uint8Array): void {
		this.#onOutput?.(bytes);
		this.#out.emit(bytes);
	}

	#finish(res: ExitResult): void {
		if (this.#result) return;
		// What the CPUs wrote before the exit, which the worker reported after it.
		const con = this.#console;
		if (con) {
			con.take();
			con.stop();
			con.ring.close();
		}
		this.#result = res;
		clearTimeout(this.#stopTimer);
		this.#evdev?.close();
		this.#frames?.close();
		this.#shared?.close(() => new ShmError("ECONNABORTED", "read: the kernel exited"));
		this.#shmInPlace?.close();
		this.#shmLocal = undefined;
		this.#gl?.shutdown();
		this.#commands.shutdown();
		this.#mounts.shutdown();
		this.#vsock?.shutdown();
		for (const resolve of this.#profiles.values()) resolve(this.#profile);
		this.#profiles.clear();
		for (const c of this.#shmCalls.values()) c.reject(new ShmError("ECONNABORTED", "the kernel exited"));
		this.#shmCalls.clear();
		this.#shm?.shutdown();
		if (!this.#isStarted) this.#rejectStarted(new BootError("boot", res.reason, { cause: res.error }));
		this.#out.close();
		// A sync still unanswered was not confirmed by a flush (the worker answers its own
		// pending ones before "exit"; these are left when it died or did not answer).
		const persistent = this.#disks.some((d) => d.persistent);
		for (const resolve of this.#syncs.values()) resolve(!persistent);
		this.#syncs.clear();
		for (const op of this.#diskOps.values()) op.reject(new Error(`the kernel worker has ended (${res.reason})`));
		this.#diskOps.clear();
		// The worker answers every snapshot before "exit"; these are left when it died, did not
		// answer, or was ended here. One whose commit succeeded is good: the worker held the
		// kernel at the snapshot until told to stop, so it never ran past it.
		for (const w of this.#snapshots.values()) {
			if (w.committed && w.held) {
				w.holding?.abort(new Error(`the kernel worker has ended (${res.reason})`));
				w.resolve(w.held);
				continue;
			}
			const why = `the kernel worker has ended (${res.reason})`;
			w.abort?.abort(new Error(why));
			w.reject(w.held ? new SnapshotCommitError(`snapshot: not committed (${why})`) : new Error(`snapshot: ${why}`));
		}
		this.#snapshots.clear();
		this.#endpoint.terminate();
		this.#resolveExit(res);
	}

	/** Console output as a stream (see KernelInstance.output). */
	get output(): ReadableStream<Uint8Array> {
		return this.#out.stream;
	}

	/** Call `listener` with console output from now on. Returns the unsubscribe function. */
	onOutput(listener: (bytes: Uint8Array) => void): () => void {
		return this.#out.listen(listener);
	}

	/** Type into the console (bytes, or text encoded as UTF-8); "\n" or "\r" is Enter. */
	write(data: Uint8Array | string): void {
		if (this.#result) return;
		if (typeof data !== "string" && !data.length) return;
		if (this.#shared) this.#shared.writeConsole(typeof data === "string" ? (this.#encoder ??= new TextEncoder()).encode(data) : data.slice());
		else this.#endpoint.post({ t: "input", data });
	}

	/**
	 * How console and evdev input, frames, shm reads and vsock packets for
	 * the guest reach the worker: "shared" (SharedArrayBuffers, read by the
	 * worker while the kernel runs, within about a millisecond) or "messages"
	 * (handled when the kernel yields, up to 20 ms while the guest is busy).
	 * Everything else is messages either way.
	 */
	get transport(): KernelTransport {
		return this.#shared ? "shared" : "messages";
	}

	/** Console input as a stream. */
	get input(): WritableStream<Uint8Array | string> {
		return (this.#input ??= new WritableStream<Uint8Array | string>({
			write: (chunk) => this.write(chunk),
		}));
	}

	/** Set the console window size; the guest's foreground process gets SIGWINCH. */
	resize(cols: number, rows: number): void {
		if (this.#result) return;
		// Shared: with the console input, so that what is typed after a resize sees it.
		if (this.#shared) this.#shared.resize(cols, rows);
		else this.#endpoint.post({ t: "resize", cols, rows });
		if (typeof this.#displayOpt === "function") this.#sendDisplaySize(false);
	}

	/**
	 * See KernelHandle.updateDisplaySize(): a `display` function is asked
	 * here (inline the kernel calls it itself when it needs a size; the
	 * worker cannot), and the size goes to the worker, which answers kwfb's
	 * next first open with it and lets virtio-gpu offer it. resize() sends a
	 * function's new size too, for kwfb only.
	 */
	updateDisplaySize(size?: DisplaySize): void {
		if (this.#result || !this.#displayOpt) return;
		if (size) this.#displayOpt = { width: size.width, height: size.height, dpi: size.dpi };
		this.#sendDisplaySize(true);
	}

	/** Send the size wanted now when it changed, or with `hotplug` always (the device compares it with what its driver read). */
	#sendDisplaySize(hotplug: boolean): void {
		const size = displayNow(this.#displayOpt, this.#log);
		if (typeof size !== "object") return;
		const key = JSON.stringify(size);
		if (key === this.#displaySize && !hotplug) return;
		this.#displaySize = key;
		this.#endpoint.post({ t: "display-size", size, hotplug });
	}

	/** @internal The display option as it goes in the boot message. */
	get bootDisplay(): boolean | DisplaySize {
		return this.#displayOpt ? JSON.parse(this.#displaySize) as boolean | DisplaySize : false;
	}

	/**
	 * The keyboard, mouse and tablet (with the display option): InputHost's
	 * methods, forwarded to the worker in order. The open state is a mirror
	 * of the worker's (reported with onInput), so it may lag by a yield.
	 */
	get evdev(): Evdev | undefined {
		return this.#evdev;
	}

	/** With the display option: the mode while a program has /dev/fb0 open (as last reported), else null. */
	get display(): { readonly mode: DisplayMode | null } | undefined {
		const f = this.#frames;
		return f ? { get mode() { return f.mode; } } : undefined;
	}

	/**
	 * The latest frame the worker sent, as RGBA (see KernelInstance.frame()),
	 * or null with no display, while no program has it open, or before the
	 * first frame arrived. Each call also asks for a newer one (at most two
	 * requests are outstanding; the worker answers once the picture may have
	 * changed). Compare frameSeq to skip repainting an unchanged frame.
	 */
	frame(out?: Uint8ClampedArray): DisplayFrame | null {
		// A 3D resource on virtio-gpu's scanout: read back from the renderer, which is here.
		if (this.#gpu?.scanout) return this.#gpu.frame(out);
		return this.#frames?.frame(out) ?? null;
	}

	/** Ask for a newer frame without converting the current one (see frame()). */
	requestFrame(): void {
		this.#frames?.request();
	}

	/** Counts frames received with new pixels: frame() has something new when it changed. */
	get frameSeq(): number {
		return this.#frames?.seq ?? 0;
	}

	/** A fresh frame: a round trip to the worker (with messages at most about 20 ms while the guest is busy; shared, about a millisecond). */
	readFrame(out?: Uint8ClampedArray): Promise<DisplayFrame | null> {
		if (this.#gpu?.scanout) return Promise.resolve(this.#gpu.frame(out));
		return this.#frames?.read(out) ?? Promise.resolve(null);
	}

	/**
	 * With the vsock option: listen() and connect() as inline (VsockHost).
	 * The protocol runs on this thread; the packets for the guest cross to
	 * the worker through the shared transport's ring (taken at the kernel's
	 * next clock read, about a millisecond) or, without it, as messages,
	 * which it takes while the kernel is suspended (up to 20 ms while the
	 * guest is busy); the guest's come back as messages, posted at the
	 * kernel's next task switch or yield.
	 */
	get vsock(): VsockHost | undefined {
		return this.#vsock;
	}

	/** A program on its own pty or on pipes, and exec(), as inline (tty.ts; the protocol runs on this thread). */
	spawn(file: string | undefined, args: readonly string[] | undefined, opts: PipeOptions): Promise<Subprocess>;
	spawn(file?: string, args?: readonly string[], opts?: PtyOptions): Promise<Pty>;
	spawn(file?: string, args?: readonly string[], opts?: PtyOptions | PipeOptions): Promise<Pty | Subprocess> {
		return this.#mounts.gate(() => this.#commands.gate(() => spawnOn(this.#vsock, file, args, opts)));
	}

	/** Take over a detachable session, as inline (tty.ts attachPty(); the protocol runs on this thread). */
	attach(session: string | TtySessionSnapshot, opts?: AttachOptions): Promise<Pty> {
		return attachOn(this.#vsock, session, opts);
	}

	/**
	 * The detachable sessions open here, added to a snapshot from the worker
	 * (whose kernel only passes the packets). The kernel is at its snapshot
	 * point or stopped there, and the exit that ends these Ptys comes after
	 * the snapshot's answer, so they are the ones it has.
	 */
	#withTtys(received: KernelSnapshot): KernelSnapshot {
		const snap = receivedSnapshot(received);
		const ttys = ttySessions(this.#vsock);
		if (ttys.length) snap.ttys = ttys;
		return snap;
	}

	exec(file: string, args?: readonly string[], opts?: ExecOptions & { encoding?: "utf8" }): Promise<ExecResult<string>>;
	exec(file: string, args: readonly string[] | undefined, opts: ExecOptions & { encoding: "buffer" }): Promise<ExecResult<Uint8Array>>;
	exec(file: string, args?: readonly string[], opts?: ExecOptions): Promise<ExecResult<string | Uint8Array>> {
		return this.#mounts.gate(() => this.#commands.gate(() => execOn(this.#vsock, file, args, opts)));
	}

	/** A raw byte stream to a TCP server on the guest's loopback, as inline (kwtty's CONNECT; the protocol runs on this thread). */
	connect(port: number, opts?: ConnectOptions): Promise<GuestSocket> {
		return this.#mounts.gate(() => this.#commands.gate(() => connectOn(this.#vsock, port, opts)));
	}

	/** HTTP/1.1 to a server on the guest's loopback, as inline (http.ts over connect()). */
	fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
		return fetchOver((port, o) => this.connect(port, o), input, init);
	}

	/** Host file systems in the guest, as inline (mounts.ts): the 9p server and the handlers run on this thread. */
	mount(path: string, fs: FsSource, opts?: MountOptions): Promise<Mount> {
		return this.#mounts.mount(path, fs, opts);
	}

	get mounts(): ReadonlyMap<string, Mount> {
		return this.#mounts.mounts;
	}

	/** @internal createKernel's `mounts`, once the kernel runs. */
	startMounts(list: ReturnType<typeof parseMounts>): void {
		this.#mounts.mountAll(list);
	}

	/** Host commands, as inline (commands.ts): the handlers run on this thread. */
	addCommand(name: string, handler: HostCommand, opts?: { timeout?: number }): Promise<void> {
		return this.#commands.add(name, handler, opts);
	}

	removeCommand(name: string, opts?: { timeout?: number }): Promise<void> {
		return this.#commands.remove(name, opts);
	}

	get commands(): ReadonlyMap<string, HostCommand> {
		return this.#commands.commands;
	}

	/** @internal createKernel's `commands`, once the kernel runs. */
	startCommands(list: ReturnType<typeof parseCommands>): void {
		this.#commands.addAll(list);
	}

	/** @internal createKernel's `gl`, once the kernel runs: served on this thread, as vsock is. */
	attachGl(gl: GlHost | undefined): void {
		this.#gl = gl;
		if (gl && this.#result) gl.shutdown();
	}

	/** With the gl option: the GL renderer's host side (gl.ts), on this thread as inline. */
	get gl(): GlHost | undefined {
		return this.#gl;
	}

	/**
	 * With the shm option: open(), create() and openId() as inline. Each call
	 * is a round trip to the worker, which runs it when the kernel next
	 * suspends (up to 20 ms while the guest is busy), except reads: in place
	 * on this thread where the worker shared the kernel's memory (an SMP
	 * kernel with the shared transport: inPlace, readSync() and views() as
	 * inline), else with the shared transport at the kernel's next clock read
	 * (worker-shared.ts), else as a round trip; the worker copies and
	 * transfers the bytes.
	 */
	get shm(): ShmClient | undefined {
		return this.#shm;
	}

	/** With the sound option: the playback state, as the worker last reported it. */
	get sound(): { readonly state: SoundState; readonly playing: boolean } | undefined {
		const s = this.#soundState;
		return s ? { state: s, playing: s.playing } : undefined;
	}

	/**
	 * See KernelInstance.sync(): a round trip to the worker, which raises
	 * the sync IRQ and waits for every persistent disk to complete a flush
	 * issued after it (true), or `timeout` ms (false). A request still
	 * open when the kernel exits or the worker dies resolves false if a
	 * persistent disk was attached (nothing confirmed it), else true. After
	 * the exit it resolves true at once: the worker reported the exit only
	 * after the saves in flight had settled.
	 */
	sync(opts: { timeout?: number } = {}): Promise<boolean> {
		if (this.#result) return Promise.resolve(true);
		const id = this.#nextSync++;
		return new Promise((resolve) => {
			this.#syncs.set(id, resolve);
			this.#endpoint.post({ t: "sync", id, timeout: opts.timeout });
		});
	}

	/**
	 * Save the machine, as KernelInstance.snapshot(): the worker takes the
	 * snapshot and transfers it here (its memory is not copied again).
	 * Resume it with createKernel({ restore }), in worker mode or inline.
	 * Rejects while host file systems are mounted, as inline.
	 */
	snapshot(opts: SnapshotOptions = {}): Promise<KernelSnapshot> {
		if (this.#result) return Promise.reject(new Error(`snapshot: the kernel has exited (${this.#result.reason})`));
		const why = this.#mounts.snapshotBlocker();
		if (why) return Promise.reject(new Error(`snapshot: ${why}`));
		const { commit, hold } = opts;
		if (commit !== undefined && typeof commit !== "function") return Promise.reject(new TypeError("snapshot: commit must be a function"));
		if (hold !== undefined && (typeof hold !== "function" || !commit)) return Promise.reject(new TypeError("snapshot: hold must be a function, and needs commit"));
		const id = this.#nextSync++;
		return new Promise((resolve, reject) => {
			this.#snapshots.set(id, { resolve, reject, commit, hold });
			const drop = opts.dropCaches === undefined ? {} : { dropCaches: opts.dropCaches };
			this.#endpoint.post(commit ? { t: "snapshot", id, commit: true, commitTimeoutMs: opts.commitTimeoutMs, ...(hold ? { hold: true } : {}), ...drop } : { t: "snapshot", id, stop: opts.stop, ...drop });
		});
	}

	/**
	 * snapshot({ commit }): the worker holds the kernel at its consistent
	 * point with `snap`; run the commit here and tell the worker how it went.
	 * The worker's timeout (commitTimeoutMs) may give the snapshot up first:
	 * its "snapshot-result" then aborts the signal.
	 */
	#commitHeld(id: number, snap: KernelSnapshot): void {
		const w = this.#snapshots.get(id);
		if (!w?.commit) return;
		w.held = snap;
		const abort = (w.abort = new AbortController());
		void Promise.resolve().then(() => w.commit!(snap, abort.signal)).then(() => {
			if (abort.signal.aborted || this.#result) return; // given up meanwhile (the worker's timeout, the exit)
			w.committed = true;
			this.#endpoint.post({ t: "snapshot-commit", id, ok: true });
			if (!w.hold) return;
			// The worker holds the kernel (no timeout) until told; the exit aborts `holding`.
			const holding = (w.holding = new AbortController());
			void Promise.resolve().then(() => w.hold!(snap, holding.signal)).then((how): string => how, (e: unknown) => {
				this.#log(`[host] snapshot: the hold failed (${(e as Error)?.message ?? e}); stopping at the snapshot`);
				return "stop";
			}).then((how) => {
				w.decided = true;
				if (!this.#result && !holding.signal.aborted) this.#endpoint.post({ t: "snapshot-release", id, stop: how !== "continue" });
			});
		}, (e: unknown) => {
			if (!this.#result) this.#endpoint.post({ t: "snapshot-commit", id, ok: false, error: (e as Error)?.message ?? String(e) });
		});
	}

	/**
	 * Stop the kernel now (see KernelInstance.stop()). The worker confirms
	 * and is then ended; if it does not answer within 2 s it is ended anyway.
	 */
	stop(res: { code?: number; reason?: string } = {}): Promise<ExitResult> {
		if (!this.#result && this.#stopTimer === undefined) {
			this.#endpoint.post({ t: "stop", code: res.code, reason: res.reason });
			this.#stopTimer = setTimeout(() => this.#finish({ code: res.code ?? 0, reason: res.reason ?? "stopped by the host", kind: "stopped" }), STOP_GRACE_MS);
		}
		return this.exited;
	}

	/**
	 * The disks' state as of the latest snapshot (every 500 ms, and final at
	 * exit): flags, flush count, and for a CowDisk its overlay, store and
	 * counters. Indexed as the `disks` option; see skippedDisks for the
	 * optional ones left out.
	 */
	get disks(): readonly DiskState[] {
		return this.#disks;
	}

	/** Disks whose spec was optional and could not be built, and why. */
	get skippedDisks(): readonly SkippedDisk[] {
		return this.#skipped;
	}

	#diskOp(index: number, op: "detach" | "export"): Promise<unknown> {
		if (this.#result) return Promise.reject(new Error(`the kernel has exited (${this.#result.reason})`));
		const id = this.#nextSync++;
		return new Promise((resolve, reject) => {
			this.#diskOps.set(id, { resolve, reject });
			this.#endpoint.post({ t: "disk", id, index, op });
		});
	}

	/**
	 * Stop disk `index` (a CowDisk with a store) saving: the worker detaches
	 * it, waits for the save in flight and closes its store, so this thread
	 * may then replace or clear the store (the guest's later writes stay in
	 * the worker's memory). Rejects if the kernel has exited.
	 */
	async detachDisk(index: number): Promise<void> {
		await this.#diskOp(index, "detach");
	}

	/** Disk `index`'s current content as a kwsparse image in parts (CowDisk.exportParts(); gzipBlob() compresses them). */
	exportDisk(index: number): Promise<{ size: number; blocks: number; parts: BlobPart[] }> {
		return this.#diskOp(index, "export") as Promise<{ size: number; blocks: number; parts: BlobPart[] }>;
	}

	/** With the profile option: the samples so far (a round trip), or after the exit the worker's last report. */
	profile(): Promise<ProfileReport | undefined> {
		if (this.#result) return Promise.resolve(this.#profile);
		const id = this.#nextProfile++;
		return new Promise((resolve) => {
			this.#profiles.set(id, resolve);
			this.#endpoint.post({ t: "profile", id });
		});
	}

	/** The latest snapshot from the worker, with uptimeMs brought up to date while it runs. */
	stats(): InstanceStats {
		const s = this.#stats!;
		const vsock: VsockStats | undefined = this.#vsock ? { ...this.#vsock.stats } : undefined;
		return { ...s, vsock, shm: this.#shm?.stats, uptimeMs: this.#result || !s.uptimeMs ? s.uptimeMs : s.uptimeMs + performance.now() - this.#statsAt };
	}
}

/**
 * createKernelOn() with opts.worker: checkWorkerOptions() has passed.
 * The worker starts first, so its startup overlaps loading the kernel
 * here: by default this thread downloads (or reads) and compiles it, the
 * engine compiling off-thread while it streams, and posts the
 * WebAssembly.Module; with `compileInWorker` the worker loads it. Measured
 * on 2026-11-14 (.agents/js.md, Worker mode), compiling here started the
 * kernel about 20 ms sooner on Node.
 */
export async function createKernelInWorker(platform: Platform, opts: CreateKernelOptions & { compileInWorker?: boolean; shared?: boolean; transferRestore?: boolean }, progress: (p: BootProgress) => void, gpu?: GpuRenderer): Promise<WorkerKernel> {
	const { signal } = opts;
	const src = opts.kernel ?? platform.defaultKernel();
	const compileHere = !opts.compileInWorker && !(src instanceof WebAssembly.Module);
	const log = opts.log ?? ((m: string) => console.error(m));
	const canShare = opts.shared !== false && sharedMemoryAvailable();
	if (opts.shared === true && !canShare)
		throw new BootError("support", "createKernel({ worker: true, shared: true }): SharedArrayBuffer cannot be used here (a browser page must be cross-origin isolated: COOP same-origin and COEP require-corp)");
	const shared = canShare ? newSharedControl() : undefined;
	// More than one CPU: their console output comes here through a shared ring (unused if the kernel gets one CPU).
	const consoleRing = shared && (opts.cpus ?? 1) > 1 ? newConsoleRing() : undefined;
	const endpoint = platform.spawnWorker!();
	const vm = new WorkerKernel(endpoint, {
		onOutput: opts.onOutput, onProgress: progress, log, onDiskError: opts.onDiskError,
		display: opts.display ?? (opts.gpu ? true : undefined), onDisplay: opts.onDisplay, onInput: opts.onInput, sound: opts.sound, vsock: opts.vsock ?? true, shm: opts.shm, shared,
		console: consoleRing, gpu,
	});
	let spec: WorkerBootSpec, transfer: ArrayBuffer[];
	try {
		let kernel: WorkerSource | WebAssembly.Module, kernelTransfer: ArrayBuffer[] = [], compileMs: number | undefined;
		if (compileHere) {
			const t0 = performance.now();
			progress({ stage: "compile" });
			kernel = await loadKernelModule(src, { what: "kernel", readFile: platform.readFile, onProgress: progress, signal, smp: (opts.cpus ?? 1) > 1 });
			compileMs = performance.now() - t0;
			progress({ stage: "compiled", ms: compileMs, memory64: moduleIsMemory64(kernel) });
		} else [kernel, kernelTransfer] = await toWorkerSource(src, platform, "kernel", progress, signal);
		const [initrd, initrdTransfer] = opts.initrd == null ? [opts.initrd, []]
			: await toWorkerSource(opts.initrd, platform, "initrd", progress, signal);
		if (initrd instanceof WebAssembly.Module) throw new BootError("download", "initrd: a WebAssembly.Module is not an initramfs");
		if (signal?.aborted) throw new BootError("download", "aborted", { cause: signal.reason });
		const [disks, diskTransfer] = toWorkerDisks((opts.disks ?? []) as DiskSpec[], platform);
		// The distro as a spec, made here (a relative URL against this page) and read-only.
		const distro = opts.distro === undefined ? undefined
			: toWorkerDisks([typeof opts.distro === "string" || opts.distro instanceof URL
				? distroSpecOf(opts.distro, platform.distroSpec) : readOnlySpec(opts.distro as DiskSpec)], platform)[0][0];
		const [restore, restoreTransfer] = toWorkerRestore(opts.restore, !!opts.transferRestore);
		spec = {
			kernel, initrd, disks, distro, net: opts.net as NetSpec | undefined,
			cmdline: opts.cmdline,
			memoryMiB: opts.memoryMiB ?? platform.defaultMemoryMiB?.() ?? 2048,
			memoryFallbackMiB: opts.memoryFallbackMiB ?? platform.defaultMemoryFallbackMiB,
			memory64: opts.memory64,
			jit: opts.jit,
			cpus: opts.cpus,
			consoleSize: opts.consoleSize,
			statsIntervalMs: STATS_INTERVAL_MS,
			compileMs,
			display: vm.bootDisplay,
			sound: opts.sound ? { rate: typeof opts.sound === "object" ? opts.sound.rate : undefined, chunks: typeof opts.sound === "object" && !!opts.sound.onChunk } : false,
			vsock: !!(opts.vsock ?? true),
			shm: !!opts.shm,
			gpu: gpu ? "virgl" : !!opts.gpu,
			shared,
			console: consoleRing,
			restore,
			profile: opts.profile === true ? {} : opts.profile || undefined,
		};
		transfer = [...kernelTransfer, ...initrdTransfer, ...diskTransfer, ...restoreTransfer];
	} catch (e) {
		vm.abandon((e as Error)?.message ?? String(e));
		throw e;
	}
	if (signal) {
		const onAbort = () => endpoint.post({ t: "abort" });
		signal.addEventListener("abort", onAbort, { once: true });
		void vm.exited.then(() => signal.removeEventListener("abort", onAbort));
	}
	try {
		endpoint.post({ t: "boot", spec }, transfer);
	} catch (e) {
		// An engine that cannot post a WebAssembly.Module to a worker: let the worker load the kernel.
		const retry = compileHere && (typeof src === "string" || src instanceof URL || src instanceof ArrayBuffer || ArrayBuffer.isView(src));
		if (!retry) {
			vm.abandon((e as Error)?.message ?? String(e));
			throw new BootError("support", `cannot send the kernel to the worker: ${(e as Error)?.message ?? e}`, { cause: e });
		}
		log(`[host] the compiled kernel could not be posted to the worker (${(e as Error)?.message ?? e}); the worker loads it itself`);
		try {
			const [kernel, kernelTransfer] = await toWorkerSource(src, platform, "kernel", progress, signal);
			endpoint.post({ t: "boot", spec: { ...spec, kernel, compileMs: undefined } }, [...transfer, ...kernelTransfer]);
		} catch (e2) {
			vm.abandon((e2 as Error)?.message ?? String(e2));
			throw e2;
		}
	}
	await vm.started;
	return vm;
}
