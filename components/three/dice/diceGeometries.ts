// Die geometry factory: builds per-sides BufferGeometries whose triangles are
// grouped into logical faces (one material group per face), with planar UVs and
// engraved-number CanvasTextures. Everything is cached at module level so each
// die shape is built exactly once per session.
//
// Client-only: createFaceMaterial touches `document`. This module is only ever
// imported by client components loaded via next/dynamic({ ssr: false }).

import * as THREE from "three";

export type DieSides = 4 | 6 | 8 | 10 | 12 | 20;

export type DieBuild = {
  geometry: THREE.BufferGeometry;
  materials: THREE.Material[];
  /** Average LOCAL-space outward normal of logical face i, normalized. */
  faceNormals: THREE.Vector3[];
  /**
   * The number drawn on logical face i (1..sides).
   * d4 exception: a d4 rests on a face, so faceValues[i] is read as "the value
   * rolled when face i is DOWN" — callers must argmin the up-dot for a d4.
   */
  faceValues: number[];
};

const OBSIDIAN = "#14101f";
const PARCHMENT = "#e8dcc0";
const GOLD_BRIGHT = "#e8c87a";
const GOLD_RING = "rgba(201, 164, 92, 0.3)";

const dieCache = new Map<DieSides, DieBuild>();

/**
 * Pentagonal trapezohedron (d10): two staggered pentagonal rings at +/-c plus
 * two apexes at +/-1 along z. PolyhedronGeometry projects every vertex onto its
 * bounding sphere, so c is chosen such that the kite faces are exactly planar
 * AFTER that projection: planarity requires apex = (5 + 2*sqrt(5)) * ringHeight
 * at unit ring radius, which post-projection solves to c = 1/sqrt(K^2 - 1).
 */
function d10Geometry(radius: number): THREE.BufferGeometry {
  const K = 5 + 2 * Math.sqrt(5);
  const c = 1 / Math.sqrt(K * K - 1);
  const vertices: number[] = [];
  for (let k = 0; k < 10; k++) {
    const a = (k * Math.PI * 2) / 10;
    vertices.push(Math.cos(a), Math.sin(a), c * (k % 2 === 0 ? 1 : -1));
  }
  vertices.push(0, 0, -1); // index 10: bottom apex
  vertices.push(0, 0, 1); //  index 11: top apex

  // 10 kite faces, each split into 2 triangles along its long diagonal
  // (apex -> far vertex). Winding is CCW seen from outside.
  const indices: number[] = [];
  for (let k = 0; k < 10; k += 2) {
    const u0 = k; //               upper-ring vertex (+c)
    const lo = (k + 1) % 10; //    lower-ring vertex (-c)
    const u1 = (k + 2) % 10; //    next upper-ring vertex
    const lo1 = (k + 3) % 10; //   next lower-ring vertex
    // top kite [apex11, u0, lo, u1], diagonal apex11-lo
    indices.push(11, u0, lo, 11, lo, u1);
    // bottom kite [apex10, lo, u1, lo1], diagonal apex10-u1
    indices.push(10, u1, lo, 10, lo1, u1);
  }
  return new THREE.PolyhedronGeometry(vertices, indices, radius, 0);
}

function baseGeometry(sides: DieSides): THREE.BufferGeometry {
  // Radii tuned so all dice read as roughly the same visual mass (~0.55 world
  // units): boxy/pointy shapes get a slightly larger circumradius.
  switch (sides) {
    case 4:
      return new THREE.TetrahedronGeometry(0.62, 0);
    case 6:
      return new THREE.BoxGeometry(0.62, 0.62, 0.62);
    case 8:
      return new THREE.OctahedronGeometry(0.58, 0);
    case 10:
      return d10Geometry(0.55);
    case 12:
      return new THREE.DodecahedronGeometry(0.55, 0);
    case 20:
      return new THREE.IcosahedronGeometry(0.55, 0);
  }
}

// The face texture maps edge-to-edge onto the face polygon, so the numeral
// must stay WELL inside it — on triangular faces (d4/d8/d20) the inscribed
// safe zone is small, and oversized digits visually collide with neighboring
// faces' digits at shared edges ("numbers overlapping").
const FONT_PX: Record<DieSides, number> = { 4: 34, 6: 50, 8: 38, 10: 42, 12: 44, 20: 32 };

