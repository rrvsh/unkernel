// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The guest's display over the terminal (display.ts has the state and the
// keyboard routing):
// - a layer (#fb-layer) over the stage while a program has /dev/fb0 open;
//   on touch devices with the page portrait it is turned a quarter turn
//   clockwise and covers the whole page, status line included (the rotate
//   option, off by default: display.ts), so the phone is held sideways.
//   Pointer positions are turned back into the layer's own frame (unturn(),
//   localPos());
// - a canvas (#fb) in it, scaled to fit with the aspect ratio kept (by an
//   integer when that loses little, so pixels stay sharp; letterboxed on the
//   backdrop), relaid out when the layer changes size (resize, rotation: the
//   mode stays), and repainted from the guest's pixels once per animation
//   frame (the SDK's frame(); the guest is suspended whenever this runs). In
//   worker mode frame() is the latest frame the worker sent (or put in the
//   shared frame buffer): it is painted only when frameSeq says it is new,
//   and each animation frame asks for the next. While a GL client has
//   virtio-gpu's scanout (gl and gpu: the Guest GL option), the
//   picture is the renderer's latest frame (gl.gpu.drawFrame(): an
//   ImageBitmap of its WebGL2 canvas, no readback), in both modes;
// - mouse, absolute: while a program has the tablet (event2) open, e.g. X,
//   the pointer over the canvas is sent as absolute positions (the canvas's
//   on-screen rectangle is the whole picture), buttons and the wheel go to
//   the tablet, the host cursor is hidden over the picture (the guest draws
//   its own), and nothing locks. A drag keeps going outside it (pointer
//   capture) and ends at the release. This wins when a program has both
//   mice open;
// - mouse, relative: otherwise, with the evdev mouse open (games), a click
//   on the canvas takes pointer lock (desktop); motion, buttons and the
//   wheel then go to the guest. Esc leaves pointer lock, as the browser
//   does it;
// - on touch devices, while the display is shown, an overlay (#pad) over the
//   picture: a stick bottom left (a knob that follows the thumb; 8-way
//   arrow keys); game controller buttons bottom right, in a
//   layout picked with the chip at the top right (ABXY with Select and
//   Start, or a grid of keys); face buttons show the letter and,
//   tiny, the key they send;
//   a chip brings up the phone's keyboard (a hidden input; what it gains
//   and loses is typed: key presses while a program reads the keyboard,
//   else into the terminal), with the terminal's key bar (Keys.tsx) above
//   it, its keys pressed the same way;
//   a chip hides the stick and buttons (a demo, or a desktop driven by
//   touch; kept in localStorage), leaving the chips;
//   at the top right also full screen (iPhone Safari has none: the chip
//   says how to add the page to the home screen instead, see display.ts), the rotate toggle (portrait pages), "tty" while
//   rotated (the status line is covered). The Keys layout has every key.
//   While a program reads a mouse, the whole layer under the
//   controls (#fb-touch, letterbox included) takes touches: with the
//   tablet open in "mouse" mode the pointer goes where the finger is (tap =
//   left click there), in "trackpad" mode a drag moves it from where it is
//   (tap = left click); the chip at the top right switches, and is kept in
//   localStorage. With only the relative mouse open it is always a
//   trackpad. With no program reading evdev, the buttons type the
//   equivalent terminal input instead (arrows, Enter, Esc, Space, Tab, y,
//   n), with key repeat, for programs that read the tty.
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { displayOpts, evdev, isRotated, pointerLocked, setControls, setDisplayShown, setPadLayout, setRotate, setTouchMode, offerFullscreen, toggleFullscreen, useFullscreen, type DisplayUiOptions } from "../display.ts";
import { KW } from "../kw.ts";
import { BTN_LEFT, BTN_MIDDLE, BTN_RIGHT, KernelInstance, domButtonToLinux, domCodeToLinux } from "../sdk.ts";
import { ui$, useStore, type PadLayout, type TouchMode } from "../store.ts";
import { Keys } from "./Keys.tsx";

/** PointerEvent.buttons bits and their evdev buttons. */
const BUTTON_BITS: Array<[number, number]> = [[1, BTN_LEFT], [2, BTN_RIGHT], [4, BTN_MIDDLE]];
/**
 * The soft keyboard: the key, and whether Shift is held, for each character
 * (a US layout, as DOM_CODE_TO_LINUX assumes). Others reach only the terminal.
 */
const CHAR_KEY: ReadonlyMap<string, [number, boolean]> = (() => {
	const m = new Map<string, [number, boolean]>();
	const pair = (code: number, plain: string, shifted: string) => { m.set(plain, [code, false]); m.set(shifted, [code, true]); };
	"1234567890".split("").forEach((d, i) => pair(2 + i, d, "!@#$%^&*()"[i]!));
	for (const c of "abcdefghijklmnopqrstuvwxyz") pair(domCodeToLinux(`Key${c.toUpperCase()}`)!, c, c.toUpperCase());
	for (const [code, a, b] of [[12, "-", "_"], [13, "=", "+"], [26, "[", "{"], [27, "]", "}"], [39, ";", ":"], [40, "'", '"'], [41, "`", "~"], [43, "\\", "|"], [51, ",", "<"], [52, ".", ">"], [53, "/", "?"]] as const) pair(code, a, b);
	m.set(" ", [57, false]).set("\t", [15, false]).set("\n", [28, false]);
	return m;
})();
/** What the soft keyboard's input holds between edits, so a Backspace always has something to delete. */
const SENTINEL = "__";

