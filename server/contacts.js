'use strict';

// 已发布报告 · 细胞空间接触簇（只读；只使用报告冻结的轮廓与定标）
//
// 净区域：细胞外轮廓内部（含外边界）扣除全部孔洞【内部】后的闭集区域——
//         孔洞边界仍属于净区域边界（孔洞是“挖空”，其边界是材料的一部分）。
// 最短净区域间距 dist(N(A), N(B))：
//   - 两净区域有任何交集（面积重叠 / 外边界接触 / 一方完全落入另一方净区域内）→ 0；
//   - 细胞仅落在另一细胞孔洞内、未触及对方净区域 → 不算接触，间距为到孔洞边界的正距离；
//   - 其余相离情形 → 两细胞全部环边（外环 + 孔洞边）之间的最短欧氏距离。
// 邻接：最短净区域间距 ≤ 阈值（μm）；邻接关系构成无向图，连通分量即接触簇。
//
// 坐标为图片原始像素；scale 为报告冻结的 μm/px。阈值仅用于本次查询，不写回报告。

const geo = require('./geometry');

const DIST_EPS = 1e-7;   // 距离归零/阈值容差（输入坐标精度 1e-3，远小于真实点间距）
const OUT_DP = 6;         // 距离输出小数位

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// 解析间距阈值（μm）：允许 0；缺失/非有限数/负数均抛出带明确信息的错误
function parseThreshold(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('间距阈值无效：必须是有限数值（微米），可使用 0；NaN/Infinity 或非数字均不被接受');
  }
  if (value < 0) {
    throw new Error(`间距阈值无效：不能为负数（当前 ${value} μm）；允许 0（仅统计边界接触/区域重叠）`);
  }
  return value;
}

function cellKey(cell, index) {
  return (cell && typeof cell.id === 'string' && cell.id) ? cell.id : `#${index}`;
}

function cellLabel(cell, index) {
  return (cell && cell.name && String(cell.name).trim()) || `细胞 ${index + 1}`;
}

function allRings(cell) {
  return [cell.outer].concat(cell.holes || []);
}

// 细胞全部环顶点的轴对齐包围盒（冻结数据已校验，外环必有顶点）
function cellBBox(cell) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ring of allRings(cell)) {
    for (const p of ring) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  return { minX, minY, maxX, maxY };
}

// 点 p 是否位于细胞净区域（闭集）：在外环内部或边界上，且不在任何孔洞【内部】
// （孔洞边界属于净区域边界，仍算在内）。
function pointInNetOrOn(p, cell) {
  if (!geo.pointInsideOrOn(p, cell.outer)) return false;
  for (const h of cell.holes || []) {
    if (geo.pointStrictlyInside(p, h)) return false;
  }
  return true;
}

function ringEdges(ring) {
  const edges = [];
  for (let i = 0; i < ring.length; i++) {
    edges.push([ring[i], ring[(i + 1) % ring.length]]);
  }
  return edges;
}

// 两线段间最近点对与欧氏距离：{dist, p, q}（交叉/端点落于对方线段上均得到 dist=0）
function closestSegmentPoints(a, b, c, d) {
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const qx = d.x - c.x;
  const qy = d.y - c.y;
  const r2 = rx * rx + ry * ry || 1;
  const q2 = qx * qx + qy * qy || 1;
  let u = ((c.x - a.x) * rx + (c.y - a.y) * ry) / r2;
  u = Math.max(0, Math.min(1, u));
  let t = ((a.x + u * rx - c.x) * qx + (a.y + u * ry - c.y) * qy) / q2;
  t = Math.max(0, Math.min(1, t));
  const p = { x: a.x + u * rx, y: a.y + u * ry };
  const q = { x: c.x + t * qx, y: c.y + t * qy };
  return { dist: Math.hypot(p.x - q.x, p.y - q.y), p, q };
}

