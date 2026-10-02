'use strict';

// 细胞空间接触簇纯逻辑快速自测（node test-contacts.js）：
// 阈值校验、净区域距离（相离/接触/重叠/嵌套/孔洞内不算接触）、阈值邻接与连通簇

const assert = require('assert');
const cc = require('./server/contacts');

const sq = (x, y, w = 10, h = w, extra = {}) => ({
  id: `s-${x}-${y}-${w}`,
  name: '',
  outer: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }],
  holes: [],
  ...extra
});

// 1. 阈值校验：负数 / NaN / Infinity / 非数字拒绝；0 与正数通过
assert.throws(() => cc.parseThreshold(-0.0001), /不能为负数/);
assert.throws(() => cc.parseThreshold(-5), /不能为负数/);
assert.throws(() => cc.parseThreshold(NaN), /有限数值/);
assert.throws(() => cc.parseThreshold(Infinity), /有限数值/);
assert.throws(() => cc.parseThreshold(-Infinity), /有限数值/);
assert.throws(() => cc.parseThreshold('3'), /有限数值/);
assert.throws(() => cc.parseThreshold(undefined), /有限数值/);
assert.throws(() => cc.parseThreshold(null), /有限数值/);
assert.strictEqual(cc.parseThreshold(0), 0);
assert.strictEqual(cc.parseThreshold(12.5), 12.5);
console.log('ok 1 间距阈值：负数/非有限数/非数字拒绝，0 与正数通过');

// 2. 最短净区域距离：相离给出正距离，接触/重叠/嵌套为 0
assert.strictEqual(cc.pairDistancePx(sq(0, 0), sq(20, 0)).contact, false);
assert.strictEqual(cc.pairDistancePx(sq(0, 0), sq(20, 0)).distPx, 10);
assert.strictEqual(cc.pairDistancePx(sq(0, 0), sq(10, 0)).contact, true);   // 外边界贴合
assert.strictEqual(cc.pairDistancePx(sq(0, 0), sq(5, 0)).contact, true);    // 面积重叠
assert.strictEqual(cc.pairDistancePx(sq(0, 0), sq(2, 2, 6, 6)).contact, true); // 嵌套在净区域内
// 斜相离（角对角，x/y 均有间隙）：最近距离为欧氏 5√2
{
  const g = cc.pairDistancePx(sq(0, 0, 10, 10), sq(15, 15, 10, 10));
  assert.ok(Math.abs(g.distPx - 5 * Math.SQRT2) < 1e-6, g.distPx);
}
console.log('ok 2 净区域距离：相离为正距离（含斜向欧氏距离），边界接触/重叠/嵌套为 0');

// 3. 孔洞规则：只落在对方孔洞内且未触及净区域 → 不算接触，距离为到孔洞边界的正距离；
//    贴孔洞边界（净区域边界）→ 接触 0；跨出孔洞进入净区域 → 接触 0
const holed = {
  id: 'holed', name: '有孔细胞',
  outer: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }, { x: 0, y: 50 }],
  holes: [[{ x: 20, y: 20 }, { x: 30, y: 20 }, { x: 30, y: 30 }, { x: 20, y: 30 }]]
};
{
  const g = cc.pairDistancePx(holed, sq(22, 22, 6, 6)); // 22..28，距孔边 2
  assert.strictEqual(g.contact, false);
  assert.ok(Math.abs(g.distPx - 2) < 1e-6, g.distPx);
}
assert.strictEqual(cc.pairDistancePx(holed, sq(20, 20, 6, 6)).contact, true);   // 贴孔边
assert.strictEqual(cc.pairDistancePx(holed, sq(18, 18, 14, 14)).contact, true); // 伸出孔外
assert.strictEqual(cc.pairDistancePx(holed, sq(2, 2, 8, 8)).contact, true);    // 在孔外净区域
// 两个细胞都落在同一孔洞内：彼此不以孔洞壁相连
{
  const b = sq(22, 22, 4, 4);   // 22..26
  const c = sq(26.4, 22, 3, 4); // 26.4..29.4，b/c 间隙 0.4，都严格在孔内
  assert.strictEqual(cc.pairDistancePx(holed, b).contact, false);
  assert.strictEqual(cc.pairDistancePx(holed, c).contact, false);
  const g = cc.pairDistancePx(b, c);
  assert.strictEqual(g.contact, false);
  assert.ok(Math.abs(g.distPx - 0.4) < 1e-6);
  // 一侧伸出孔洞进入净区域即接触
  assert.strictEqual(cc.pairDistancePx(holed, sq(26.5, 22, 4, 4)).contact, true); // 30.5 出孔
}
console.log('ok 3 孔洞规则：只落在孔洞内不算接触（距离为到孔洞边界），贴孔边/进入净区域为接触 0');

// 4. 无邻接关系：每个细胞各自独立成簇
{
  const r = cc.buildContactClusters([sq(0, 0), sq(100, 0), sq(0, 100)], 1, 0);
  assert.strictEqual(r.cellCount, 3);
  assert.strictEqual(r.clusterCount, 3);
  assert.strictEqual(r.adjacencyCount, 0);
  assert.deepStrictEqual(r.clusters.map((c) => c.size), [1, 1, 1]);
  assert.deepStrictEqual(r.clusters.map((c) => c.id), ['c1', 'c2', 'c3']);
  assert.ok(r.cells.every((c) => c.neighborCount === 0 && c.clusterId === `c${c.seq}`));
  // 空报告：0 个簇、不报错
  const empty = cc.buildContactClusters([], 1, 5);
  assert.strictEqual(empty.clusterCount, 0);
  assert.strictEqual(empty.cells.length, 0);
}
console.log('ok 4 无邻接时每个细胞独立成簇；空细胞列表返回 0 簇');

