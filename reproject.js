#!/usr/bin/env node
/**
 * Copyright 2026 Sourcepole AG
 * All rights reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */


import fs from "fs";
import path from "path";
import proj4 from "proj4";
import {Vector3, Vector4, Matrix3, Matrix4} from "three";

import ReprojectI3DM from "./reproject_i3dm.js";
import ReprojectB3DM from "./reproject_b3dm.js";

// Projection definitions
proj4.defs("EPSG:4326", "+proj=longlat +datum=WGS84 +no_defs");
proj4.defs("EPSG:4978","+proj=geocent +datum=WGS84 +units=m +no_defs");
proj4.defs("EPSG:4979","+proj=longlat +datum=WGS84 +no_defs");


function expandBoxToCorners(box) {
    const cx = box[0], cy = box[1], cz = box[2];

    const ax = [box[3], box[4], box[5]];
    const ay = [box[6], box[7], box[8]];
    const az = [box[9], box[10], box[11]];

    const corners = [];

    // 8 combinations of ±A ±B ±C
    const signs = [-1, 1];

    for (const sx of signs) {
        for (const sy of signs) {
            for (const sz of signs) {
                corners.push([
                    cx + sx * ax[0] + sy * ay[0] + sz * az[0],
                    cy + sx * ax[1] + sy * ay[1] + sz * az[1],
                    cz + sx * ax[2] + sy * ay[2] + sz * az[2]
                ]);
            }
        }
    }
    return corners;
}

function reprojectRegionToBox(region, targetCRS) {
    let [west, south, east, north, hmin, hmax] = region;

    west = west / Math.PI * 180;
    south = south / Math.PI * 180;
    east = east / Math.PI * 180;
    north = north / Math.PI * 180;

    // 8 region corners
    const lons = [west, west, east, east];
    const lats = [south, north, south, north];

    let xmin = Infinity, ymin = Infinity, zmin = Infinity;
    let xmax = -Infinity, ymax = -Infinity, zmax = -Infinity;

    [hmin, hmax].forEach(h => {
        for (let i = 0; i < 4; ++i) {
          const [x, y, z] = proj4("EPSG:4979", targetCRS, [lons[i], lats[i], h]);
          xmin = Math.min(xmin, x);
          ymin = Math.min(ymin, y);
          zmin = Math.min(zmin, z);
          xmax = Math.max(xmax, x);
          ymax = Math.max(ymax, y);
          zmax = Math.max(zmax, z);
        }
    });

    const cx = (xmin + xmax) / 2;
    const cy = (ymin + ymax) / 2;
    const cz = (zmin + zmax) / 2;

    const hx = (xmax - xmin) / 2;
    const hy = (ymax - ymin) / 2;
    const hz = (zmax - zmin) / 2;

    return [
        cx, cy, cz,
        hx, 0, 0,
        0, hy, 0,
        0, 0, hz
    ];
}

function reprojectBox(box, transform, targetCRS) {
    const R = new Matrix3().setFromMatrix4(transform);
    const C = new Vector3(...box.slice(0, 3)).applyMatrix4(transform);
    const Hx = new Vector3(...box.slice(3, 6)).applyMatrix3(R);
    const Hy = new Vector3(...box.slice(6, 9)).applyMatrix3(R);
    const Hz = new Vector3(...box.slice(9, 12)).applyMatrix3(R);

    // Compute box corners (all +/- combinations) and apply transform
    const corners = [
        C.clone().addScaledVector(Hx,-1).addScaledVector(Hy,-1).addScaledVector(Hz,-1),
        C.clone().addScaledVector(Hx,-1).addScaledVector(Hy,-1).addScaledVector(Hz,+1),
        C.clone().addScaledVector(Hx,-1).addScaledVector(Hy,+1).addScaledVector(Hz,-1),
        C.clone().addScaledVector(Hx,-1).addScaledVector(Hy,+1).addScaledVector(Hz,+1),
        C.clone().addScaledVector(Hx,+1).addScaledVector(Hy,-1).addScaledVector(Hz,-1),
        C.clone().addScaledVector(Hx,+1).addScaledVector(Hy,-1).addScaledVector(Hz,+1),
        C.clone().addScaledVector(Hx,+1).addScaledVector(Hy,+1).addScaledVector(Hz,-1),
        C.clone().addScaledVector(Hx,+1).addScaledVector(Hy,+1).addScaledVector(Hz,+1)
    ];

    // Reproject ECEF => Geographic => target_crs
    let xmin = Infinity, ymin = Infinity, zmin = Infinity;
    let xmax = -Infinity, ymax = -Infinity, zmax = -Infinity;

    corners.forEach(corner => {
        const [lon, lat, h] = proj4('EPSG:4978', 'EPSG:4326', corner.toArray());
        const [x, y, z] = proj4('EPSG:4326', 'EPSG:25832', [lon, lat, h]);

        xmin = Math.min(xmin, x);
        ymin = Math.min(ymin, y);
        zmin = Math.min(zmin, z);
        xmax = Math.max(xmax, x);
        ymax = Math.max(ymax, y);
        zmax = Math.max(zmax, z);
    });

    return [
        0.5 * (xmin + xmax), 0.5 * (ymin + ymax), 0.5 * (zmin + zmax),
        0.5 * (xmax - xmin), 0, 0,
        0, 0.5 * (ymax - ymin), 0,
        0, 0, 0.5 * (zmax - zmin)
    ];
}

