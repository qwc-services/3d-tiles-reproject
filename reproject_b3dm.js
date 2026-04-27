import draco3d from 'draco3dgltf';
import fs from "fs";
import proj4 from "proj4";

import {NodeIO} from "@gltf-transform/core";
import {ALL_EXTENSIONS} from '@gltf-transform/extensions';
import {Matrix3, Matrix4, Vector3} from "three";


export default class ReprojectB3DM {
    async process(inPath, outPath, targetCRS, transform) {
        const file = fs.readFileSync(inPath);

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

        const ftBin = file.slice(offset, offset + header.ftBinLen);
        offset += header.ftBinLen;

        const btJson = file.slice(offset, offset + header.btJsonLen);
        offset += header.btJsonLen;

        const btBin = file.slice(offset, offset + header.btBinLen);
        offset += header.btBinLen;

        const glb = file.slice(offset);

        const io = new NodeIO()
        .registerExtensions(ALL_EXTENSIONS)
        .registerDependencies({
            'draco3d.decoder': await draco3d.createDecoderModule(),
            'draco3d.encoder': await draco3d.createEncoderModule(),
        });
        let minx = +Infinity, maxx = -Infinity;
        let miny = +Infinity, maxy = -Infinity;
        let minz = +Infinity, maxz = -Infinity;

        const doc = await io.readBinary(glb);
        for (const node of doc.getRoot().listNodes()) {
            const mesh = node.getMesh();
            if (!mesh) continue;

            const nodeWorld = new Matrix4().fromArray(node.getWorldMatrix());
            const fullMatrix = transform;//.clone().multiply(nodeWorld);
            const normalMatrix = new Matrix3().getNormalMatrix(fullMatrix);

            for (const prim of mesh.listPrimitives()) {
                const posAccessor = prim.getAttribute('POSITION');
                const norAccessor = prim.getAttribute('NORMAL');

                const posArray = posAccessor.getArray();
                for (let i = 0; i < posArray.length; i += 3) {
                    const pECEF = new Vector3(...posArray.slice(i, i + 3)).applyMatrix4(fullMatrix);
                    const [lon, lat, h] = proj4("EPSG:4978", 'EPSG:4326', pECEF.toArray());
                    const pProj = proj4('EPSG:4326', 'EPSG:25832', [lon, lat, h]);
                    posArray[i] = pProj[0];
                    posArray[i+1] = pProj[1];
                    posArray[i+2] = pProj[2];
                    // posArray[i+1] = pProj[2];
                    // posArray[i+2] = -pProj[1];
                    minx = Math.min(minx, posArray[i]);
                    maxx = Math.max(maxx, posArray[i]);
                    miny = Math.min(miny, posArray[i+1]);
                    maxy = Math.max(maxy, posArray[i+1]);
                    minz = Math.min(minz, posArray[i+2]);
                    maxz = Math.max(maxz, posArray[i+2]);
                }

                if (norAccessor) {
                    const norArray = norAccessor.getArray();
                    for (let i = 0; i < norArray.length; i += 3) {
                        const n = new Vector3(...norArray.slice(i, i + 3)).applyMatrix3(normalMatrix).normalize();
                        norArray[i] = n.x;
                        norArray[i+1] = n.y;
                        norArray[i+2] = n.z;
                        // norArray[i+1] = n.z;
                        // norArray[i+2] = -n.y;
                    }
                }
            }

            // Set transform to identity
            node.setMatrix([
                1, 0, 0, 0,
                0, 0,-1, 0,
                0, 1, 0, 0,
                0, 0, 0, 1
            ]);
            /*node.setMatrix([
                1, 0, 0, 0,
                0, 1, 0, 0,
                0, 0, 1, 0,
                0, 0, 0, 1
            ]);*/
            // node.setTranslation([0, 0, 0]);
            // node.setRotation([0, 0, 0, 1]);
            // node.setScale([1, 1, 1]);
        }
        console.log({minz, maxz})

        const newGlb = await io.writeBinary(doc);
        await io.write('model.glb', doc);


        const totalLen =
            28 +
            ftJsonBin.length +
            ftBin.length +
            btJson.length +
            btBin.length +
            newGlb.length;

        const newHeader = Buffer.alloc(28);

        newHeader.write("b3dm", 0);
        newHeader.writeUInt32LE(header.version, 4);
        newHeader.writeUInt32LE(totalLen, 8);
        newHeader.writeUInt32LE(ftJsonBin.length, 12);
        newHeader.writeUInt32LE(ftBin.length, 16);
        newHeader.writeUInt32LE(btJson.length, 20);
        newHeader.writeUInt32LE(btBin.length, 24);

        const out = Buffer.concat([
            newHeader,
            ftJsonBin,
            ftBin,
            btJson,
            btBin,
            newGlb
        ]);

        fs.writeFileSync(outPath, out);

        console.log(`✔ ${inPath}`);
        console.log(`byteLength: ${header.byteLength} => ${totalLen}`);
        console.log(`ftJsonLen: ${header.ftJsonLen} => ${ftJsonBin.length}`);
        console.log(`ftBinLen: ${header.ftBinLen} => ${ftBin.length}`);
        console.log(`btJsonLen: ${header.btJsonLen} => ${btJson.length}`);
        console.log(`btBinLen: ${header.btBinLen} => ${btBin.length}`);
        console.log({minx, miny, minz, maxx, maxy, maxz})
        return {minx, miny, minz, maxx, maxy, maxz};
    }
}