const KEY = { up: 103, down: 108, left: 105, right: 106, ctrl: 29, space: 57, enter: 28, esc: 1, shift: 42, alt: 56, tab: 15, y: 21, n: 49 };

/** The element's content size, kept up to date. */
export function useSize(el: HTMLElement | null): { w: number; h: number } {
	const [size, setSize] = useState({ w: el?.clientWidth ?? 0, h: el?.clientHeight ?? 0 });
	useEffect(() => {
		if (!el) return;
		const read = () => setSize((s) => (s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight }));
		read();
		if (typeof ResizeObserver !== "function") {
			addEventListener("resize", read);
			return () => removeEventListener("resize", read);
		}
		const ro = new ResizeObserver(read);
		ro.observe(el);
		return () => ro.disconnect();
	}, [el]);
	return size;
}

// ---- the rotated frame ------------------------------------------------------
// The rotated layer is turned a quarter turn clockwise: a vector (x, y) in
// it is (-y, x) on the screen, so one on the screen (x, y) is (y, -x) in it.
const unturn = (rot: boolean, dx: number, dy: number): [number, number] => (rot ? [dy, -dx] : [dx, dy]);

/** A pointer's position on an element of the layer, 0..1 across its own (untransformed) box. */
function localPos(el: HTMLElement, rot: boolean, e: { clientX: number; clientY: number }): { x: number; y: number } {
	const r = el.getBoundingClientRect(); // its centre is the same either way
	const [dx, dy] = unturn(rot, e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
	return { x: dx / Math.max(1, el.offsetWidth) + 0.5, y: dy / Math.max(1, el.offsetHeight) + 0.5 };
}

// ---- pointer helpers ----------------------------------------------------------
/** Where the absolute pointer is, 0..1: trackpad mode moves it from here. */
const tabletPos = { x: 0.5, y: 0.5 };
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const aim = (x: number, y: number) => {
	tabletPos.x = x;
	tabletPos.y = y;
	evdev()?.moveTo(x, y);
};
/** A short left click: the tablet's while a program reads it, else the mouse's. */
function tapClick(): void {
	const ev = evdev();
	if (ev?.tabletOpen) {
		if (ev.tabletButton(BTN_LEFT, true)) setTimeout(() => ev.tabletButton(BTN_LEFT, false), 40);
	} else if (ev?.button(BTN_LEFT, true)) setTimeout(() => ev.button(BTN_LEFT, false), 40);
}
/** A finger that moved less than this (px) within TAP_MS is a tap. */
const TAP_PX = 10, TAP_MS = 250;
/** Trackpad speed: picture pixels per CSS pixel the finger moves, times the picture's scale. */
const TRACK_GAIN = 1.5;

export function Display({ stage }: { stage: HTMLElement | null }) {
	const d = useStore((s) => s.display);
	const opts = displayOpts();
	const app = stage?.closest<HTMLElement>("#app") ?? null;
	const st = useSize(stage), ap = useSize(app);
	const visible = !!opts && d.attached && d.shown;
	// Touch: close the on-screen keyboard (the terminal had the focus), so the
	// picture gets the whole screen at once.
	useEffect(() => {
		const focused = document.activeElement as HTMLElement | null;
		if (visible && opts?.touch && focused?.closest?.("#terms")) focused.blur();
	}, [visible, opts]);
	if (!opts || !visible) return null;
	// Over the stage, or turned over the whole page (#app; the layer is absolute in it).
	const rot = isRotated(ap.w, ap.h);
	const w = rot ? ap.h : st.w, h = rot ? ap.w : st.h;
	// Padding for the controls: the safe areas of the edges each side is on.
	const style = (rot
		? {
			width: w, height: h, transformOrigin: "0 0", transform: `translateX(${ap.w}px) rotate(90deg)`,
			"--pl": "max(12px, var(--st))", "--pr": "max(12px, var(--sb))", "--pt": "max(8px, var(--sr))", "--pb": "max(12px, var(--sl))",
		}
		: { width: w, height: h, "--pl": "max(12px, var(--sl))", "--pr": "max(12px, var(--sr))", "--pt": "max(8px, var(--st))", "--pb": "12px" }) as unknown as CSSProperties;
	return (
		<div id="fb-layer" data-rotated={rot || undefined} className="absolute top-0 left-0 z-10 overflow-hidden" style={style}>
			<Backdrop opts={opts} opaque={rot} />
			<Picture opts={opts} aw={w} ah={h} rot={rot} width={d.width} height={d.height} mouse={d.mouse} tablet={d.tablet} touchMode={d.touchMode} />
			{opts.touch && (
				<Pad opts={opts} rot={rot} portrait={ap.h > ap.w} rotate={d.rotate} layout={d.layout} tablet={d.tablet} touchMode={d.touchMode} controls={d.controls} />
			)}
		</div>
	);
}

// ---- backdrop -----------------------------------------------------------------
// Behind the canvas (and the touch controls), over the terminal, while the
// display is shown: it takes every pointer, touch and wheel event that
// misses the picture or a control, so nothing selects terminal text,
// scrolls it, or focuses it (which would bring up a phone's keyboard).
// On desktop a click on it focuses the terminal without selecting
// anything, so the shell stays usable while a program holds the display.
// Opaque while rotated: sideways terminal text behind the picture is noise.
function Backdrop({ opts, opaque }: { opts: DisplayUiOptions; opaque: boolean }) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const b = ref.current!;
		const cancel = (e: Event) => { if (e.cancelable) e.preventDefault(); };
		// Native listeners: React's wheel and touchmove listeners are passive.
		b.addEventListener("wheel", cancel, { passive: false });
		b.addEventListener("touchmove", cancel, { passive: false });
		b.addEventListener("selectstart", cancel);
		return () => {
			b.removeEventListener("wheel", cancel);
			b.removeEventListener("touchmove", cancel);
			b.removeEventListener("selectstart", cancel);
		};
	}, []);
	return (
		<div
			ref={ref}
			id="fb-backdrop"
			className={`absolute inset-0 z-2 touch-none select-none [-webkit-tap-highlight-color:transparent] [-webkit-touch-callout:none] ${opaque ? "bg-black" : "bg-black/85"}`}
			onPointerDown={(e) => {
				e.preventDefault(); // no selection, no focus change
				if (!opts.touch && e.pointerType === "mouse") opts.focusTerminal();
			}}
			onContextMenu={(e) => e.preventDefault()}
			onDoubleClick={(e) => e.preventDefault()}
		/>
	);
}