async function reprojectTile(entry, srcDir, dstDir, targetCRS, recomputeBounds, parentTransform=null) {

    let transform = parentTransform;

    if (entry.transform) {
        transform = new Matrix4().fromArray(entry.transform);
        if (parentTransform) {
            transform.premultiply(parentTransform);
        }
        // Set tansform to identity since we apply transforms to the reprojected boundingVolumes
        entry.transform = [
            1,0,0,0,
            0,1,0,0,
            0,0,1,0,
            0,0,0,1
        ];
    }

    const bv = entry.boundingVolume || {};

    if (bv.region) {
        bv.box = reprojectRegionToBox(bv.region, targetCRS);
        delete bv.region;
    } else if (bv.box) {
        bv.box = reprojectBox(bv.box, transform, targetCRS);
    }

    if (entry.content?.uri) {
        await reprojectTileContent(entry, srcDir, dstDir, targetCRS, recomputeBounds, transform);
    }

    if (entry.children?.length) {
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (const child of entry.children) {
            await reprojectTile(child, srcDir, dstDir, targetCRS, recomputeBounds, transform);

            // Recompute bounding volume
            const corners = expandBoxToCorners(child.boundingVolume.box);
            for (const [x, y, z] of corners) {
                if (x < minX) minX = x;
                if (y < minY) minY = y;
                if (z < minZ) minZ = z;

                if (x > maxX) maxX = x;
                if (y > maxY) maxY = y;
                if (z > maxZ) maxZ = z;
            }
        }
        if (recomputeBounds) {
            const cx = (minX + maxX) * 0.5;
            const cy = (minY + maxY) * 0.5;
            const cz = (minZ + maxZ) * 0.5;

            const hx = (maxX - minX) * 0.5;
            const hy = (maxY - minY) * 0.5;
            const hz = (maxZ - minZ) * 0.5;
            entry.boundingVolume.box = [
                cx, cy, cz,
                hx, 0, 0,
                0, hy, 0,
                0, 0, hz
            ];
        }
    }
}

