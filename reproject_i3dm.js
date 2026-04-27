/**
 * Copyright 2026 Sourcepole AG
 * All rights reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import fs from "fs";
import proj4 from "proj4";


export default class ReprojectI3DM {

    copyAttr(ftJson, ftBin, attr, componentSize, tupleSize, newFtJson, newFtBin) {
        const count = ftJson.INSTANCES_LENGTH;

        if (attr in ftJson) {
            const offset = ftJson[attr].byteOffset;
            const byteLen = count * componentSize * tupleSize;
            newFtJson[attr] = {...ftJson[attr], byteOffset: newFtBin.length};
            return ftBin.slice(offset, offset + byteLen);
        }
         return Buffer.alloc(0);
    }

    decodePositions(ftJson, ftBin) {
        const count = ftJson.INSTANCES_LENGTH;

        let positions = [];

        if (ftJson.POSITION) {
            const offset = ftJson.POSITION.byteOffset;

            for (let i = 0; i < count; i++) {
                positions.push([
                    ftBin.readFloatLE(offset + i*12),
                    ftBin.readFloatLE(offset + i*12 + 4),
                    ftBin.readFloatLE(offset + i*12 + 8)
                ]);
            }

        } else if (ftJson.POSITION_QUANTIZED) {

            const offset = ftJson.POSITION_QUANTIZED.byteOffset;
            const scale = ftJson.QUANTIZED_VOLUME_SCALE;
            const volOffset = ftJson.QUANTIZED_VOLUME_OFFSET;

            for (let i = 0; i < count; i++) {
                const qx = ftBin.readUInt16LE(offset + i*6);
                const qy = ftBin.readUInt16LE(offset + i*6 + 2);
                const qz = ftBin.readUInt16LE(offset + i*6 + 4);

                positions.push([
                    volOffset[0] + (qx / 65535.0) * scale[0],
                    volOffset[1] + (qy / 65535.0) * scale[1],
                    volOffset[2] + (qz / 65535.0) * scale[2],
                ]);
            }

        } else {
            throw new Error("No POSITION or POSITION_QUANTIZED");
        }

        const rtc = ftJson.RTC_CENTER ?? [0,0,0];

        return positions.map(p => [p[0] + rtc[0], p[1] + rtc[1], p[2] + rtc[2]]);
    }

    reprojectPositions(positions, targetCRS) {

        const transformed = positions.map(pECEF => {
            const [lon, lat, h] = proj4("EPSG:4978", 'EPSG:4326', pECEF);
            return proj4('EPSG:4326', targetCRS, [lon, lat, h]);
        });

        const center = [0,0,0];

        transformed.forEach(p => {
            center[0] += p[0];
            center[1] += p[1];
            center[2] += p[2];
        });

        center[0] /= transformed.length;
        center[1] /= transformed.length;
        center[2] /= transformed.length;

        const deltas = transformed.map(p => [
            p[0] - center[0],
            p[1] - center[1],
            p[2] - center[2],
        ]);

        return { deltas, center };
    }

    float32ArrayToBuffer(arr) {
        const buf = Buffer.alloc(arr.length * 4);
        arr.forEach((v, i) => buf.writeFloatLE(v, i*4));
        return buf;
    }

    pad8(buf, padchar) {
        const pad = (8 - (buf.length % 8)) % 8;
        return pad ? Buffer.concat([buf, Buffer.alloc(pad, padchar)]) : buf;
    }

    process(inPath, outPath, targetCRS) {

        const file = fs.readFileSync(inPath);

        // Read input
        const header = {
            magic: file.toString("utf8", 0, 4),
            version: file.readUInt32LE(4),
            byteLength: file.readUInt32LE(8),
            ftJsonLen: file.readUInt32LE(12),
            ftBinLen: file.readUInt32LE(16),
            btJsonLen: file.readUInt32LE(20),
            btBinLen: file.readUInt32LE(24),
            gltfFormat: file.readUInt32LE(28),
        };

        if (header.magic !== "i3dm") {
            throw new Error("Not an i3dm file");
        }

        let offset = 32;

        const ftJson = JSON.parse(file.slice(offset, offset + header.ftJsonLen).toString());
        offset += header.ftJsonLen;

        const ftBin = file.slice(offset, offset + header.ftBinLen);
        offset += header.ftBinLen;

        const btJson = file.slice(offset, offset + header.btJsonLen);
        offset += header.btJsonLen;

        const btBin = file.slice(offset, offset + header.btBinLen);
        offset += header.btBinLen;

        const gltf = file.slice(offset);

        // Decode and reproject positions
        const world = this.decodePositions(ftJson, ftBin);
        const {deltas, center} = this.reprojectPositions(world, targetCRS);

        // Write new feature table
        const newFtJson = { ...ftJson };
        delete newFtJson.POSITION_QUANTIZED;
        newFtJson.POSITION = { byteOffset: 0 };
        newFtJson.RTC_CENTER = center;

        let newFtBin = Buffer.concat(
            deltas.map(p => this.float32ArrayToBuffer(p))
        );

        const ftDataComponentSize = {
            "UNSIGNED_BYTE": 1,
            "UNSIGNED_SHORT": 2,
            "UNSIGNED_INT": 4
        }

        if (newFtJson.EAST_NORTH_UP) {
            // NOTE: 3d-tiles-renderer ignores any NORMAL_UP/NORMAL_RIGHT if EAST_NORTH_UP = True.
            // So just set it to False and set regular vertical-up normals
            const count = ftJson.INSTANCES_LENGTH;
            newFtJson.EAST_NORTH_UP = false;
            newFtJson.NORMAL_UP = {byteOffset: newFtBin.length};
            newFtBin = Buffer.concat([
                newFtBin,
                this.float32ArrayToBuffer(Array(count).fill([0,1,0]).flat())
            ]);

            newFtJson.NORMAL_RIGHT = { byteOffset: newFtBin.length };
            newFtBin = Buffer.concat([
                newFtBin,
                this.float32ArrayToBuffer(Array(count).fill([1,0,0]).flat())
            ]);

        } else {
            newFtBin = Buffer.concat([
                newFtBin,
                this.copyAttr(ftJson, ftBin, "NORMAL_UP", 4, 3, newFtJson, newFtBin),
                this.copyAttr(ftJson, ftBin, "NORMAL_RIGHT", 4, 3, newFtJson, newFtBin),
                this.copyAttr(ftJson, ftBin, "NORMAL_UP_OCT32P", 2, 2, newFtJson, newFtBin),
                this.copyAttr(ftJson, ftBin, "NORMAL_RIGHT_OCT32P", 2, 2, newFtJson, newFtBin),
            ]);
        }

        newFtBin = Buffer.concat([
            newFtBin,
            this.copyAttr(ftJson, ftBin, "SCALE", 4, 1, newFtJson, newFtBin),
            this.copyAttr(ftJson, ftBin, "SCALE_NON_UNIFORM", 4, 3, newFtJson, newFtBin),
        ]);

        if (ftJson.BATCH_ID) {
            const compSize = ftDataComponentSize[ftJson.BATCH_ID.componentType ?? "UNSIGNED_SHORT"];

            newFtBin = Buffer.concat([
                newFtBin,
                this.copyAttr(ftJson, ftBin, "BATCH_ID", compSize, 1, newFtJson, newFtBin)
            ]);
        }

        newFtBin = this.pad8(newFtBin, 0);

        let newFtJsonBuf = Buffer.from(JSON.stringify(newFtJson));
        newFtJsonBuf = this.pad8(newFtJsonBuf, ' ');

        // Recompute bounds based on data
        let minx = +Infinity, maxx = -Infinity;
        let miny = +Infinity, maxy = -Infinity;
        let minz = +Infinity, maxz = -Infinity;
        deltas.forEach(delta => {
            const p = [center[0] + delta[0], center[1] + delta[1], center[2] + delta[2]];
            minx = Math.min(minx, p[0]);
            maxx = Math.max(maxx, p[0]);
            miny = Math.min(miny, p[1]);
            maxy = Math.max(maxy, p[1]);
            minz = Math.min(minz, p[2]);
            maxz = Math.max(maxz, p[2]);
        });

        // Write output
        const totalLen =
            32 +
            newFtJsonBuf.length +
            newFtBin.length +
            btJson.length +
            btBin.length +
            gltf.length;

        const newHeader = Buffer.alloc(32);

        newHeader.write("i3dm", 0);
        newHeader.writeUInt32LE(header.version, 4);
        newHeader.writeUInt32LE(totalLen, 8);
        newHeader.writeUInt32LE(newFtJsonBuf.length, 12);
        newHeader.writeUInt32LE(newFtBin.length, 16);
        newHeader.writeUInt32LE(btJson.length, 20);
        newHeader.writeUInt32LE(btBin.length, 24);
        newHeader.writeUInt32LE(header.gltfFormat, 28);

        const out = Buffer.concat([
            newHeader,
            newFtJsonBuf,
            newFtBin,
            btJson,
            btBin,
            gltf
        ]);

        fs.writeFileSync(outPath, out);

        console.log(`byteLength: ${header.byteLength} => ${totalLen}`);
        console.log(`ftJsonLen: ${header.ftJsonLen} => ${newFtJsonBuf.length}`);
        console.log(`ftBinLen: ${header.ftBinLen} => ${newFtBin.length}`);
        console.log(`btJsonLen: ${header.btJsonLen} => ${btJson.length}`);
        console.log(`btBinLen: ${header.btBinLen} => ${btBin.length}`);
        console.log(`bounds: ${JSON.stringify({minx, miny, minz, maxx, maxy, maxz})}`)
        console.log(`✔ ${inPath}`);
        return {minx, miny, minz, maxx, maxy, maxz};
    }
}