// ---- picture ------------------------------------------------------------------
function Picture({ opts, aw, ah, rot, width, height, mouse, tablet, touchMode }: {
	opts: DisplayUiOptions; aw: number; ah: number; rot: boolean; width: number; height: number; mouse: boolean; tablet: boolean; touchMode: TouchMode;
}) {
	const ref = useRef<HTMLCanvasElement>(null);
	const absolute = () => !!evdev()?.tabletOpen;

	// Repaint once per animation frame while the guest has the display open.
	useEffect(() => {
		const c = ref.current!;
		const image = new ImageData(width, height);
		const ctx = c.getContext("2d")!;
		let raf = 0, shown = -1, glForce = true;
		const paint = () => {
			raf = 0;
			const vm = opts.vm();
			if (!vm) return;
			// A GL client on virtio-gpu's scanout (gl and gpu): its latest frame
			// comes from the renderer on this thread, drawn without a readback;
			// null when no 3D resource is on the scanout.
			const gl = vm.gl?.gpu?.drawFrame(ctx, glForce);
			if (gl !== undefined && gl !== null) {
				if (gl) glForce = false;
			} else if (vm instanceof KernelInstance) {
				if (vm.kernel.result) return;
				if (!vm.frame(image.data)) return;
				ctx.putImageData(image, 0, 0);
			} else if (vm.frameSeq !== shown) {
				// Worker mode: paint a frame once (frame() also asks for the next).
				const f = vm.frame(image.data);
				if (f && f.width === width && f.height === height) {
					ctx.putImageData(image, 0, 0);
					shown = vm.frameSeq;
				}
			} else vm.requestFrame();
			raf = requestAnimationFrame(paint);
		};
		raf = requestAnimationFrame(paint);
		return () => cancelAnimationFrame(raf);
	}, [opts, width, height]);

	// Document-wide mouse input while the canvas holds pointer lock, and
	// releases anywhere, so no button stays down.
	useEffect(() => {
		const c = ref.current!;
		const scale = () => c.width / Math.max(1, c.offsetWidth);
		const onMove = (e: MouseEvent) => { if (pointerLocked()) evdev()?.move(e.movementX * scale(), e.movementY * scale()); };
		const onDown = (e: MouseEvent) => {
			const b = domButtonToLinux(e.button);
			if (pointerLocked() && b !== undefined) { e.preventDefault(); evdev()?.button(b, true); }
		};
		const onUp = (e: MouseEvent) => {
			const b = domButtonToLinux(e.button);
			if (b !== undefined) evdev()?.button(b, false);
		};
		const onPointerUp = (e: PointerEvent) => {
			if (e.pointerType !== "touch" && !e.buttons) for (const [, code] of BUTTON_BITS) evdev()?.tabletButton(code, false);
		};
		const onLockChange = () => { if (!pointerLocked()) for (const b of [BTN_LEFT, BTN_RIGHT, BTN_MIDDLE]) evdev()?.button(b, false); };
		const onWheel = (e: WheelEvent) => {
			if (absolute()) {
				e.preventDefault();
				if (e.deltaY) evdev()?.tabletWheel(e.deltaY < 0 ? 1 : -1);
				return;
			}
			if (!pointerLocked()) return;
			e.preventDefault();
			if (e.deltaY) evdev()?.wheel(e.deltaY < 0 ? 1 : -1);
		};
		document.addEventListener("mousemove", onMove);
		document.addEventListener("mousedown", onDown);
		document.addEventListener("mouseup", onUp);
		document.addEventListener("pointerup", onPointerUp);
		document.addEventListener("pointerlockchange", onLockChange);
		c.addEventListener("wheel", onWheel, { passive: false }); // React's is passive
		return () => {
			document.removeEventListener("mousemove", onMove);
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("mouseup", onUp);
			document.removeEventListener("pointerup", onPointerUp);
			document.removeEventListener("pointerlockchange", onLockChange);
			c.removeEventListener("wheel", onWheel);
			evdev()?.releaseAll();
			if (pointerLocked()) document.exitPointerLock();
		};
	}, []);

	/**
	 * The pointer's position on the picture, 0..1, snapped to the centre of
	 * the guest pixel under it (the canvas is the picture at the mode's size),
	 * so the guest's scaling to its screen (X: the mode) cannot round it to a
	 * neighbour; outside the picture it clamps to the edge.
	 */
	const to = (e: ReactPointerEvent) => {
		const c = ref.current!, p = localPos(c, rot, e);
		const px = Math.min(c.width - 1, Math.max(0, Math.floor(p.x * c.width)));
		const py = Math.min(c.height - 1, Math.max(0, Math.floor(p.y * c.height)));
		aim((px + 0.5) / c.width, (py + 0.5) / c.height);
	};
	/** Tablet buttons follow e.buttons, so chords (a second button during a drag) work too. */
	const syncButtons = (e: ReactPointerEvent) => {
		for (const [bit, code] of BUTTON_BITS) evdev()?.tabletButton(code, !!(e.buttons & bit));
	};
	const scale = () => { const c = ref.current!; return c.width / Math.max(1, c.offsetWidth); };

	// Touch: with the tablet open in mouse mode a touchscreen (the pointer
	// follows the finger, a tap clicks where it is); otherwise a trackpad
	// (drags move the pointer from where it is, a short tap clicks). On the
	// canvas, and on touch devices on the whole layer (#fb-touch).
	const touches = useRef(new Map<number, { x: number; y: number; t: number; moved: number }>());
	const direct = () => absolute() && touchMode === "mouse";
	const touchDown = (e: ReactPointerEvent) => {
		e.preventDefault();
		e.currentTarget.setPointerCapture(e.pointerId);
		touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now(), moved: 0 });
		if (direct()) to(e);
	};
	const touchMove = (e: ReactPointerEvent) => {
		const t = touches.current.get(e.pointerId);
		if (!t) return;
		const [dx, dy] = unturn(rot, e.clientX - t.x, e.clientY - t.y);
		t.x = e.clientX;
		t.y = e.clientY;
		t.moved += Math.abs(dx) + Math.abs(dy);
		const c = ref.current!;
		if (direct()) to(e);
		else if (absolute()) aim(clamp01(tabletPos.x + dx * TRACK_GAIN / Math.max(1, c.offsetWidth)), clamp01(tabletPos.y + dy * TRACK_GAIN / Math.max(1, c.offsetHeight)));
		else evdev()?.move(dx * scale() * TRACK_GAIN, dy * scale() * TRACK_GAIN);
	};
	const touchEnd = (e: ReactPointerEvent) => {
		const s = touches.current.get(e.pointerId);
		if (!s) return;
		touches.current.delete(e.pointerId);
		if (e.type === "pointerup" && s.moved < TAP_PX && performance.now() - s.t < TAP_MS) tapClick();
	};

	// Fit into the layer: centred, aspect kept, an integer scale if that keeps >= 90% of the size.
	let s = Math.min(aw / width, ah / height);
	const whole = Math.floor(s);
	const sharp = whole >= 1 && whole / s >= 0.9;
	if (sharp) s = whole;
	const cw = Math.round(width * s), ch = Math.round(height * s);

	return (
		<>
			<canvas
				ref={ref}
				id="fb"
				width={width}
				height={height}
				className="absolute z-3 touch-none bg-black"
				style={{
					width: cw, height: ch, left: Math.floor((aw - cw) / 2), top: Math.floor((ah - ch) / 2),
					imageRendering: sharp ? "pixelated" : "auto",
					// Pointer input only while a program reads a mouse (relative or the
					// tablet); otherwise taps go through. With the tablet the guest
					// draws the cursor, so the host's is hidden there.
					pointerEvents: mouse || tablet ? "auto" : "none",
					cursor: tablet ? "none" : undefined,
				}}
				onDoubleClick={(e) => e.preventDefault()}
				onContextMenu={(e) => { if (pointerLocked() || absolute() || opts.touch) e.preventDefault(); }}
				onClick={() => {
					if (!opts.touch && !absolute() && evdev()?.mouseOpen && !pointerLocked()) void ref.current!.requestPointerLock?.();
				}}
				onPointerDown={(e) => {
					if (e.pointerType === "touch") return touchDown(e);
					if (!absolute()) return;
					e.preventDefault();
					e.currentTarget.setPointerCapture(e.pointerId); // a drag keeps going outside the picture
					to(e);
					syncButtons(e);
				}}
				onPointerMove={(e) => {
					if (e.pointerType !== "touch") {
						if (!absolute()) return;
						to(e);
						syncButtons(e);
						return;
					}
					touchMove(e);
				}}
				onPointerUp={(e) => {
					if (e.pointerType !== "touch") syncButtons(e);
					else touchEnd(e);
				}}
				onPointerCancel={touchEnd}
				onLostPointerCapture={(e) => {
					if (e.pointerType !== "touch" && !e.buttons) for (const [, code] of BUTTON_BITS) evdev()?.tabletButton(code, false);
				}}
			/>
			{/* Touch devices: the whole layer is the pointer surface, letterbox included (the controls sit above it). */}
			{opts.touch && (mouse || tablet) && (
				<div id="fb-touch" className="absolute inset-0 z-3 touch-none select-none [-webkit-touch-callout:none]"
					onPointerDown={touchDown} onPointerMove={touchMove} onPointerUp={touchEnd} onPointerCancel={touchEnd}
					onContextMenu={(e) => e.preventDefault()} onDoubleClick={(e) => e.preventDefault()} />
			)}
		</>
	);
}

