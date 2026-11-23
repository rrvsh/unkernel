#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Convert between disk images and kwsparse images (format: js/core/kwsparse.ts).
//
//   node kernel/tools/kwsparse.mjs encode <disk.img> -o <out.kwsparse[.gz]>
//   node kernel/tools/kwsparse.mjs decode <in.kwsparse[.gz]> -o <disk.img>   (sparse; must not exist)
//   node kernel/tools/kwsparse.mjs info <in.kwsparse[.gz]>
//
// encode stores every 4 KiB block that is not all zeros; an output name ending
// in .gz is gzipped (zlib level 9, no timestamp), so the same image always
// gives the same bytes. kernel/build.sh datadisk uses it for the data disk
// template, and the page's data disk export (KW.exportData()) writes the same format.
import fs from "node:fs";
import { gzipSync } from "node:zlib";
import { isZeroBlock, kwsparseHeader, readKwsparse } from "../../js/core/kwsparse.ts";
import { createImageFromKwsparse } from "../../js/node/disk.ts";

const BLOCK = 4096;

/** Scan a disk image for non-zero blocks: {size, indices, data: Uint8Array[]}. */
export function scanImage(path, blockSize = BLOCK) {
	const fd = fs.openSync(path, "r");
	try {
		const size = fs.fstatSync(fd).size;
		if (size % blockSize) throw new Error(`${path}: size ${size} is not a multiple of ${blockSize}`);
		const chunk = new Uint8Array(1 << 20);
		const indices = [], data = [];
		for (let off = 0; off < size; off += chunk.length) {
			const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - off), off);
			for (let o = 0; o < n; o += blockSize) {
				const blk = chunk.subarray(o, o + blockSize);
				if (isZeroBlock(blk)) continue;
				indices.push((off + o) / blockSize);
				data.push(blk.slice());
			}
		}
		return { size, indices, data };
	} finally {
		fs.closeSync(fd);
	}
}

export function encodeImage(path, { gzip = true } = {}) {
	const { size, indices, data } = scanImage(path);
	const raw = Buffer.concat([kwsparseHeader(size, BLOCK, indices), ...data]);
	return { bytes: gzip ? gzipSync(raw, { level: 9 }) : raw, size, blocks: indices.length, raw: raw.length };
}

/** Write an uncompressed image without retaining its non-zero block payload in memory. */
export function encodeImageToFile(path, out) {
	const input = fs.openSync(path, "r");
	const tmp = `${out}.tmp`;
	try {
		const size = fs.fstatSync(input).size;
		if (size % BLOCK) throw new Error(`${path}: size ${size} is not a multiple of ${BLOCK}`);
		const chunk = new Uint8Array(1 << 20), indices = [];
		for (let off = 0; off < size; off += chunk.length) {
			const n = fs.readSync(input, chunk, 0, Math.min(chunk.length, size - off), off);
			for (let at = 0; at < n; at += BLOCK) if (!isZeroBlock(chunk.subarray(at, at + BLOCK))) indices.push((off + at) / BLOCK);
		}
		const output = fs.openSync(tmp, "w");
		try {
			fs.writeSync(output, kwsparseHeader(size, BLOCK, indices));
			for (let off = 0; off < size; off += chunk.length) {
				const n = fs.readSync(input, chunk, 0, Math.min(chunk.length, size - off), off);
				for (let at = 0; at < n; at += BLOCK) {
					const block = chunk.subarray(at, at + BLOCK);
					if (!isZeroBlock(block)) fs.writeSync(output, block);
				}
			}
		} finally {
			fs.closeSync(output);
		}
		fs.renameSync(tmp, out);
		return { size, blocks: indices.length, raw: 24 + indices.length * (8 + BLOCK) };
	} catch (error) {
		fs.rmSync(tmp, { force: true });
		throw error;
	} finally {
		fs.closeSync(input);
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const args = process.argv.slice(2);
	const i = args.indexOf("-o");
	const out = i >= 0 ? args.splice(i, 2)[1] : undefined;
	const [cmd, input] = args;
	const mib = (n) => (n < 1048576 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1048576).toFixed(1)} MiB`);
	if (cmd === "encode" && input && out) {
		if (out.endsWith(".gz")) {
			const r = encodeImage(input);
			fs.writeFileSync(`${out}.tmp`, r.bytes);
			fs.renameSync(`${out}.tmp`, out);
			console.log(`kwsparse: ${out} (${mib(r.size)} disk, ${r.blocks} non-zero blocks, ${mib(r.raw)} raw, ${mib(r.bytes.length)} written)`);
		} else {
			const r = encodeImageToFile(input, out);
			console.log(`kwsparse: ${out} (${mib(r.size)} disk, ${r.blocks} non-zero blocks, ${mib(r.raw)} written)`);
		}
	} else if (cmd === "decode" && input && out) {
		const r = await createImageFromKwsparse(out, fs.readFileSync(input));
		console.log(`kwsparse: ${out} (${mib(r.size)}, ${r.blocks} blocks written)`);
	} else if (cmd === "info" && input) {
		const img = await readKwsparse(fs.readFileSync(input));
		console.log(`size ${img.size} (${mib(img.size)}), block size ${img.blockSize}, ${img.indices.length} blocks (${mib(img.data.length)})` +
			(img.indices.length ? `, first ${img.indices[0]}, last ${img.indices.at(-1)}` : ""));
	} else {
		console.error("usage: kwsparse.mjs encode <disk.img> -o <out.kwsparse[.gz]> | decode <in> -o <disk.img> | info <in>");
		process.exit(2);
	}
}
