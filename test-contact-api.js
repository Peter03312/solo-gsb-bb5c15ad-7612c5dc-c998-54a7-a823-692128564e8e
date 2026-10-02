'use strict';

// 细胞空间接触簇的端到端 HTTP 自测（npm test）：在临时 DATA_DIR 上启动真实服务，
// 走 上传 → 定标 → 含孔洞轮廓 → 发布 → 接触簇查询（404/阈值 400/0 阈值/连通簇）
// → 高亮 PNG → 草稿修改与报告更正后旧报告结果不变 全流程。纯逻辑见 test-contacts.js。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const PORT = 8234;
const DATA_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pm-contact-api-'));

const base = `http://localhost:${PORT}`;
let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('ok -', name); }
  else { failures += 1; console.error('FAIL -', name, extra != null ? JSON.stringify(extra) : ''); }
}

async function jsend(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, body: await res.json().catch(() => null), res };
}
function upload(buffer) {
  return new Promise((resolve, reject) => {
    const boundary = 'b' + Math.random();
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="a.png"\r\n` +
      'Content-Type: image/png\r\n\r\n');
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const req = require('http').request(base + '/api/images', {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': head.length + buffer.length + tail.length
      }
    }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d || '{}') }));
    });
    req.on('error', reject);
    req.write(head); req.write(buffer); req.write(tail); req.end();
  });
}
const pts = (x, y, w, h = w) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];

async function main() {
  const srv = spawn(process.execPath, [path.join(__dirname, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let started = false;
  srv.stdout.on('data', (d) => { if (String(d).includes('已启动')) started = true; });
  srv.stderr.on('data', (d) => process.stderr.write(d));
  for (let i = 0; i < 50 && !started; i++) await new Promise((r) => setTimeout(r, 100));
  if (!started) throw new Error('server did not start');

  try {
    // ---- 报告不存在 → 404 ----
    let r = await jsend('POST', '/api/reports/no-such-report/contacts', { thresholdUm: 0 });
    check('报告不存在 404', r.status === 404 && /报告不存在/.test(r.body.error), r.body);

    // 准备数据：scale=1μm/px
    const png = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#ffffff' } })
      .png().toBuffer();
    const up = await upload(png);
    const imgId = up.body.id;
    r = await jsend('PUT', `/api/images/${imgId}/calibration`,
      { version: 1, p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, distanceUm: 100 });
    const v2 = r.body.version;
    check('定标成功', v2 === 2, r.body);

    // A: 10..40 带孔 20..30；B: 22..28 严格在 A 孔洞内（距孔边 2）；
    // C: 45..55 与 A 外间距 5；D: 200..210 孤立
    const cells = [
      { id: 'cellA', name: 'A', outer: pts(10, 10, 30, 30), holes: [pts(20, 20, 10, 10)] },
      { id: 'cellB', name: 'B', outer: pts(22, 22, 6, 6), holes: [] },
      { id: 'cellC', name: 'C', outer: pts(45, 10, 10, 10), holes: [] },
      { id: 'cellD', name: 'D', outer: pts(200, 200, 10, 10), holes: [] }
    ];
    r = await jsend('PUT', `/api/images/${imgId}/contours`, { version: v2, cells });
    check('保存含孔洞轮廓成功', r.status === 200, r.body && r.body.error);
    const v3 = r.body.version;

    r = await jsend('POST', `/api/images/${imgId}/publish`, { version: v3, title: '接触簇E2E' });
    check('发布成功', r.status === 201, r.body && r.body.error);
    const rid = r.body.report.id;

    // ---- 阈值非法 → 400 ----
    for (const bad of [-1, -0.5, NaN, Infinity, '3', null, undefined, {}]) {
      const body = bad === undefined ? {} : { thresholdUm: bad };
      const rr = await jsend('POST', `/api/reports/${rid}/contacts`, body);
      check(`阈值非法 400（${String(bad)}）`, rr.status === 400 && /间距阈值/.test(rr.body.error), rr.body);
    }

    // ---- 阈值 0：无接触（A/B 仅孔洞内相隔 2）→ 4 个独立簇 ----
    r = await jsend('POST', `/api/reports/${rid}/contacts`, { thresholdUm: 0 });
    check('阈值0 200', r.status === 200, r.body);
    check('阈值0 无邻接 4 独立簇',
      r.body.result.clusterCount === 4 && r.body.result.adjacencyCount === 0,
      r.body.result && [r.body.result.clusterCount, r.body.result.adjacencyCount]);

    // ---- 阈值 3：A-B 同簇（孔内 2μm，非接触 contact=false），C/D 独立 ----
    r = await jsend('POST', `/api/reports/${rid}/contacts`, { thresholdUm: 3 });
    check('阈值3 簇数=3', r.body.result.clusterCount === 3, r.body.result && r.body.result.clusters);
    const c1 = r.body.result.clusters[0];
    check('阈值3 首簇含 A、B', c1.size === 2 && c1.cellKeys.join() === 'cellA,cellB', c1);
    const abAdj = c1.adjacencies[0];
    check('A-B 距离 2μm 且非接触', abAdj.distanceUm === 2 && abAdj.contact === false, abAdj);
    check('非接触邻接携带最近点', !!abAdj.nearestPointPx, abAdj);
    const cellA = r.body.result.cells.find((c) => c.key === 'cellA');
    check('细胞视图含 clusterId/邻居', cellA.clusterId === 'c1' && cellA.neighborCount === 1 &&
      cellA.neighbors[0].key === 'cellB', cellA);

    // ---- 阈值 6：A-B-C 三连通（A-C 5μm），D 独立 ----
    r = await jsend('POST', `/api/reports/${rid}/contacts`, { thresholdUm: 6 });
    check('阈值6 簇数=2', r.body.result.clusterCount === 2, r.body.result.clusters);
    check('阈值6 首簇大小 3（连通传递）', r.body.result.clusters[0].size === 3, r.body.result.clusters);
    check('阈值6 邻接数 2（B-C 间距 17 不邻接）', r.body.result.adjacencyCount === 2,
      r.body.result.adjacencies.map((a) => [a.a.key, a.b.key, a.distanceUm]));
    check('阈值6 多细胞簇计数 1', r.body.result.multiCellClusterCount === 1, r.body.result);

    // ---- 高亮 PNG ----
    let imgRes = await fetch(`${base}/api/reports/${rid}/contacts/highlight.png?threshold=6&cluster=c1`);
    check('高亮 c1 PNG 200', imgRes.status === 200 && imgRes.headers.get('content-type') === 'image/png',
      imgRes.status);
    const buf = Buffer.from(await imgRes.arrayBuffer());
    const meta = await sharp(buf).metadata();
    check('高亮 PNG 尺寸同快照', meta.width === 300 && meta.height === 300, meta);
    imgRes = await fetch(`${base}/api/reports/${rid}/contacts/highlight.png?threshold=6&cluster=c9`);
    check('高亮不存在簇 400', imgRes.status === 400, imgRes.status);
    imgRes = await fetch(`${base}/api/reports/${rid}/contacts/highlight.png?threshold=-1&cluster=c1`);
    check('高亮负阈值 400', imgRes.status === 400, imgRes.status);
    imgRes = await fetch(`${base}/api/reports/no-such/contacts/highlight.png?threshold=0&cluster=c1`);
    check('高亮不存在报告 404', imgRes.status === 404, imgRes.status);

    // ---- 冻结性 1：发布后修改草稿，旧报告接触簇不变 ----
    r = await jsend('PUT', `/api/images/${imgId}/contours`, { version: v3 + 1, cells: [cells[0]] });
    check('草稿改动（仅留 A）成功', r.status === 200, r.body && r.body.error);
    const v4 = r.body.version;
    r = await jsend('POST', `/api/reports/${rid}/contacts`, { thresholdUm: 6 });
    check('旧报告仍冻结 4 细胞/2 簇',
      r.body.result.cellCount === 4 && r.body.result.clusterCount === 2,
      [r.body.result.cellCount, r.body.result.clusterCount]);

    // ---- 冻结性 2：以当前草稿发起更正生成新报告，旧报告按原标识结果不变 ----
    // 当前草稿只有 1 个细胞 A（无孔冲突：A 仍带孔），更正校验可通过
    r = await jsend('POST', `/api/reports/${rid}/correct`,
      { reason: '删除 B/C/D 后重新发布', draftVersion: v4, expectedTipId: rid });
    check('更正发布 201', r.status === 201, r.body && r.body.error);
    const rid2 = r.body.report.id;
    r = await jsend('POST', `/api/reports/${rid2}/contacts`, { thresholdUm: 6 });
    check('新报告只有 1 细胞/1 簇',
      r.body.result.cellCount === 1 && r.body.result.clusterCount === 1,
      [r.body.result.cellCount, r.body.result.clusterCount]);
    r = await jsend('POST', `/api/reports/${rid}/contacts`, { thresholdUm: 3 });
    check('旧报告按原标识仍为 4 细胞/3 簇',
      r.body.result.cellCount === 4 && r.body.result.clusterCount === 3,
      [r.body.result.cellCount, r.body.result.clusterCount]);

    // ---- 查询不写回：重复同阈值结果一致，报告详情无新增字段负担 ----
    const repDetail = await (await fetch(`${base}/api/reports/${rid}`)).json();
    check('报告详情不含接触簇写入', !('contactClusters' in repDetail), Object.keys(repDetail));

  } finally {
    srv.kill();
    setTimeout(() => process.exit(failures ? 1 : 0), 200);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