// ---- touch overlay ----------------------------------------------------------
/** Overlay keys: label, Linux key code, terminal input when evdev is closed. */
interface PadKey {
	label: string;
	code: number;
	tty?: string | (() => string);
}

type KeyId = "esc" | "tab" | "shift" | "ctrl" | "alt" | "space" | "enter" | "y" | "n";

/** A face button: the key it presses, and its label's colour. */
/** A face button: its letter, the letter's colour, and the key it presses (shown small under the letter). */
interface FaceDef { letter: string; color: string; key: KeyId }

/**
 * The right side's layouts, which the chip toggles between. Face buttons
 * carry a controller's letters, with the key they send (there is no gamepad
 * device: programs read the keyboard) in tiny type under it. Keys has every
 * key ABXY leaves out (Shift, Y, N).
 * - gamepad: A B X Y in a diamond (Y top Alt, X left Ctrl, B right Esc,
 *   A bottom Space), with Tab and Enter above, where a controller has
 *   Select and Start;
 * - keys: every key in a 3x3 grid.
 */
const LAYOUTS: Record<PadLayout, { name: string; next: PadLayout; select?: KeyId; start?: KeyId; faces?: FaceDef[]; grid?: KeyId[] }> = {
	gamepad: {
		name: "ABXY", next: "keys", select: "tab", start: "enter",
		faces: [
			{ letter: "Y", color: "text-warn", key: "alt" }, { letter: "X", color: "text-accent", key: "ctrl" },
			{ letter: "B", color: "text-err", key: "esc" }, { letter: "A", color: "text-ok", key: "space" },
		],
	},
	keys: { name: "Keys", next: "gamepad", grid: ["esc", "tab", "y", "ctrl", "alt", "n", "shift", "space", "enter"] },
};