// 两个细胞净区域之间的最短距离（像素）及最近点对。
// 返回 {distPx, contact, from, to}；contact=true 即净区域有交集（距离 0）。
// maxGapPx：调用方给出的间距阈值（像素）；当两细胞【包围盒在 x 或 y 方向的净间隙】
//           已严格大于该阈值时，可直接判定相离过远、跳过全部边对（包围盒相离时
//           间隙即为点集距离下界；嵌套/重叠包围盒不适用此快速判定，仍走完整计算）。
function pairDistancePx(cellA, cellB, maxGapPx) {
  const boxA = cellBBox(cellA);
  const boxB = cellBBox(cellB);
  const gapX = Math.max(0, boxA.minX - boxB.maxX, boxB.minX - boxA.maxX);
  const gapY = Math.max(0, boxA.minY - boxB.maxY, boxB.minY - boxA.maxY);
  if (Number.isFinite(maxGapPx) &&
      (gapX > maxGapPx + DIST_EPS || gapY > maxGapPx + DIST_EPS)) {
    return { distPx: Math.max(gapX, gapY), contact: false, far: true, from: null, to: null };
  }

  const ringsA = allRings(cellA);
  const ringsB = allRings(cellB);

  // 1) 任一环顶点落在对方净区域（含边界）：外环顶点在对方外环内/边界上、
  //    孔洞顶点（孔洞边界）触到对方净区域、一方完全被另一方净区域包含 → 距离 0
  for (const ring of ringsA) {
    for (const p of ring) {
      if (pointInNetOrOn(p, cellB)) return { distPx: 0, contact: true, from: p, to: p };
    }
  }
  for (const ring of ringsB) {
    for (const p of ring) {
      if (pointInNetOrOn(p, cellA)) return { distPx: 0, contact: true, from: p, to: p };
    }
  }

  // 2) 全部环边两两求最近点：距离为 0 时接触点必须同时属于两个净区域。
  //    纯在双方孔洞内部的相交互（一个细胞钻进对方孔洞里的孔洞交叠）不算接触。
  let best = null;
  for (const ra of ringsA) {
    for (const [a, b] of ringEdges(ra)) {
      for (const rb of ringsB) {
        for (const [c, d] of ringEdges(rb)) {
          const g = closestSegmentPoints(a, b, c, d);
          if (g.dist <= DIST_EPS) {
            const p = g.p; // 距离近似为 0，p、q 即同一接触点
            if (pointInNetOrOn(p, cellA) && pointInNetOrOn(p, cellB)) {
              return { distPx: 0, contact: true, from: p, to: p };
            }
            continue; // 接触点只在孔洞内部：不是净区域接触，继续找其它边对
          }
          if (!best || g.dist < best.distPx) {
            best = { distPx: g.dist, from: g.p, to: g.q };
          }
        }
      }
    }
  }
  if (best) return { contact: false, ...best };

  // 退化防御（无有效边时）：按顶点间距
  let fallback = null;
  for (const ra of ringsA) for (const p of ra) {
    for (const rb of ringsB) for (const q of rb) {
      const dist = Math.hypot(p.x - q.x, p.y - q.y);
      if (!fallback || dist < fallback.distPx) fallback = { distPx: dist, from: p, to: q };
    }
  }
  return fallback || { distPx: Infinity, contact: false, from: null, to: null };
}

function round6(v) {
  return Math.round(v * 10 ** OUT_DP) / 10 ** OUT_DP;
}

// 并查集：由阈值内邻接关系生成连通簇
class DSU {
  constructor(n) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x) {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
}

