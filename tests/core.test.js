/* 核心算法自测：node tests/core.test.js */
'use strict';
const assert = require('assert');
const C = require('../core.js');
const DxfLite = require('../dxf-lite.js');
const CadImport = require('../cad-import.js');

function countGraphComponents(graph) {
  const adj = Array.from({ length: graph.nodes.length }, () => []);
  for (const edge of graph.edges) {
    adj[edge.a].push(edge.b);
    adj[edge.b].push(edge.a);
  }
  const seen = new Uint8Array(graph.nodes.length);
  let components = 0;
  for (let i = 0; i < graph.nodes.length; i++) {
    if (seen[i]) continue;
    components++;
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const node = stack.pop();
      for (const next of adj[node]) {
        if (!seen[next]) {
          seen[next] = 1;
          stack.push(next);
        }
      }
    }
  }
  return components;
}

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
assert(dxf.includes('$ACADVER\r\n1\r\nAC1015'), '带米制声明的 DXF 应使用 R2000 版本');
assert(dxf.includes('$INSUNITS\r\n70\r\n6'), '米制 DXF 必须声明 $INSUNITS=6');
assert(dxf.trimEnd().endsWith('EOF'), 'DXF 以 EOF 结尾');

// CSV 生成必须保持现有中文列、UTF-8 BOM、汇总和箱位明细。
const greenfieldCsv = C.buildCSV({
  result: res,
  households: households,
  existingBoxes: [],
  poleSpacing: params.poleSpacing,
  mPerPx: mPerPx
});
assert(greenfieldCsv.startsWith('\uFEFF'), 'CSV 必须包含 Excel 可识别的 UTF-8 BOM');
assert(greenfieldCsv.includes('"模式","无箱新建"'), 'CSV 应输出新建模式');
assert(greenfieldCsv.includes('"主干光缆长度（米）","' + res.cableLengthM + '"'), 'CSV 应输出主干光缆长度');
assert(greenfieldCsv.includes('"箱号","类型","覆盖户数"'), 'CSV 应输出箱位明细表头');
assert(greenfieldCsv.includes('"B1","新增"'), 'CSV 应输出新增箱明细');

const brownfieldCsv = C.buildCSV({
  result: res2,
  households: households,
  existingBoxes: [{ x: 500, y: 0 }],
  poleSpacing: params.poleSpacing,
  mPerPx: mPerPx
});
assert(brownfieldCsv.includes('"模式","有箱补点"'), 'CSV 应输出补点模式');
assert(brownfieldCsv.includes('"E1","已有"'), 'CSV 应输出已有箱明细');
assert(brownfieldCsv.includes('"分纤箱数量（合计）","' + (res2.boxes.length + 1) + '"'), 'CSV 合计应包含已有箱');

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

// DXF 圆弧：保留中心、半径和起止角，供显式中心线路网离散化。
const parsedArcDxf = DxfLite.parse([
  '0', 'SECTION', '2', 'ENTITIES',
  '0', 'ARC', '8', 'ROAD_CENTER',
  '10', '10', '20', '20', '40', '5', '50', '0', '51', '90',
  '0', 'ENDSEC', '0', 'EOF'
].join('\n'));
assert.deepStrictEqual(
  parsedArcDxf.entities.find((entity) => entity.type === 'ARC'),
  { type: 'ARC', layer: 'ROAD_CENTER', x: 10, y: 20, radius: 5, startAngle: 0, endAngle: 90 },
  'ARC 应保留中心、半径和起止角'
);