const NO_TOUCH_UI = "touch-none select-none [-webkit-touch-callout:none] [-webkit-tap-highlight-color:transparent]";
const GLASS = "border border-white/35 bg-white/12 backdrop-blur-sm";
const LIT = "data-on:border-white/60 data-on:bg-white/25";
/** A key cap (the Keys layout). */
const CAP = `pointer-events-auto grid h-11 place-items-center rounded-lg p-0 text-[13px] font-medium text-white/85 ${GLASS} ${LIT} ${NO_TOUCH_UI}`;
/** A small chip in the top strip. */
const CHIP = `pointer-events-auto inline-flex h-8 min-w-8 items-center justify-center gap-1 rounded-md px-2 font-mono text-[11px] text-white/80 ${GLASS} aria-pressed:bg-white/20 aria-pressed:text-white ${NO_TOUCH_UI}`;

/** The stick (viewBox 0 0 100 100): how far the knob's centre travels, and the dead zone, as fractions of the base's radius. */
const KNOB_TRAVEL = 30, STICK_DEAD = 0.25;
/** The stick's chevrons, one per direction, near the rim. */
const CHEVRON = { up: "M42 16l8-7 8 7", down: "M42 84l8 7 8-7", left: "M16 42l-7 8 7 8", right: "M84 42l7 8-7 8" } as const;

const FullIcon = ({ on }: { on: boolean }) => (
	<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
		<path d={on ? "M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" : "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"} />
	</svg>
);

/** Touch mode "mouse": the pointer goes to the finger (an arrow pointer). */
const PointerIcon = () => (
	<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
		<path d="M5 3l5.5 17 2.6-7.4L20.5 10z" /><path d="M13.1 12.6 19 18.5" />
	</svg>
);

/** Touch mode "trackpad": a pad with its two buttons. */
const TrackpadIcon = () => (
	<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
		<rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 15h18M12 15v5" />
	</svg>
);

const KeyboardIcon = () => (
	<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
		<rect x="2" y="5" width="20" height="14" rx="2" /><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M18 13h.01M10 13h4M7 16h10" />
	</svg>
);

/** The stick and buttons on or off: a controller. */
const GamepadIcon = () => (
	<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
		<path d="M7 7h10a5 5 0 0 1 4.6 7l-1 2.4a2.5 2.5 0 0 1-4.3.5L14.5 15h-5l-1.8 1.9a2.5 2.5 0 0 1-4.3-.5l-1-2.4A5 5 0 0 1 7 7z" /><path d="M7.5 10v3M6 11.5h3M16 11h.01M18 12.5h.01" />
	</svg>
);

const RotateIcon = () => (
	<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
		<rect x="7" y="2.5" width="10" height="16" rx="1.5" transform="rotate(-90 12 12)" />
		<path d="M3 8a9 9 0 0 1 9-5l-2-1.5M21 16a9 9 0 0 1-9 5l2 1.5" />
	</svg>
);

