3d-tiles-reproject
==================

A script to reproject 3D tiles from ECEF to a projected coordinate system.

It currently supports 3D tiles 1.0 B3DM and I3DM tilesets.

Usage:

- Install NodeJS, then install the package dependencies by running:
```sh
npm install
```

- Register your target projection definition in a file called `projections.json` and place next to the `reproject.js` script. Example:
```json
{
  "EPSG:25832": "+proj=utm +zone=32 +ellps=GRS80 +units=m +no_defs"
}
```
- Run the conversion:
```sh
node reproject.js path/to/source_tileset/ path/to/output target_epsg [--recompute-bounds]
```
The last `--recompute-bounds` parameter is optional and will instruct the script to recompute the tile bounding volume based on the actual transformed coordinates rather than using the reprojected bounding volumes of the source tileset.