// 计算一份报告冻结细胞在给定间距阈值下的邻接关系与连通簇。
// cells：报告冻结细胞；scale：冻结定标 μm/px（发布校验保证已定标，仍防御 null）。
function buildContactClusters(cells, scale, thresholdUm) {
  const list = Array.isArray(cells) ? cells : [];
  const n = list.length;
  const dsu = new DSU(n);
  const meta = list.map((cell, i) => ({
    index: i,
    key: cellKey(cell, i),
    name: cellLabel(cell, i),
    seq: i + 1
  }));

  const calibrated = isNum(scale) && scale > 0;
  // 阈值是微米；已定标时按 μm 判定，像素侧粗筛换算用 threshold/scale
  const thresholdPx = calibrated ? thresholdUm / scale : null;
  const within = (p) => calibrated
    ? (p.distanceUm !== null && p.distanceUm <= thresholdUm + DIST_EPS * Math.max(1, Math.abs(thresholdUm)))
    : false;

  // 全部细胞对的最短净区域间距（像素 → 微米）；包围盒相离超过阈值的对走粗筛直接跳过
  const allPairs = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const g = pairDistancePx(list[i], list[j], thresholdPx);
      if (g.far) continue; // 包围盒间隙已超过阈值：不可能构成邻接，也不参与本次展示
      const distPx = g.distPx === Infinity ? Infinity : Math.max(0, g.distPx);
      const distUmRaw = isNum(scale) ? distPx * scale : null;
      allPairs.push({
        i, j,
        distancePx: distPx === Infinity ? null : round6(distPx),
        distanceUm: distUmRaw === null ? null : round6(distUmRaw),
        contact: !!g.contact,
        from: g.from,
        to: g.to
      });
    }
  }

  const adjacencyPairs = [];
  for (const p of allPairs) {
    if (within(p)) {
      adjacencyPairs.push(p);
      dsu.union(p.i, p.j);
    }
  }
  const cmpDist = (a, b) => {
    if (a.distanceUm !== b.distanceUm) return a.distanceUm < b.distanceUm ? -1 : 1;
    return a.i - b.i;
  };
  adjacencyPairs.sort(cmpDist);

  // 每细胞的阈值内邻居（按间距升序）
  const neighborMap = Array.from({ length: n }, () => []);
  for (const p of adjacencyPairs) {
    neighborMap[p.i].push({ index: p.j, distancePx: p.distancePx, distanceUm: p.distanceUm, contact: p.contact });
    neighborMap[p.j].push({ index: p.i, distancePx: p.distancePx, distanceUm: p.distanceUm, contact: p.contact });
  }
  neighborMap.forEach((arr) => arr.sort((a, b) => {
    if (a.distanceUm !== b.distanceUm) return a.distanceUm < b.distanceUm ? -1 : 1;
    return a.index - b.index;
  }));

  // 连通簇分组：按成员最小细胞序号稳定输出（无邻接时每个细胞各成独立簇）
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = dsu.find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  }
  const minMember = (arr) => arr.reduce((m, x) => (x < m ? x : m), arr[0]);
  const groupLists = [...groups.values()]
    .sort((a, b) => minMember(a) - minMember(b));
  const clusterById = new Map();
  const clusters = groupLists.map((members, ci) => {
    const id = `c${ci + 1}`;
    const cluster = {
      id,
      size: members.length,
      cellKeys: members.map((x) => meta[x].key),
      cells: members.map((x) => ({ key: meta[x].key, name: meta[x].name, seq: meta[x].seq })),
      adjacencies: adjacencyPairs
        .filter((p) => dsu.find(p.i) === dsu.find(members[0]))
        .sort(cmpDist)
        .map((p) => ({
          a: { key: meta[p.i].key, name: meta[p.i].name, seq: meta[p.i].seq },
          b: { key: meta[p.j].key, name: meta[p.j].name, seq: meta[p.j].seq },
          distancePx: p.distancePx,
          distanceUm: p.distanceUm,
          contact: p.contact,
          nearestPointPx: p.contact ? null : { from: p.from, to: p.to }
        }))
    };
    for (const x of members) clusterById.set(x, id);
    return cluster;
  });

  const cellViews = meta.map((m, i) => ({
    key: m.key,
    name: m.name,
    seq: m.seq,
    clusterId: clusterById.get(i),
    neighborCount: neighborMap[i].length,
    neighbors: neighborMap[i].map((nb) => ({
      key: meta[nb.index].key,
      name: meta[nb.index].name,
      seq: meta[nb.index].seq,
      distancePx: nb.distancePx,
      distanceUm: nb.distanceUm,
      contact: nb.contact
    }))
  }));

  const adjacencyViews = adjacencyPairs.map((p) => ({
    a: { key: meta[p.i].key, name: meta[p.i].name, seq: meta[p.i].seq },
    b: { key: meta[p.j].key, name: meta[p.j].name, seq: meta[p.j].seq },
    distancePx: p.distancePx,
    distanceUm: p.distanceUm,
    contact: p.contact,
    nearestPointPx: p.contact ? null : { from: p.from, to: p.to }
  }));

  return {
    kind: 'contact-clusters',
    thresholdUm,
    calibrated,
    scaleUmPerPx: calibrated ? scale : null,
    cellCount: n,
    adjacencyCount: adjacencyViews.length,
    clusterCount: clusters.length,
    multiCellClusterCount: clusters.filter((c) => c.size > 1).length,
    cells: cellViews,
    adjacencies: adjacencyViews,
    clusters
  };
}

module.exports = {
  parseThreshold,
  buildContactClusters,
  pairDistancePx,
  pointInNetOrOn
};