function Pad({ opts, rot, portrait, rotate, layout, tablet, touchMode, controls }: {
	opts: DisplayUiOptions; rot: boolean; portrait: boolean; rotate: boolean; layout: PadLayout; tablet: boolean; touchMode: TouchMode; controls: boolean;
}) {
	const full = useFullscreen();
	// Each pointer holds the keys it pressed; a release, a cancel or a lost
	// capture releases them, so a key never sticks. `lit` mirrors them for
	// the pressed look (:active is unreliable with pointer capture on iOS).
	const held = useRef(new Map<number, Set<PadKey>>());
	const [lit, setLit] = useState<ReadonlySet<PadKey>>(() => new Set());
	const repeat = useRef(new Map<PadKey, ReturnType<typeof setTimeout>>());
	const stickRef = useRef<HTMLDivElement>(null);
	// The knob's offset from the base's centre (-1..1 at the rim), null at rest.
	const [knob, setKnob] = useState<{ x: number; y: number } | null>(null);

	const press = (k: PadKey) => {
		const ev = evdev();
		if (ev?.keyboardOpen) return void ev.key(k.code, true);
		const tty = typeof k.tty === "function" ? k.tty() : k.tty;
		if (!tty) return;
		opts.sendTty(tty);
		const again = (ms: number) => repeat.current.set(k, setTimeout(() => {
			opts.sendTty(typeof k.tty === "function" ? k.tty() : tty);
			again(80);
		}, ms));
		again(400);
	};
	const release = (k: PadKey) => {
		evdev()?.key(k.code, false);
		clearTimeout(repeat.current.get(k));
		repeat.current.delete(k);
	};
	const setHeld = (id: number, keys: Set<PadKey>) => {
		const old = held.current.get(id) ?? new Set();
		for (const k of old) if (!keys.has(k)) release(k);
		for (const k of keys) if (!old.has(k)) press(k);
		if (keys.size) held.current.set(id, keys);
		else held.current.delete(id);
		setLit(new Set([...held.current.values()].flatMap((s) => [...s])));
	};
	// Pointers that are down on a control, holding keys or not (a stick
	// touched in its dead zone holds none yet, but its moves still count).
	const down = useRef(new Set<number>());
	const track = (keysAt: (e: ReactPointerEvent) => Set<PadKey>) => {
		const end = (e: ReactPointerEvent) => {
			down.current.delete(e.pointerId);
			setHeld(e.pointerId, new Set());
		};
		return {
			onPointerDown: (e: ReactPointerEvent) => {
				e.preventDefault(); // no focus change, so no on-screen keyboard
				e.currentTarget.setPointerCapture(e.pointerId);
				down.current.add(e.pointerId);
				setHeld(e.pointerId, keysAt(e));
			},
			onPointerMove: (e: ReactPointerEvent) => { if (down.current.has(e.pointerId)) setHeld(e.pointerId, keysAt(e)); },
			onPointerUp: end,
			onPointerCancel: end,
			onLostPointerCapture: end,
		};
	};
	const releaseAll = () => {
		down.current.clear();
		for (const id of [...held.current.keys()]) setHeld(id, new Set());
	};
	useEffect(() => releaseAll, []);

	const arrow = (c: string) => () => (opts.appCursor() ? `\x1bO${c}` : `\x1b[${c}`);
	// Stable across renders: held keys are compared by identity.
	const [keys] = useState(() => ({
		dirs: {
			up: { label: "▲", code: KEY.up, tty: arrow("A") }, down: { label: "▼", code: KEY.down, tty: arrow("B") },
			left: { label: "◀", code: KEY.left, tty: arrow("D") }, right: { label: "▶", code: KEY.right, tty: arrow("C") },
		} satisfies Record<string, PadKey>,
		named: {
			esc: { label: "Esc", code: KEY.esc, tty: "\x1b" }, tab: { label: "Tab", code: KEY.tab, tty: "\t" },
			shift: { label: "Shift", code: KEY.shift }, ctrl: { label: "Ctrl", code: KEY.ctrl }, alt: { label: "Alt", code: KEY.alt },
			space: { label: "Space", code: KEY.space, tty: " " }, enter: { label: "Enter", code: KEY.enter, tty: "\r" },
			y: { label: "Y", code: KEY.y, tty: "y" }, n: { label: "N", code: KEY.n, tty: "n" },
		} satisfies Record<KeyId, PadKey>,
	}));
	const { dirs, named } = keys;
	const L = LAYOUTS[layout];

	// The soft keyboard: a hidden input the chip focuses (the phone's keyboard
	// comes up) and blurs. Phone keyboards send no usable keydowns (Android's
	// compose words), so what the input gains or loses is what was typed:
	// Backspaces for what went, the new text after. While a program has the
	// guest keyboard open the characters become key presses, else they go to
	// the terminal.
	const guestKeyboard = useStore((s) => s.display.keyboard);
	const kbdRef = useRef<HTMLInputElement>(null);
	const [kbd, setKbd] = useState(false);
	const composing = useRef(false);
	const was = useRef(SENTINEL);
	const tapKey = (code: number, shift = false, ctrl = false, alt = false) => {
		const ev = evdev()!;
		if (ctrl) ev.key(KEY.ctrl, true);
		if (alt) ev.key(KEY.alt, true);
		if (shift) ev.key(KEY.shift, true);
		ev.key(code, true);
		ev.key(code, false);
		if (shift) ev.key(KEY.shift, false);
		if (alt) ev.key(KEY.alt, false);
		if (ctrl) ev.key(KEY.ctrl, false);
	};
	/** The key bar's modifiers are latched: they apply to the next key, then let go. */
	const takeModifiers = () => {
		const { ctrl, alt } = ui$().get();
		if (ctrl) KW.ui?.setCtrl(false);
		if (alt) KW.ui?.setAlt(false);
		return { ctrl, alt };
	};
	const typeText = (text: string, backspaces: number) => {
		if (evdev()?.keyboardOpen) {
			for (let i = 0; i < backspaces; i++) tapKey(14);
			for (const c of text) {
				const k = CHAR_KEY.get(c);
				if (k) {
					const modifiers = takeModifiers();
					tapKey(k[0], k[1], modifiers.ctrl, modifiers.alt);
				}
			}
		} else {
			// The terminal's own latched modifiers, on the first character.
			const modifiers = ui$().get();
			if (text && (modifiers.ctrl || modifiers.alt)) text = (KW.ui?.applyModifiers(text[0]!) ?? text[0]!) + text.slice(1);
			opts.sendTty("\x7f".repeat(backspaces) + text.replace(/\n/g, "\r"));
		}
	};
	// The key bar over the keyboard (Keys.tsx): the terminal's, but while a
	// program reads the keyboard its keys are key presses (^C is Ctrl-C).
	const BAR_KEY: Record<string, number> = { esc: KEY.esc, tab: KEY.tab, up: KEY.up, down: KEY.down, left: KEY.left, right: KEY.right };
	const barPress = (k: string) => {
		if (!evdev()?.keyboardOpen) return KW.ui?.pressKey(k);
		if (k === "ctrl") return KW.ui?.setCtrl(!ui$().get().ctrl);
		if (k === "alt") return KW.ui?.setAlt(!ui$().get().alt);
		if (k === "^c") return void (takeModifiers(), tapKey(domCodeToLinux("KeyC")!, false, true));
		const c = CHAR_KEY.get(k);
		const code = BAR_KEY[k] ?? c?.[0];
		if (code !== undefined) {
			const modifiers = takeModifiers();
			tapKey(code, c?.[1] ?? false, modifiers.ctrl, modifiers.alt);
		}
	};
	const kbdInput = () => {
		const el = kbdRef.current!, now = el.value, old = was.current;
		let same = 0;
		while (same < now.length && same < old.length && now[same] === old[same]) same++;
		typeText(now.slice(same), old.length - same);
		was.current = now;
		if (!composing.current) el.value = was.current = SENTINEL;
	};
	// Keys a phone keyboard does send as keys (Enter; a hardware keyboard's
	// Tab, Esc and arrows): sent as themselves, not typed into the input.
	const kbdKeyDown = (e: ReactKeyboardEvent) => {
		if (e.nativeEvent.isComposing || e.keyCode === 229) return;
		const k = ({ Enter: named.enter, Tab: named.tab, Escape: named.esc, ArrowUp: dirs.up, ArrowDown: dirs.down, ArrowLeft: dirs.left, ArrowRight: dirs.right } as Record<string, PadKey>)[e.key];
		if (!k) return;
		e.preventDefault();
		if (evdev()?.keyboardOpen) tapKey(k.code);
		else { const t = typeof k.tty === "function" ? k.tty() : k.tty; if (t) opts.sendTty(t); }
	};
	const toggleKbd = () => {
		const el = kbdRef.current!;
		if (document.activeElement === el) el.blur();
		else { el.value = was.current = SENTINEL; el.focus(); } // in the tap, or iOS shows no keyboard
	};
	const on = (k: PadKey) => (lit.has(k) ? "" : undefined);

	// Stick: the knob follows the finger, held inside the rim; the direction
	// from the base's centre presses the arrows, 8-way (each 135 degrees wide,
	// so a diagonal presses two keys).
	const stickKeys = (e: ReactPointerEvent) => {
		const p = localPos(stickRef.current!, rot, e);
		const x = (p.x - 0.5) * 2, y = (p.y - 0.5) * 2;
		const r = Math.hypot(x, y);
		setKnob(r > 1 ? { x: x / r, y: y / r } : { x, y });
		const out = new Set<PadKey>();
		if (r < STICK_DEAD) return out;
		const a = Math.atan2(y, x) * 180 / Math.PI; // 0 = right, 90 = down
		if (a > -67.5 && a < 67.5) out.add(dirs.right);
		if (a > 22.5 && a < 157.5) out.add(dirs.down);
		if (a > 112.5 || a < -112.5) out.add(dirs.left);
		if (a > -157.5 && a < -22.5) out.add(dirs.up);
		return out;
	};
	const stickTrack = track(stickKeys);
	// Hidden mid-press: the controls unmount without a pointerup.
	useEffect(() => { if (!controls) { releaseAll(); setKnob(null); } }, [controls]);
	const stickEnd = (h: (e: ReactPointerEvent) => void) => (e: ReactPointerEvent) => { h(e); setKnob(null); };
	const stick = {
		...stickTrack,
		onPointerUp: stickEnd(stickTrack.onPointerUp),
		onPointerCancel: stickEnd(stickTrack.onPointerCancel),
		onLostPointerCapture: stickEnd(stickTrack.onLostPointerCapture),
	};
	const chev = (k: PadKey) => (lit.has(k) ? "stroke-white" : "stroke-white/45");

	// Plain render helpers, not components: a component defined here would
	// remount on every render and lose its pointer capture mid-press.
	const face = (f: FaceDef, size: string, extraClass = "") => {
		const k = named[f.key];
		return (
			<button key={f.letter} type="button" aria-label={`${f.letter} (${k.label})`} data-on={on(k)}
				className={`pointer-events-auto flex flex-col items-center justify-center rounded-full p-0 ${size} ${GLASS} ${LIT} ${NO_TOUCH_UI} ${extraClass}`}
				{...track(() => new Set([k]))}>
				<span className={`text-xl leading-none font-bold ${f.color}`}>{f.letter}</span>
				<span className="mt-0.5 text-[7px] leading-none font-medium tracking-wide text-white/45 uppercase">{k.label}</span>
			</button>
		);
	};
	const pill = (id: KeyId) => {
		const k = named[id];
		return (
			<button key={id} type="button" data-on={on(k)}
				className={`pointer-events-auto h-7 min-w-15 rounded-full px-3 text-[10px] font-medium tracking-wider text-white/80 uppercase ${GLASS} ${LIT} ${NO_TOUCH_UI}`}
				{...track(() => new Set([k]))}>{k.label}</button>
		);
	};
	const cap = (id: KeyId) => {
		const k = named[id];
		return <button key={id} type="button" data-on={on(k)} className={CAP} {...track(() => new Set([k]))}>{k.label}</button>;
	};
	const chip = (label: ReactNode, title: string, run: () => void, pressed?: boolean) => (
		<button type="button" title={title} aria-label={title} aria-pressed={pressed} className={CHIP}
			onPointerDown={(e) => e.preventDefault() /* no focus, no keyboard */} onClick={run}>{label}</button>
	);

	let right: ReactNode;
	if (L.grid) right = <div className="grid grid-cols-[repeat(3,56px)] gap-1.5">{L.grid.map(cap)}</div>;
	else {
		const f = L.faces!;
		right = (
			<div className="flex flex-col items-center gap-3">
				<div className="flex gap-2">{L.select && pill(L.select)}{L.start && pill(L.start)}</div>
				<div className="grid grid-cols-[repeat(3,52px)] grid-rows-[repeat(3,52px)] place-items-center">
					{face(f[0]!, "size-[52px]", "col-start-2 row-start-1")}
					{face(f[1]!, "size-[52px]", "col-start-1 row-start-2")}
					{face(f[2]!, "size-[52px]", "col-start-3 row-start-2")}
					{face(f[3]!, "size-[52px]", "col-start-2 row-start-3")}
				</div>
			</div>
		);
	}

	return (
		<div id="pad" className="pointer-events-none absolute inset-0 z-4 flex flex-col justify-between pt-(--pt) pr-(--pr) pb-(--pb) pl-(--pl)">
			{/* The soft keyboard's input: invisible, at the top so focusing it scrolls nothing; 16px so iOS does not zoom. */}
			<input ref={kbdRef} aria-label="Keyboard input" type="text" defaultValue={SENTINEL} autoCapitalize="off" autoComplete="off" autoCorrect="off" spellCheck={false}
				className="pointer-events-none absolute top-0 left-0 size-px border-0 p-0 text-[16px] opacity-0"
				onInput={kbdInput} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; kbdInput(); }}
				onKeyDown={kbdKeyDown} onFocus={() => setKbd(true)} onBlur={() => setKbd(false)} />
			<div className="flex flex-col items-end gap-1.5">
				<div className="flex gap-1.5">
					{rot && chip("tty", "Show the terminal", () => setDisplayShown(false))}
					{offerFullscreen() && chip(<FullIcon on={full} />, full ? "Leave full screen" : "Full screen", () => void toggleFullscreen().then((m) => m && KW.ui?.toast(m)), full)}
					{portrait && chip(<RotateIcon />, rotate ? "Rotated: hold the phone sideways (tap to turn back)" : "Rotate the display", () => setRotate(!rotate), rotate)}
					{tablet && chip(touchMode === "mouse" ? <PointerIcon /> : <TrackpadIcon />, touchMode === "mouse" ? "Touch: the pointer goes to your finger (tap for trackpad)" : "Touch: drag to move the pointer (tap for mouse)", () => setTouchMode(touchMode === "mouse" ? "trackpad" : "mouse"))}
					{controls && chip(L.name, `Buttons: ${L.name} (tap for ${LAYOUTS[L.next].name})`, () => setPadLayout(L.next))}
					{chip(<KeyboardIcon />, kbd ? "Hide the keyboard" : "Show the keyboard", toggleKbd, kbd)}
					{chip(<GamepadIcon />, controls ? "Hide the stick and buttons" : "Show the stick and buttons", () => setControls(!controls), controls)}
				</div>
			</div>
			{controls && <div className={`flex items-end justify-between gap-3 ${kbd ? "mb-[52px]" : ""}`}>
				<div ref={stickRef} aria-label="Direction stick" className={`pointer-events-auto relative size-36 flex-none ${NO_TOUCH_UI}`} {...stick}>
					<svg viewBox="0 0 100 100" className="absolute inset-0 size-full overflow-visible" aria-hidden="true">
						<circle cx="50" cy="50" r="48" className="fill-black/25 stroke-white/35" strokeWidth="1.5" />
						<circle cx="50" cy="50" r="24" className="fill-none stroke-white/15" strokeWidth="1" />
						{/* CSS transform in user units; it eases back only on release. */}
						<g style={{ transform: `translate(${(knob?.x ?? 0) * KNOB_TRAVEL}px, ${(knob?.y ?? 0) * KNOB_TRAVEL}px)` }} className={knob ? "" : "transition-transform duration-150 ease-out"}>
							<circle cx="50" cy="50" r="21" className={knob ? "fill-white/40 stroke-white/80" : "fill-white/25 stroke-white/55"} strokeWidth="1.5" />
							<circle cx="50" cy="50" r="13" className="fill-none stroke-white/25" strokeWidth="1" />
						</g>
						{/* Over the knob, so a pushed knob does not hide the lit one. */}
						{(Object.keys(CHEVRON) as (keyof typeof CHEVRON)[]).map((d) => (
							<path key={d} d={CHEVRON[d]} className={`fill-none ${chev(dirs[d])}`} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
						))}
					</svg>
				</div>
				<div className="flex-none">{right}</div>
			</div>}
			{/* Flush with the layer's bottom, so just above the phone's keyboard (the page follows the visual viewport). */}
			<Keys show={kbd} onPress={barPress} omit={guestKeyboard ? ["paste"] : undefined}
				className="pointer-events-auto absolute inset-x-0 bottom-0 z-1" />
		</div>
	);
}