// CAD 自动识别：自动规则和显式图层都应可用于生成预览候选。
const recognitionEntities = {
  entities: [
    { type: 'TEXT', layer: 'NOTE', text: '民房', x: 20, y: 20 },
    { type: 'TEXT', layer: 'NOTE', text: '道路', x: 50, y: 5 },
    { type: 'TEXT', layer: 'NOTE', text: '配线层光交', x: 0, y: 5 },
    { type: 'LINE', layer: '0', vertices: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
    { type: 'LINE', layer: '0', vertices: [{ x: 0, y: 10 }, { x: 100, y: 10 }] },
    { type: 'INSERT', layer: 'HOUSE_BLOCK', name: 'HOUSE', x: 30, y: 20 },
    { type: 'INSERT', layer: 'HOUSE_BLOCK', name: 'HOUSE', x: 70, y: 20 },
    { type: 'LWPOLYLINE', layer: 'ROAD_CENTER', vertices: [{ x: 0, y: 5 }, { x: 100, y: 5 }] }
  ]
};
const autoRecognition = CadImport.recognize(recognitionEntities, {});
assert.strictEqual(autoRecognition.households.length, 1, '自动规则应读取“民房”文字');
assert.strictEqual(autoRecognition.roads.length, 1, '自动规则应从双边线生成中心线');

// 部分 CAD 会把直线道路边保存为仅含两个顶点的 LWPOLYLINE；它们应复用严格双边线配对，
// 但不能因此把具有转角的房屋轮廓当成道路。
const lightweightEdgeRecognition = CadImport.recognize({
  entities: [
    { type: 'TEXT', layer: 'HOUSE', text: '民房', x: 50, y: 30 },
    { type: 'TEXT', layer: 'NOTE', text: '道路', x: 50, y: 5 },
    { type: 'LWPOLYLINE', layer: '0', vertices: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
    { type: 'LWPOLYLINE', layer: '0', vertices: [{ x: 0, y: 10 }, { x: 100, y: 10 }] },
    { type: 'LWPOLYLINE', layer: '0', vertices: [{ x: 20, y: 20 }, { x: 30, y: 20 }, { x: 30, y: 30 }] }
  ]
}, {});
assert.strictEqual(lightweightEdgeRecognition.roads.length, 1, '两点 LWPOLYLINE 双边线应生成一条中心线');
assert.strictEqual(lightweightEdgeRecognition.stats.pairedRoadCount, 1, '两点 LWPOLYLINE 配对应计入双边线统计');

// 多样例通用标签：编号房屋和不同等级道路文字也应作为语义参考。
const alternateLabelRecognition = CadImport.recognize({
  entities: [
    { type: 'TEXT', layer: 'HOUSE', text: '房屋12', x: 20, y: 20 },
    { type: 'TEXT', layer: 'ROAD_NOTE', text: '村道', x: 50, y: 5 },
    { type: 'LINE', layer: '0', vertices: [{ x: 0, y: 0 }, { x: 100, y: 0 }] }
  ]
}, {});
assert.strictEqual(alternateLabelRecognition.households.length, 1, '“房屋+编号”应识别为户点');
assert.strictEqual(alternateLabelRecognition.roads.length, 1, '“村道”应允许附近单线作为道路候选');

// 图例中的光交文字只是说明，不能误当成实际进村点。
const legendRecognition = CadImport.recognize({
  entities: [
    { type: 'TEXT', layer: 'HOUSE', text: '民房', x: 20, y: 20 },
    { type: 'TEXT', layer: 'ROAD_NOTE', text: '道路', x: 50, y: 5 },
    { type: 'TEXT', layer: '图例', text: '利旧落地式光交箱', x: 0, y: -100 },
    { type: 'LINE', layer: '0', vertices: [{ x: 0, y: 0 }, { x: 100, y: 0 }] }
  ]
}, {});
assert.strictEqual(legendRecognition.entrance, null, '图例文字不能作为进村点');

// 自动语义识别必须统一排除图例/说明层；显式选择图层仍以用户指定为准。
const referenceLayerRecognition = CadImport.recognize({
  entities: [
    { type: 'TEXT', layer: 'OBJECT', text: '民房', x: 10, y: 20 },
    { type: 'TEXT', layer: 'OBJECT', text: '分纤箱编号：01', x: 30, y: 20 },
    { type: 'TEXT', layer: '图例', text: '民房', x: 20, y: 20 },
    { type: 'TEXT', layer: '图例', text: '道路', x: 50, y: 0 },
    { type: 'TEXT', layer: '图例', text: '分纤箱编号：图例', x: 60, y: 20 },
    { type: 'TEXT', layer: '图例', text: '新设分纤箱', x: 30, y: 20 },
    { type: 'TEXT', layer: '说明', text: 'P1', x: 70, y: 20 },
    { type: 'LINE', layer: '0', vertices: [{ x: 0, y: 0 }, { x: 100, y: 0 }] }
  ]
}, {});
assert.strictEqual(referenceLayerRecognition.households.length, 1, '图例民房不能成为户点');
assert.strictEqual(referenceLayerRecognition.roads.length, 0, '图例道路文字不能把附近普通线提升为道路');
assert.strictEqual(referenceLayerRecognition.existingBoxes.length, 1, '图例箱标注不能新增或改写实际已有箱');
assert.strictEqual(referenceLayerRecognition.plannedBoxes.length, 0, '图例新设箱文字不能把已有箱改成计划箱');
assert.strictEqual(referenceLayerRecognition.polePoints.length, 0, '说明层杆号不能成为杆位参考');
const explicitReferenceLayerRecognition = CadImport.recognize({
  entities: [
    { type: 'TEXT', layer: '图例', text: '民房', x: 20, y: 20 }
  ]
}, { houseLayer: '图例' });
assert.strictEqual(explicitReferenceLayerRecognition.households.length, 1, '用户显式选择图例层时应尊重图层覆盖');

// 可配置图块名：填写后该角色只采用精确匹配的 INSERT，已有箱和新设箱必须保持独立语义。
const blockRuleRecognition = CadImport.recognize({
  entities: [
    { type: 'INSERT', layer: 'ASSET', name: 'House_A', x: 10, y: 20 },
    { type: 'INSERT', layer: 'ASSET', name: 'HOUSE_B', x: 20, y: 20 },
    { type: 'INSERT', layer: 'ASSET', name: 'HOUSE_OTHER', x: 25, y: 20 },
    { type: 'INSERT', layer: '图例', name: 'HOUSE_A', x: 30, y: 20 },
    { type: 'TEXT', layer: 'ASSET', text: '民房', x: 90, y: 20 },
    { type: 'INSERT', layer: 'EXISTING', name: 'EXIST_BOX', x: 40, y: 20 },
    { type: 'INSERT', layer: 'PLANNED', name: 'NEW_BOX', x: 50, y: 20 },
    { type: 'INSERT', layer: 'EXISTING', name: 'NEW_BOX', x: 55, y: 20 },
    { type: 'TEXT', layer: 'ASSET', text: '分纤箱编号：文字箱', x: 60, y: 20 },
    { type: 'INSERT', layer: 'ASSET', name: 'POLE_A', x: 70, y: 20 },
    { type: 'TEXT', layer: 'ASSET', text: 'P1', x: 80, y: 20 },
    { type: 'INSERT', layer: 'ASSET', name: 'ENTRY_A', x: 0, y: 0 },
    { type: 'TEXT', layer: 'ASSET', text: '光交', x: 100, y: 0 },
    { type: 'LINE', layer: 'ROAD_CENTER', vertices: [{ x: 0, y: 0 }, { x: 100, y: 0 }] }
  ]
}, {
  roadLayer: 'ROAD_CENTER',
  roadMode: 'centerline',
  boxLayer: 'EXISTING',
  plannedBoxLayer: 'PLANNED',
  houseBlockNames: 'house_a； HOUSE_B',
  existingBoxBlockNames: 'EXIST_BOX',
  plannedBoxBlockNames: 'NEW_BOX',
  poleBlockNames: ['pole_a'],
  entranceBlockNames: 'ENTRY_A'
});
assert.strictEqual(blockRuleRecognition.households.length, 2, '民房图块规则应大小写无关并支持中文分号');
assert.deepStrictEqual(blockRuleRecognition.households.map((point) => point.x), [50, 60], '图例和未匹配图块及文字户点应被排除');
assert.strictEqual(blockRuleRecognition.existingBoxes.length, 1, '已有箱图块应保持已有语义');
assert.strictEqual(blockRuleRecognition.plannedBoxes.length, 1, '新设箱图层应排除其他图层的同名图块');
assert.strictEqual(blockRuleRecognition.polePoints.length, 1, '杆位规则应忽略同层文字杆号');
assert.deepStrictEqual(blockRuleRecognition.entrance, { x: 40, y: 60 }, '进村点规则应优先于通用光交文字');
assert.strictEqual(blockRuleRecognition.stats.houseBlockRuleCount, 2, '摘要应报告民房图块规则数量');
assert.strictEqual(blockRuleRecognition.stats.existingBoxBlockRuleCount, 1, '摘要应报告已有箱图块规则数量');
assert.strictEqual(blockRuleRecognition.stats.plannedBoxBlockRuleCount, 1, '摘要应报告新设箱图块规则数量');
assert.strictEqual(blockRuleRecognition.stats.poleBlockRuleCount, 1, '摘要应报告电杆图块规则数量');
assert.strictEqual(blockRuleRecognition.stats.entranceBlockRuleCount, 1, '摘要应报告进村点图块规则数量');

const explicitReferenceBlockRecognition = CadImport.recognize({
  entities: [
    { type: 'INSERT', layer: '图例', name: 'HOUSE_A', x: 20, y: 20 }
  ]
}, { houseLayer: '图例', houseBlockNames: 'HOUSE_A' });
assert.strictEqual(explicitReferenceBlockRecognition.households.length, 1, '显式图层应允许选取引用层中的匹配图块');

// 双边线在交叉口常留有短缺口：只沿端点原方向补桥，连通直行和 T 形道路。
const gapRoads = [
  [{ x: 0, y: 0 }, { x: 40, y: 0 }],
  [{ x: 80, y: 0 }, { x: 120, y: 0 }],
  [{ x: 40, y: 80 }, { x: 40, y: 40 }]
];
const bridgedRoads = CadImport.bridgeRoadGaps(gapRoads, 45, 15);
assert.strictEqual(bridgedRoads.length, 5, '两个短缺口应生成两条道路连接');
assert.strictEqual(countGraphComponents(C.buildRoadGraph(bridgedRoads, 1)), 1, '补桥后道路应形成单一连通图');

const inferredRoadRecognition = CadImport.recognize({
  entities: [
    { type: 'TEXT', layer: 'HOUSE', text: '民房', x: 0, y: 30 },
    { type: 'TEXT', layer: 'HOUSE', text: '民房', x: 400, y: 30 },
    { type: 'TEXT', layer: 'ROAD_NOTE', text: '道路', x: 50, y: 5 },
    { type: 'LINE', layer: 'ROAD', vertices: [{ x: 0, y: 0 }, { x: 40, y: 0 }] },
    { type: 'LINE', layer: 'ROAD', vertices: [{ x: 0, y: 10 }, { x: 40, y: 10 }] },
    { type: 'LINE', layer: 'ROAD', vertices: [{ x: 80, y: 0 }, { x: 120, y: 0 }] },
    { type: 'LINE', layer: 'ROAD', vertices: [{ x: 80, y: 10 }, { x: 120, y: 10 }] }
  ]
}, { roadLayer: 'ROAD', roadMode: 'edges' });
assert.deepStrictEqual(inferredRoadRecognition.inferredRoadIndexes, [2], '自动补桥索引应单独返回供界面复核');
assert.strictEqual(inferredRoadRecognition.stats.bridgedRoadCount, 1, '补桥统计应与索引数量一致');
const layerRecognition = CadImport.recognize(recognitionEntities, {
  houseLayer: 'HOUSE_BLOCK',
  roadLayer: 'ROAD_CENTER'
});
assert.strictEqual(layerRecognition.households.length, 2, '指定民房图层时应读取图块插入点');
assert.strictEqual(layerRecognition.roads.length, 1, '指定道路图层时应读取中心线折线');
const centerlineRecognition = CadImport.recognize({
  entities: [
    { type: 'TEXT', layer: 'NOTE', text: '民房', x: 20, y: 20 },
    { type: 'TEXT', layer: 'NOTE', text: '光交', x: 0, y: 0 },
    { type: 'LINE', layer: 'ROAD_CENTER', vertices: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
    { type: 'LINE', layer: 'ROAD_CENTER', vertices: [{ x: 0, y: 10 }, { x: 100, y: 10 }] }
  ]
}, { roadLayer: 'ROAD_CENTER', roadMode: 'centerline' });
assert.strictEqual(centerlineRecognition.roads.length, 2, '已有中心线模式不能把平行中心线误配成双边线');

const arcVertices = CadImport.arcToPolyline({
  type: 'ARC', x: 10, y: 20, radius: 5, startAngle: 0, endAngle: 90
});
assert(arcVertices.length >= 4, '圆弧中心线应离散为足够平滑的折线');
assert(Math.hypot(arcVertices[0].x - 15, arcVertices[0].y - 20) < 1e-9, '圆弧起点应准确');
assert(Math.hypot(arcVertices.at(-1).x - 10, arcVertices.at(-1).y - 25) < 1e-9, '圆弧终点应准确');
const arcCenterlineRecognition = CadImport.recognize({
  entities: [
    { type: 'TEXT', layer: 'HOUSE', text: '民房', x: 10, y: 30 },
    { type: 'ARC', layer: 'ROAD_CENTER', x: 10, y: 20, radius: 5, startAngle: 0, endAngle: 90 }
  ]
}, { roadLayer: 'ROAD_CENTER', roadMode: 'centerline' });
assert.strictEqual(arcCenterlineRecognition.roads.length, 1, '显式已有中心线模式应读取道路图层圆弧');
assert.strictEqual(arcCenterlineRecognition.stats.arcRoadCount, 1, '应报告已采用的圆弧中心线数量');
const ignoredEdgeArcRecognition = CadImport.recognize({
  entities: [
    { type: 'TEXT', layer: 'HOUSE', text: '民房', x: 10, y: 30 },
    { type: 'ARC', layer: 'ROAD_EDGE', x: 10, y: 20, radius: 5, startAngle: 0, endAngle: 90 }
  ]
}, { roadLayer: 'ROAD_EDGE', roadMode: 'auto' });
assert.strictEqual(ignoredEdgeArcRecognition.roads.length, 0, '自动模式不能把道路双边线圆角直接当成中心线');
assert.strictEqual(ignoredEdgeArcRecognition.stats.ignoredArcCount, 1, '应报告未作为中心线使用的道路层圆弧');

// 导入质量审计：用明确的图纸单位阈值找出远离识别路网的户点。
const householdRoadAudit = CadImport.auditHouseholdRoadDistances(
  [{ x: 10, y: 0 }, { x: 50, y: 20 }, { x: 90, y: 40 }],
  [[{ x: 0, y: 0 }, { x: 100, y: 0 }]],
  30
);
assert.deepStrictEqual(householdRoadAudit.distances, [0, 20, 40], '应返回每个户点到最近道路的距离');
assert.deepStrictEqual(householdRoadAudit.farIndexes, [2], '超过复核阈值的户点应单独标记');
assert.strictEqual(householdRoadAudit.withinCount, 2, '应统计阈值内户点数量');
assert.strictEqual(householdRoadAudit.medianDistance, 20, '应报告中位距离');
assert.strictEqual(householdRoadAudit.maxDistance, 40, '应报告最远距离');
const correctedHouseholdRoadAudit = CadImport.auditHouseholdRoadDistances(
  [{ x: 90, y: 40 }],
  [
    [{ x: 0, y: 0 }, { x: 100, y: 0 }],
    [{ x: 80, y: 40 }, { x: 100, y: 40 }]
  ],
  30
);
assert.deepStrictEqual(correctedHouseholdRoadAudit.farIndexes, [], '补画道路后离路户点标记应立即消失');
const missingRoadAudit = CadImport.auditHouseholdRoadDistances([{ x: 1, y: 1 }], [], 30);
assert.deepStrictEqual(missingRoadAudit.farIndexes, [0], '没有路网时所有户点都应等待复核');
assert.strictEqual(missingRoadAudit.maxDistance, null, '没有路网时不能伪造最大距离');

const auditedRecognition = CadImport.recognize({
  entities: [
    { type: 'TEXT', layer: 'HOUSE', text: '民房', x: 10, y: 0 },
    { type: 'TEXT', layer: 'HOUSE', text: '民房', x: 90, y: 40 },
    { type: 'LINE', layer: 'ROAD_CENTER', vertices: [{ x: 0, y: 0 }, { x: 100, y: 0 }] }
  ]
}, { roadLayer: 'ROAD_CENTER', roadMode: 'centerline', reviewDistance: 30 });
assert.strictEqual(auditedRecognition.roadReviewDistance, 30, '识别结果应保留可调整的离路复核阈值');
assert.deepStrictEqual(auditedRecognition.reviewHouseholdIndexes, [1], '识别结果应返回离路户点索引供画布提示');
assert.strictEqual(auditedRecognition.stats.householdsWithinRoadReview, 1, '识别摘要应统计阈值内户点');
assert.strictEqual(auditedRecognition.stats.householdsFarFromRoad, 1, '识别摘要应统计待复核户点');
assert.strictEqual(auditedRecognition.stats.householdRoadMedianDistance, 20, '识别摘要应报告中位离路距离');
assert.strictEqual(auditedRecognition.stats.householdRoadMaxDistance, 40, '识别摘要应报告最大离路距离');

const angledRecognition = CadImport.recognize({
  entities: [
    { type: 'TEXT', layer: 'NOTE', text: '民房', x: 20, y: 30 },
    { type: 'TEXT', layer: 'NOTE', text: '道路', x: 50, y: 55 },
    { type: 'TEXT', layer: 'NOTE', text: '光交', x: 0, y: 5 },
    { type: 'LINE', layer: '0', vertices: [{ x: 0, y: 0 }, { x: 100, y: 100 }] },
    { type: 'LINE', layer: '0', vertices: [{ x: 0, y: 10 }, { x: 100, y: 110 }] }
  ]
}, {});
assert.strictEqual(angledRecognition.roads.length, 1, '斜向双边线应配对为一条中心线');
const angledRoad = angledRecognition.roads[0];
const angledDx = Math.abs(angledRoad[1].x - angledRoad[0].x);
const angledDy = Math.abs(angledRoad[1].y - angledRoad[0].y);
assert(Math.abs(angledDx - angledDy) < 1e-6, '斜向道路中心线必须保留原始方向');

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

// 客户样例提炼：多条道路端点在同一交叉口附近时，吸附后必须共享同一节点。
const importedRoads = [
  [{ x: 8782.15, y: -7262.42 }, { x: 8782.15, y: -7028.07 }],
  [{ x: 8782.15, y: -7464.46 }, { x: 8782.15, y: -7269.89 }],
  [{ x: 8972.03, y: -7262.42 }, { x: 8972.03, y: -6978.07 }],
  [{ x: 8972.03, y: -7358.29 }, { x: 8972.03, y: -7269.89 }],
  [{ x: 8616.86, y: -7395.93 }, { x: 8616.86, y: -7269.89 }],
  [{ x: 8620.59, y: -7266.16 }, { x: 8778.42, y: -7266.16 }],
  [{ x: 8785.89, y: -7266.16 }, { x: 8968.30, y: -7266.16 }],
  [{ x: 8975.76, y: -7266.16 }, { x: 9100.82, y: -7266.16 }],
  [{ x: 8503.38, y: -7024.34 }, { x: 8778.42, y: -7024.34 }],
  [{ x: 8975.76, y: -7362.02 }, { x: 9095.49, y: -7362.02 }],
  [{ x: 8975.76, y: -6974.34 }, { x: 9152.48, y: -6974.34 }],
  [{ x: 9156.21, y: -6970.60 }, { x: 9156.21, y: -6901.70 }],
  [{ x: 8999.74, y: -6897.97 }, { x: 9152.48, y: -6897.97 }],
  [{ x: 9159.94, y: -6897.97 }, { x: 9195.08, y: -6897.97 }]
];
CadImport.snapRoadEndpoints(importedRoads, 12);
const importedGraph = C.buildRoadGraph(importedRoads, 1);
assert.strictEqual(countGraphComponents(importedGraph), 1, '同一交叉口附近的导入道路应形成单一连通图');

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