// 5. 阈值邻接 + 连通传递 + 尺度换算
{
  // scale=2 μm/px；细胞间距：A-B 5px=10μm，B-C 5px=10μm，A-C 20px=40μm
  const cells = [sq(0, 0, 10, 10), sq(15, 0, 10, 10), sq(30, 0, 10, 10)];
  let r = cc.buildContactClusters(cells, 2, 10);
  assert.strictEqual(r.clusterCount, 1);                 // 阈值含等于：A-B、B-C 相邻 → 三连通
  assert.strictEqual(r.multiCellClusterCount, 1);
  assert.strictEqual(r.clusters[0].size, 3);
  assert.strictEqual(r.adjacencyCount, 2);               // A-C 40μm 不邻接
  assert.ok(r.cells[0].neighbors.every((x) => x.distanceUm === 10));
  assert.strictEqual(r.cells[1].neighborCount, 2);

  r = cc.buildContactClusters(cells, 2, 9.99);
  assert.strictEqual(r.clusterCount, 3);                 // 阈值略小：全部独立
  assert.strictEqual(r.adjacencyCount, 0);

  r = cc.buildContactClusters(cells, 2, 0);
  assert.strictEqual(r.clusterCount, 3);
  assert.strictEqual(r.adjacencyCount, 0);

  r = cc.buildContactClusters(cells, 2, 40);
  assert.strictEqual(r.clusterCount, 1);
  assert.strictEqual(r.adjacencyCount, 3);               // A-C 也进入
}
console.log('ok 5 阈值邻接（含等于、尺度换算）与连通传递；阈值只影响本次查询结果');

// 5b. 包围盒粗筛不影响正确性：包围盒在某轴相离但实际最近距离由另一方向决定的情形
{
  // 斜向角对角：包围盒 x/y 间隙均为 5，真实最近距离 5√2 ≈ 7.071
  const cells = [sq(0, 0, 10, 10), sq(15, 15, 10, 10)];
  // 阈值 7：粗筛若误按某轴间隙 5 放行没问题；关键是 7.071 > 7 → 不邻接
  let r = cc.buildContactClusters(cells, 1, 7);
  assert.strictEqual(r.adjacencyCount, 0);
  assert.strictEqual(r.clusterCount, 2);
  r = cc.buildContactClusters(cells, 1, 7.08);
  assert.strictEqual(r.adjacencyCount, 1);
  assert.strictEqual(r.clusterCount, 1);
  assert.ok(Math.abs(r.adjacencies[0].distanceUm - 5 * Math.SQRT2) < 1e-5);
}
console.log('ok 5b 包围盒粗筛：斜向最近距离按真实欧氏值判定，阈值边界不误判');

// 6. 孔洞内细胞按“净区域到孔壁”距离参与阈值，不被错误当作接触
{
  const r = cc.buildContactClusters([holed, sq(22, 22, 6, 6, { id: 'inside' })], 1, 3);
  assert.strictEqual(r.clusterCount, 1);                 // 2μm ≤ 3μm → 同簇但非接触
  assert.strictEqual(r.adjacencyCount, 1);
  assert.strictEqual(r.adjacencies[0].contact, false);
  assert.strictEqual(r.adjacencies[0].distanceUm, 2);
  const r0 = cc.buildContactClusters([holed, sq(22, 22, 6, 6, { id: 'inside' })], 1, 0);
  assert.strictEqual(r0.clusterCount, 2);                // 阈值 0：不接触 → 独立簇
}
console.log('ok 6 孔洞内细胞按到孔壁的正距离参与阈值，阈值 0 时不视为接触');

// 7. 输出结构：簇按最小序号稳定排序；邻接/邻居携带名称与最近点；簇内仅列本簇邻接
{
  const named = [
    { id: 'a', name: 'Alpha', outer: sq(0, 0).outer, holes: [] },
    { id: 'b', name: 'Beta', outer: sq(10, 0).outer, holes: [] }, // 与 a 接触
    { id: 'z', name: 'Zeta', outer: sq(500, 500).outer, holes: [] }
  ];
  const r = cc.buildContactClusters(named, 1, 0);
  assert.strictEqual(r.clusters[0].cells[1].name, 'Beta');
  assert.strictEqual(r.clusters[0].adjacencies.length, 1);
  assert.strictEqual(r.clusters[0].adjacencies[0].contact, true);
  assert.strictEqual(r.clusters[0].adjacencies[0].nearestPointPx, null);
  assert.strictEqual(r.cells[2].clusterId, 'c2');
  // 相离对（非接触）携带最近点像素坐标
  const near = cc.buildContactClusters([sq(0, 0, 10, 10), sq(15, 0, 10, 10)], 1, 10);
  const ln = near.adjacencies[0];
  assert.strictEqual(ln.contact, false);
  assert.ok(ln.nearestPointPx && ln.nearestPointPx.from && ln.nearestPointPx.to);
  assert.strictEqual(ln.nearestPointPx.to.x - ln.nearestPointPx.from.x, 5);
}
console.log('ok 7 输出结构：簇稳定排序、邻接携带名称/接触标记/最近点像素坐标');

console.log('\n接触簇纯逻辑自测全部通过 ✅');