async function reprojectTileContent(entry, srcDir, dstDir, targetCrs, recomputeBounds, transform) {
    const uri = entry.content.uri;
    const contentSrcDir = path.join(srcDir, path.dirname(uri));
    const contentDstDir = path.join(dstDir, path.dirname(uri));

    if (!fs.existsSync(contentDstDir)) {
        fs.mkdirSync(contentDstDir, { recursive: true });
    }

    // Handle implicit tiling
    if (entry.implicitTiling) {
        // Hack, just copy over all subtree files and process all i3dm/b3dm files
        const subtreeSrcDir = path.dirname(path.join(srcDir, entry.implicitTiling.subtrees.uri));
        const subtreeDstDir = path.dirname(path.join(dstDir, entry.implicitTiling.subtrees.uri));
        fs.cpSync(subtreeSrcDir, subtreeDstDir, { recursive: true });

        if (uri.endsWith(".i3dm")) {
            const reprojector = new ReprojectI3DM();
            for (const file of fs.readdirSync(contentSrcDir).filter(f => f.endsWith(".i3dm"))) {
                const srcI3dm = path.join(contentSrcDir, file);
                const dstI3dm = path.join(contentDstDir, file);
                console.log(`Transforming ${srcI3dm}...`);
                reprojector.process(srcI3dm, dstI3dm, targetCrs, transform);
            }
        } else if (uri.endsWith(".b3dm")) {
            const reprojector = new ReprojectB3DM();
            for (const file of fs.readdirSync(contentSrcDir).filter(f => f.endsWith(".b3dm"))) {
                const srcB3dm = path.join(contentSrcDir, file);
                const dstB3dm = path.join(contentDstDir, file);
                console.log(`Transforming ${srcB3dm}...`);
                reprojector.process(srcB3dm, dstB3dm, targetCrs, transform);
            }
        }
    } else if (uri.endsWith(".json")) {
        const srcTilesetJson = path.join(contentSrcDir, path.basename(uri));
        console.log(`Transforming ${srcTilesetJson}...`);
        const tileset = JSON.parse(fs.readFileSync(srcTilesetJson, "utf-8"));

        await reprojectTile(tileset.root || {}, contentSrcDir, contentDstDir, targetCrs);

        const dstTilesetJson = path.join(contentDstDir, path.basename(uri));
        fs.writeFileSync(dstTilesetJson, JSON.stringify(tileset, null, 2));

    } else {
        const src3dm = path.join(contentSrcDir, path.basename(uri));
        const dst3dm = path.join(contentDstDir, path.basename(uri));

        let reprojector;
        if (uri.endsWith(".i3dm")) {
            reprojector = new ReprojectI3DM();
        } else if (uri.endsWith(".b3dm")) {
            reprojector = new ReprojectB3DM();
        } else {
            console.log(`Skipping unsupported format: ${path.extname(src3dm)}`);
            return;
        }

        console.log(`Transforming ${src3dm}...`);
        const bounds = await reprojector.process(src3dm, dst3dm, targetCrs, transform, entry.boundingVolume);

        if (recomputeBounds) {
            const cx = (bounds.minx + bounds.maxx) * 0.5;
            const cy = (bounds.miny + bounds.maxy) * 0.5;
            const cz = (bounds.minz + bounds.maxz) * 0.5;
            const hx = (bounds.maxx - bounds.minx) * 0.5;
            const hy = (bounds.maxy - bounds.miny) * 0.5;
            const hz = (bounds.maxz - bounds.minz) * 0.5;
            entry.boundingVolume.box = [
            cx, cy, cz,
            hx, 0, 0,
            0, hy, 0,
            0, 0, hz
            ];
        }
    }
}

// --- MAIN ---
if (process.argv.length < 5) {
    console.error("Usage: node reproject.js src_dir dst_dir target_crs --recompute-bounds");
    process.exit(1);
}

const [,, srcDir, dstDir, targetCRS] = process.argv;

const recomputeBounds = process.argv.length > 5 && process.argv[5] === "--recompute-bounds";
if (recomputeBounds) {
    console.log("Bounds will be recomputed from transformed coordinates");
}

const srcTileset = path.join(srcDir, "tileset.json");
const dstTileset = path.join(dstDir, "tileset.json");

if (fs.existsSync("projections.json")) {
    const projections = JSON.parse(fs.readFileSync("projections.json"));
    Object.entries(projections).forEach(([code, def]) => {
        console.log(`Registering projection ${code}`);
        proj4.defs(code, def);
    });
}

if (!proj4.defs(targetCRS)) {
    console.error(`Missing CRS definition for ${targetCRS}, please add it to 'projections.json'.`);
    process.exit(1);
}

if (!fs.existsSync(srcTileset)) {
    console.error("Missing tileset.json");
    process.exit(1);
}

if (fs.existsSync(dstDir)) {
    console.error(`Destination dir ${dstDir} already exists, please remove it.`);
    process.exit(1);
}

fs.mkdirSync(dstDir);

const tileset = JSON.parse(fs.readFileSync(srcTileset));
await reprojectTile(tileset.root || {}, srcDir, dstDir, targetCRS, recomputeBounds);

fs.writeFileSync(dstTileset, JSON.stringify(tileset, null, 2));

console.log("Done!");
