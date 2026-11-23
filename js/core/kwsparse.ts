// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// "kwsparse": a sparse disk image, the format of the data disk template
// (kernel/build.sh datadisk, bundled as the custom section
// "unkernel.datadisk") and of the page's data disk export. Shared by the
// SDK, the page and kernel/tools/kwsparse.mjs.
//
// Layout (all little-endian), usually gzip-compressed (.kwsparse.gz):
//   0      "KWSPARS1"         magic (8 bytes)
//   8      u64 size           disk size in bytes
//   16     u32 blockSize      4096
//   20     u32 count N
//   24     N x u64            block indices, strictly ascending
//   24+8N  N x blockSize      block data
// Only blocks that are not all zeros are stored; every other block reads as
// zeros.

export const KWSPARSE_MAGIC = "KWSPARS1";
const HEADER = 24;

/** A decoded kwsparse image: indices[i] is the disk block whose content is block(i). */
export interface KwsparseImage {
	size: number;
	blockSize: number;
	indices: number[];
	/** The block data, all blocks back to back. */
	data: Uint8Array;
	block(i: number): Uint8Array;
	/** Block index -> data (views into `data`). */
	map(): Map<number, Uint8Array>;
}

/** All bytes zero? */
export function isZeroBlock(b: Uint8Array): boolean {
	// Compare 4 bytes at a time when aligned (the common case).
	if ((b.byteOffset & 3) === 0 && (b.length & 3) === 0) {
		const w = new Uint32Array(b.buffer, b.byteOffset, b.length >> 2);
		for (let i = 0; i < w.length; i++) if (w[i]) return false;
		return true;
	}
	for (let i = 0; i < b.length; i++) if (b[i]) return false;
	return true;
}

/** The header of a kwsparse image holding the given block indices (ascending). */
export function kwsparseHeader(size: number, blockSize: number, indices: readonly number[]): Uint8Array {
	const out = new Uint8Array(HEADER + 8 * indices.length);
	const dv = new DataView(out.buffer);
	for (let i = 0; i < 8; i++) out[i] = KWSPARSE_MAGIC.charCodeAt(i);
	dv.setBigUint64(8, BigInt(size), true);
	dv.setUint32(16, blockSize, true);
	dv.setUint32(20, indices.length, true);
	let prev = -1;
	indices.forEach((b, i) => {
		if (!(b > prev) || !Number.isSafeInteger(b) || (b + 1) * blockSize > size)
			throw new Error(`kwsparse: bad block index ${b}`);
		prev = b;
		dv.setBigUint64(HEADER + 8 * i, BigInt(b), true);
	});
	return out;
}

/**
 * Encode blocks into one (uncompressed) kwsparse image. `blocks` are
 * [index, data] pairs in any order; all-zero blocks are dropped.
 */
export function encodeKwsparse({ size, blockSize = 4096, blocks }: {
	size: number;
	blockSize?: number;
	blocks: Iterable<[number, Uint8Array]>;
}): Uint8Array {
	const list = [...blocks].filter(([, d]) => {
		if (d.length !== blockSize) throw new Error(`kwsparse: block of ${d.length} bytes, expected ${blockSize}`);
		return !isZeroBlock(d);
	}).sort((a, b) => a[0] - b[0]);
	const head = kwsparseHeader(size, blockSize, list.map(([b]) => b));
	const out = new Uint8Array(head.length + list.length * blockSize);
	out.set(head);
	list.forEach(([, d], i) => out.set(d, head.length + i * blockSize));
	return out;
}

export interface KwsparseHeader {
	size: number;
	blockSize: number;
	blocks: number;
}

/** Parse the fixed 24-byte header, without requiring the index or payload. */
export function decodeKwsparseHeader(bytes: Uint8Array | ArrayBuffer): KwsparseHeader {
	const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	if (u8.length < HEADER) throw new Error("kwsparse: truncated header");
	for (let i = 0; i < 8; i++)
		if (u8[i] !== KWSPARSE_MAGIC.charCodeAt(i)) throw new Error("not a kwsparse image (bad magic)");
	const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
	const size = Number(dv.getBigUint64(8, true));
	const blockSize = dv.getUint32(16, true);
	const blocks = dv.getUint32(20, true);
	if (!Number.isSafeInteger(size) || size <= 0) throw new Error(`kwsparse: bad size ${size}`);
	if (!blockSize || blockSize & (blockSize - 1) || blockSize < 512) throw new Error(`kwsparse: bad block size ${blockSize}`);
	return { size, blockSize, blocks };
}

/** Parse an uncompressed kwsparse image (see gunzipIfNeeded). The result views `bytes`. */
export function decodeKwsparse(bytes: Uint8Array | ArrayBuffer): KwsparseImage {
	const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	const { size, blockSize, blocks: n } = decodeKwsparseHeader(u8);
	const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
	const dataAt = HEADER + 8 * n;
	if (u8.length !== dataAt + n * blockSize)
		throw new Error(`kwsparse: ${u8.length} bytes, expected ${dataAt + n * blockSize} for ${n} blocks`);
	const indices: number[] = new Array(n);
	let prev = -1;
	for (let i = 0; i < n; i++) {
		const b = Number(dv.getBigUint64(HEADER + 8 * i, true));
		if (!(b > prev) || (b + 1) * blockSize > size) throw new Error(`kwsparse: bad or unsorted block index ${b}`);
		indices[i] = prev = b;
	}
	const data = u8.subarray(dataAt);
	const block = (i: number) => data.subarray(i * blockSize, (i + 1) * blockSize);
	return {
		size, blockSize, indices, data, block,
		map: () => new Map(indices.map((b, i) => [b, block(i)])),
	};
}

export const isGzip = (u8: Uint8Array): boolean => u8.length >= 2 && u8[0] === 0x1f && u8[1] === 0x8b;

/** Gunzip (DecompressionStream: browsers and Node) if the bytes are gzip. */
export async function gunzipIfNeeded(bytes: Uint8Array | ArrayBuffer): Promise<Uint8Array> {
	const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	if (!isGzip(u8)) return u8;
	const stream = new Blob([u8 as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("gzip"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Decode a kwsparse image, gzipped or not. */
export async function readKwsparse(bytes: Uint8Array | ArrayBuffer): Promise<KwsparseImage> {
	return decodeKwsparse(await gunzipIfNeeded(bytes));
}

/**
 * gzip parts (e.g. CowDisk.exportParts()) with CompressionStream into a
 * Blob. The output is not byte-for-byte reproducible across engines; the
 * build tool uses zlib for that.
 */
export function gzipBlob(parts: BlobPart[]): Promise<Blob> {
	return new Response(new Blob(parts).stream().pipeThrough(new CompressionStream("gzip"))).blob();
}
