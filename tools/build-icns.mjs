// SPDX-License-Identifier: GPL-2.0-only

// Assemble PNG icon representations into Apple's simple chunked ICNS container. Image scaling
// stays with ffmpeg; this script only writes the documented `icns`/type/length byte structure.

import { readFile, writeFile } from "node:fs/promises";

const [output, ...representations] = process.argv.slice(2);

if (!output || representations.length === 0 || representations.some((item) => !item.includes("="))) {
  console.error("usage: node tools/build-icns.mjs <output.icns> <type=icon.png> [...]");
  process.exitCode = 2;
} else {
  const chunks = await Promise.all(representations.map(async (representation) => {
    const separator = representation.indexOf("=");
    const type = representation.slice(0, separator);
    const path = representation.slice(separator + 1);
    if (!/^[A-Za-z0-9]{4}$/.test(type)) throw new Error(`invalid ICNS type: ${type}`);
    const png = await readFile(path);
    const chunk = Buffer.allocUnsafe(8 + png.length);
    chunk.write(type, 0, 4, "ascii");
    chunk.writeUInt32BE(chunk.length, 4);
    png.copy(chunk, 8);
    return chunk;
  }));
  const length = 8 + chunks.reduce((total, chunk) => total + chunk.length, 0);
  const header = Buffer.allocUnsafe(8);
  header.write("icns", 0, 4, "ascii");
  header.writeUInt32BE(length, 4);
  await writeFile(output, Buffer.concat([header, ...chunks], length));
}
