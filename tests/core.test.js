/* 核心算法自测：node tests/core.test.js */
'use strict';
const assert = require('assert');
const C = require('../core.js');
const DxfLite = require('../dxf-lite.js');

// 合成村：L 形路网，0.5 米/像素
const roads = [[{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 600 }]];
const households = [];
for (let i = 1; i <= 10; i++) households.push({ x: i * 80 - 40, y: 30 });
for (let i = 1; i <= 10; i++) households.push({ x: 1030, y: i * 50 });
const entrance = { x: 0, y: 0 };
const params = { maxDistance: 100, capacity: 16, poleSpacing: 50 };
const mPerPx = 0.5;

// 无箱新建
const res = C.placeBoxes({
  roads, households, entrance, existingBoxes: [], params, mPerPx, mode: 'greenfield'
});

assert(res.boxes.length >= 2, '20户/16容量 至少2个箱');
assert.strictEqual(res.coveredCount, households.length, '全部覆盖');
assert.strictEqual(res.uncovered.length, 0);
for (const b of res.boxes) {
  assert(b.assigned.length <= params.capacity, '每箱不超过容量');
  for (const i of b.assigned) {
    const d = Math.hypot(households[i].x - b.x, households[i].y - b.y) * mPerPx;
    assert(d <= params.maxDistance + 1e-6, '户到箱距离 <= 覆盖距离');
  }
}
assert(res.cableLengthM > 0, '光缆长度 > 0');
assert.strictEqual(res.poleCount, Math.ceil(res.cableLengthM / params.poleSpacing), '杆数 = ceil(缆长/杆距)');
assert(res.boxes.every((b) => b.entM > 0), '每箱到进村点有路由长度');

// 有箱补点：已有箱覆盖第一批住户
const res2 = C.placeBoxes({
  roads, households, entrance,
  existingBoxes: [{ x: 500, y: 0 }],
  params, mPerPx, mode: 'brownfield'
});
assert(res2.existingCoveredCount >= 5, '已有箱应覆盖若干户');
assert(res2.boxes.length <= res.boxes.length, '补箱数 <= 新建箱数');
assert(res2.addedCableM >= 0, '新增光缆 >= 0');
assert(res2.totalCableM >= res2.addedCableM, '总长 >= 新增');

// 边界：全部被已有箱覆盖 → 补 0 箱
const res3 = C.placeBoxes({
  roads, households, entrance,
  existingBoxes: [{ x: 150, y: 0 }, { x: 500, y: 0 }, { x: 800, y: 0 }, { x: 1000, y: 150 }, { x: 1000, y: 450 }],
  params, mPerPx, mode: 'brownfield'
});
assert.strictEqual(res3.boxes.length, 0, '全覆盖时补0箱');
assert.strictEqual(res3.addedCableM, 0);

// 未校准：返回警告
const res4 = C.placeBoxes({ roads, households, entrance, existingBoxes: [], params, mPerPx: 0, mode: 'greenfield' });
assert(res4.warnings.length > 0, '未校准时给出警告');

// DXF 生成
const dxf = C.buildDXF({
  roads, households, entrance, existingBoxes: [], boxes: res.boxes,
  routeEdges: [], nodes: [], mPerPx, polePoints: []
});
assert(dxf.includes('SECTION'), 'DXF 含 SECTION');
assert(dxf.includes('ROAD'), 'DXF 含 ROAD 图层');
assert(dxf.trimEnd().endsWith('EOF'), 'DXF 以 EOF 结尾');

// DXF 导入：读取民房文字、道路文字和线对象
const dxfInput = [
  '0', 'SECTION', '2', 'ENTITIES',
  '0', 'TEXT', '8', '0', '10', '10', '20', '20', '1', '民房',
  '0', 'TEXT', '8', '0', '10', '0', '20', '0', '1', '道路',
  '0', 'LINE', '8', '0', '10', '0', '20', '0', '11', '100', '21', '0',
  '0', 'ENDSEC', '0', 'EOF'
].join('\n');
const parsedDxf = DxfLite.parse(dxfInput);
assert.strictEqual(parsedDxf.entities.filter((e) => e.type === 'TEXT' && e.text === '民房').length, 1);
assert.strictEqual(parsedDxf.entities.filter((e) => e.type === 'LINE').length, 1);

// 断开路网：不能把物理覆盖误报成有效覆盖或 0 米光缆
const disconnected = C.placeBoxes({
  roads: [[{ x: 0, y: 0 }, { x: 100, y: 0 }], [{ x: 500, y: 0 }, { x: 600, y: 0 }]],
  households: [{ x: 550, y: 10 }],
  entrance: { x: 0, y: 0 },
  existingBoxes: [],
  params,
  mPerPx: 1,
  mode: 'greenfield'
});
assert.strictEqual(disconnected.coveredCount, 0, '断路上的户不能计入有效覆盖');
assert(disconnected.uncovered.includes(0), '断路上的户应标记为未覆盖');
assert(disconnected.warnings.length > 0, '断路应给出警告');
assert.strictEqual(disconnected.cableLengthM, 0, '不可达箱不能贡献光缆长度');

// 共线重叠道路：重叠区间必须形成连通拓扑
const overlapGraph = C.buildRoadGraph(
  [[{ x: 0, y: 0 }, { x: 10, y: 0 }], [{ x: 5, y: 0 }, { x: 15, y: 0 }]],
  1
);
const overlapStart = overlapGraph.nodes.findIndex((p) => p.x === 0 && p.y === 0);
const overlapEnd = overlapGraph.nodes.findIndex((p) => p.x === 15 && p.y === 0);
assert(overlapStart >= 0 && overlapEnd >= 0, '重叠道路端点应存在');
assert(Number.isFinite(C.dijkstra(overlapGraph, overlapStart).dist[overlapEnd]), '重叠道路应连通');

// 道路外进村点：不能无限距离静默吸附
const farEntrance = C.placeBoxes({
  roads: [[{ x: 0, y: 0 }, { x: 100, y: 0 }]],
  households: [{ x: 50, y: 5 }],
  entrance: { x: 1000, y: 1000 },
  existingBoxes: [],
  params,
  mPerPx: 1,
  mode: 'greenfield'
});
assert(farEntrance.warnings.some((w) => w.includes('进村点距离路网过远')), '道路外进村点应给出吸附警告');

// 无效道路与非法参数：核心层不能抛异常
const invalidRoad = C.placeBoxes({
  roads: [[{ x: 0, y: 0 }]],
  households: [{ x: 0, y: 0 }],
  entrance,
  existingBoxes: [],
  params,
  mPerPx
});
assert(invalidRoad.warnings.length > 0, '无效道路应给出警告');
const invalidParams = C.placeBoxes({
  roads,
  households,
  entrance,
  existingBoxes: [],
  params: { maxDistance: 100, capacity: -2, poleSpacing: 50 },
  mPerPx
});
assert(invalidParams.warnings.some((w) => w.includes('每箱户数')), '非法容量应给出警告');

console.log('全部通过');
console.log('新建模式：箱', res.boxes.length, '个 | 光缆', res.cableLengthM, '米 | 杆', res.poleCount, '根');
console.log('补点模式：已有箱覆盖', res2.existingCoveredCount, '户 | 补箱', res2.boxes.length, '个 | 新增光缆', res2.addedCableM, '米');