function createFaceMaterial(
  value: number,
  isMax: boolean,
  sides: DieSides,
): THREE.MeshStandardMaterial {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d")!;

  ctx.fillStyle = OBSIDIAN;
  ctx.fillRect(0, 0, 128, 128);

  const font = FONT_PX[sides];

  // subtle engraved ring hugging the numeral, not the face edge
  ctx.strokeStyle = GOLD_RING;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(64, 64, font * 0.72, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = isMax ? GOLD_BRIGHT : PARCHMENT;
  ctx.font = `bold ${font}px monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(value), 64, 65);
  // underline 6 and 9 so they cannot be confused at arbitrary orientations
  if (value === 6 || value === 9) {
    ctx.fillRect(64 - font * 0.28, 64 + font * 0.56, font * 0.56, Math.max(2, font * 0.06));
  }

  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;

  return new THREE.MeshStandardMaterial({ map, roughness: 0.35, metalness: 0.2 });
}

type Cluster = { rep: THREE.Vector3; sum: THREE.Vector3; tris: number[] };

export function buildDie(sides: DieSides): DieBuild {
  const cached = dieCache.get(sides);
  if (cached) return cached;

  let source = baseGeometry(sides);
  if (source.index) {
    const nonIndexed = source.toNonIndexed();
    source.dispose();
    source = nonIndexed;
  }

  const pos = source.getAttribute("position") as THREE.BufferAttribute;
  const triCount = pos.count / 3;

  // --- cluster coplanar triangles into logical faces (by outward normal) ----
  const va = new THREE.Vector3();
  const vb = new THREE.Vector3();
  const vc = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const triNormal = new THREE.Vector3();

  const clusters: Cluster[] = [];
  for (let t = 0; t < triCount; t++) {
    va.fromBufferAttribute(pos, t * 3);
    vb.fromBufferAttribute(pos, t * 3 + 1);
    vc.fromBufferAttribute(pos, t * 3 + 2);
    ab.subVectors(vb, va);
    ac.subVectors(vc, va);
    triNormal.crossVectors(ab, ac).normalize();

    let home: Cluster | null = null;
    for (const cluster of clusters) {
      if (cluster.rep.dot(triNormal) > 0.99) {
        home = cluster;
        break;
      }
    }
    if (home) {
      home.sum.add(triNormal);
      home.rep.copy(home.sum).normalize();
      home.tris.push(t);
    } else {
      clusters.push({ rep: triNormal.clone(), sum: triNormal.clone(), tris: [t] });
    }
  }

  // --- rebuild with cluster-contiguous triangles, groups, and planar UVs ----
  const outPos = new Float32Array(pos.count * 3);
  const outUv = new Float32Array(pos.count * 2);
  const geometry = new THREE.BufferGeometry();
  const faceNormals: THREE.Vector3[] = [];

  const tangent = new THREE.Vector3();
  const bitangent = new THREE.Vector3();
  const helper = new THREE.Vector3();
  const p = new THREE.Vector3();

  let vertexOffset = 0;
  clusters.forEach((cluster, faceIndex) => {
    const n = cluster.rep.clone();
    faceNormals.push(n);

    // orthonormal frame in the face plane
    helper.set(0, 1, 0);
    if (Math.abs(n.y) > 0.9) helper.set(1, 0, 0);
    tangent.crossVectors(helper, n).normalize();
    bitangent.crossVectors(n, tangent);

    const start = vertexOffset;
    const count = cluster.tris.length * 3;

    // copy positions + raw planar projection, tracking extents
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    let vi = start;
    for (const t of cluster.tris) {
      for (let corner = 0; corner < 3; corner++) {
        p.fromBufferAttribute(pos, t * 3 + corner);
        outPos[vi * 3] = p.x;
        outPos[vi * 3 + 1] = p.y;
        outPos[vi * 3 + 2] = p.z;
        const u = p.dot(tangent);
        const v = p.dot(bitangent);
        outUv[vi * 2] = u;
        outUv[vi * 2 + 1] = v;
        if (u < minU) minU = u;
        if (u > maxU) maxU = u;
        if (v < minV) minV = v;
        if (v > maxV) maxV = v;
        vi++;
      }
    }

    // Normalize this face's UV slice: uniform scale from the bbox, but center
    // on the polygon CENTROID — bbox-centering puts the numeral off the face
    // middle on triangles/kites, cropping digits at edges. (Texture clamps to
    // edge; the canvas is plain obsidian out there, so spill is invisible.)
    const scale = Math.max(maxU - minU, maxV - minV) || 1;
    let cu = 0;
    let cv = 0;
    for (let k = start; k < start + count; k++) {
      cu += outUv[k * 2];
      cv += outUv[k * 2 + 1];
    }
    cu /= count;
    cv /= count;
    for (let k = start; k < start + count; k++) {
      outUv[k * 2] = 0.5 + (outUv[k * 2] - cu) / scale;
      outUv[k * 2 + 1] = 0.5 + (outUv[k * 2 + 1] - cv) / scale;
    }

    geometry.addGroup(start, count, faceIndex);
    vertexOffset += count;
  });

  geometry.setAttribute("position", new THREE.BufferAttribute(outPos, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(outUv, 2));
  geometry.computeVertexNormals(); // non-indexed => flat per-face normals
  source.dispose();

  // faceValues[i] = i + 1: any consistent assignment works because PhysicalDie
  // visually remaps the settled face to the server result afterwards.
  const faceValues = clusters.map((_, i) => i + 1);
  const materials: THREE.Material[] = faceValues.map((value) =>
    createFaceMaterial(value, value === sides, sides),
  );

  const build: DieBuild = { geometry, materials, faceNormals, faceValues };
  dieCache.set(sides, build);
  return build;
}
