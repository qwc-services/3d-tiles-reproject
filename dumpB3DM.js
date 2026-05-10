import draco3d from 'draco3dgltf';
import fs from "fs";
import path from "path";

import {NodeIO} from "@gltf-transform/core";
import {ALL_EXTENSIONS} from '@gltf-transform/extensions';
import {Vector3, Matrix4} from "three";

async function dumpB3DM(filename) {
    const tileTransform = new Matrix4().identity();

    const file = fs.readFileSync(filename);

    // --- HEADER ---
    const header = {
        magic: file.toString("utf8", 0, 4),
        version: file.readUInt32LE(4),
        byteLength: file.readUInt32LE(8),
        ftJsonLen: file.readUInt32LE(12),
        ftBinLen: file.readUInt32LE(16),
        btJsonLen: file.readUInt32LE(20),
        btBinLen: file.readUInt32LE(24),
    };

    if (header.magic !== "b3dm") {
        throw new Error("Not an b3dm file");
    }

    let offset = 28;

    const ftJsonBin = file.slice(offset, offset + header.ftJsonLen);
    offset += header.ftJsonLen;
    console.log("Feature table");
    console.log("=============");
    console.log(ftJsonBin.toString());
    console.log("");

    const ftBin = file.slice(offset, offset + header.ftBinLen);
    offset += header.ftBinLen;

    const btJson = file.slice(offset, offset + header.btJsonLen);
    offset += header.btJsonLen;
    console.log("Batch table");
    console.log("===========");
    console.log(btJson.toString());
    console.log("");

    const btBin = file.slice(offset, offset + header.btBinLen);
    offset += header.btBinLen;

    const glb = file.slice(offset);

    const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
        'draco3d.decoder': await draco3d.createDecoderModule(),
        'draco3d.encoder': await draco3d.createEncoderModule(),
    });

    const doc = await io.readBinary(glb);

    for (const node of doc.getRoot().listNodes()) {
        console.log("NODE")
        console.log("====")
        console.log("* translation")
        console.log(node.getTranslation())
        console.log("* rotation")
        console.log(node.getRotation())
        console.log("* scale")
        console.log(node.getScale())
        const mesh = node.getMesh();
        if (!mesh) continue;
        console.log("* first position")
        for (const prim of mesh.listPrimitives()) {
            const posAccessor = prim.getAttribute('POSITION');
            const posArray = posAccessor.getArray();
            for (let i = 0; i < posArray.length; i += 3) {
                console.log([...posArray.slice(i, i + 3)])
                break;
            }
        }
        console.log("");
    }
    await io.write(path.basename(filename) + ".glb", doc);
    console.log(`Wrote ${path.basename(filename) + ".glb"}`);
}

if (process.argv.length < 3) {
    console.error(`Usage: node ${process.argv[1]} file.b3dm`);
    process.exit(1);
}

const [,, filename] = process.argv;
await dumpB3DM(filename);
