/* CAD 自动识别：从轻量 DXF 实体提取户点、道路、入口、箱和杆（浏览器/Node 通用） */
(function (global) {
  'use strict';

  function cleanCadText(value) {
    return String(value || '').replace(/\\P/g, ' ').replace(/[{}]/g, '').replace(/\s+/g, '').trim();
  }

  function hasPoint(entity) {
    return entity && Number.isFinite(entity.x) && Number.isFinite(entity.y);
  }

  function pointOf(entity) {
    return { x: entity.x, y: entity.y };
  }

  function arcToPolyline(entity) {
    if (!entity || ![entity.x, entity.y, entity.radius, entity.startAngle, entity.endAngle].every(Number.isFinite) ||
        entity.radius <= 0) return [];
    const start = entity.startAngle;
    const sweep = ((entity.endAngle - start) % 360 + 360) % 360;
    if (sweep <= 1e-9) return [];
    const segmentCount = Math.min(256, Math.max(2, Math.ceil(sweep / 10)));
    const vertices = [];
    for (let index = 0; index <= segmentCount; index++) {
      const angle = (start + sweep * index / segmentCount) * Math.PI / 180;
      vertices.push({
        x: entity.x + entity.radius * Math.cos(angle),
        y: entity.y + entity.radius * Math.sin(angle)
      });
    }
    return vertices;
  }

  function auditHouseholdRoadDistances(households, roads, threshold) {
    const reviewDistance = Number(threshold) > 0 ? Number(threshold) : 30;
    const segments = [];
    for (const road of Array.isArray(roads) ? roads : []) {
      if (!Array.isArray(road)) continue;
      for (let index = 0; index + 1 < road.length; index++) {
        const a = road[index], b = road[index + 1];
        if (!hasPoint(a) || !hasPoint(b)) continue;
        const vx = b.x - a.x, vy = b.y - a.y;
        if (vx * vx + vy * vy > 1e-12) segments.push({ a: a, b: b });
      }
    }
    const distances = (Array.isArray(households) ? households : []).map((household) => {
      if (!hasPoint(household) || !segments.length) return Infinity;
      let nearest = Infinity;
      for (const segment of segments) {
        const vx = segment.b.x - segment.a.x, vy = segment.b.y - segment.a.y;
        const length2 = vx * vx + vy * vy;
        const t = Math.max(0, Math.min(1,
          ((household.x - segment.a.x) * vx + (household.y - segment.a.y) * vy) / length2
        ));
        const x = segment.a.x + vx * t, y = segment.a.y + vy * t;
        nearest = Math.min(nearest, Math.hypot(household.x - x, household.y - y));
      }
      return nearest;
    });
    const farIndexes = [];
    let withinCount = 0;
    distances.forEach((distance, index) => {
      if (distance <= reviewDistance) withinCount++;
      else farIndexes.push(index);
    });
    const finiteDistances = distances.filter(Number.isFinite).sort((a, b) => a - b);
    let medianDistance = null;
    if (finiteDistances.length) {
      const middle = Math.floor(finiteDistances.length / 2);
      medianDistance = finiteDistances.length % 2
        ? finiteDistances[middle]
        : (finiteDistances[middle - 1] + finiteDistances[middle]) / 2;
    }
    return {
      threshold: reviewDistance,
      distances: distances,
      farIndexes: farIndexes,
      withinCount: withinCount,
      medianDistance: medianDistance,
      maxDistance: finiteDistances.length ? finiteDistances[finiteDistances.length - 1] : null
    };
  }

  function isReferenceLayer(entity) {
    return /图例|说明|图框|模板/i.test(String(entity && entity.layer || ''));
  }

  function normalizeBlockNames(value) {
    const raw = Array.isArray(value) ? value : [value];
    const names = [];
    for (const item of raw) {
      for (const part of String(item || '').split(/[,，;；\r\n]+/)) {
        const name = cleanCadText(part).toUpperCase();
        if (name && !names.includes(name)) names.push(name);
      }
    }
    return names;
  }

  function eligibleRoleEntities(entities, layer) {
    return entities.filter((entity) =>
      hasPoint(entity) &&
      (!layer || (entity.layer || '0') === layer) &&
      (Boolean(layer) || !isReferenceLayer(entity))
    );
  }

  function blockRoleEntities(entities, layer, blockNames) {
    const names = normalizeBlockNames(blockNames);
    if (!names.length) return [];
    const nameSet = new Set(names);
    return eligibleRoleEntities(entities, layer).filter((entity) =>
      entity.type === 'INSERT' && nameSet.has(cleanCadText(entity.name).toUpperCase())
    );
  }

  function rolePoints(entities, layer, textMatcher, blockNames) {
    const names = normalizeBlockNames(blockNames);
    if (names.length) return blockRoleEntities(entities, layer, names).map(pointOf);
    const eligible = eligibleRoleEntities(entities, layer);
    const matchedText = eligible.filter((entity) =>
      (entity.type === 'TEXT' || entity.type === 'MTEXT') && textMatcher(cleanCadText(entity.text))
    );
    if (!layer || matchedText.length) return matchedText.map(pointOf);
    const inserts = eligible.filter((entity) => entity.type === 'INSERT');
    if (inserts.length) return inserts.map(pointOf);
    return eligible
      .filter((entity) => entity.type === 'TEXT' || entity.type === 'MTEXT')
      .map(pointOf);
  }

  function uniquePoints(points) {
    const seen = new Set();
    const result = [];
    for (const point of points) {
      const key = Math.round(point.x * 1000000) + ',' + Math.round(point.y * 1000000);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(point);
    }
    return result;
  }

  function snapRoadEndpoints(roads, tolerance) {
    const refs = [];
    for (const road of roads) {
      if (road.length >= 2) {
        refs.push(road[0], road[road.length - 1]);
      }
    }
    const segments = roads.flatMap((road) => road.slice(1).map((p, i) => [road[i], p]));
    for (const ref of refs) {
      for (const [a, b] of segments) {
        if (a === ref || b === ref) continue;
        const vx = b.x - a.x, vy = b.y - a.y;
        const len2 = vx * vx + vy * vy;
        if (!len2) continue;
        const t = Math.max(0, Math.min(1, ((ref.x - a.x) * vx + (ref.y - a.y) * vy) / len2));
        const x = a.x + t * vx, y = a.y + t * vy;
        if (Math.hypot(ref.x - x, ref.y - y) <= tolerance) {
          ref.x = x;
          ref.y = y;
          break;
        }
      }
    }
    // 同一交叉口可能聚集三个以上端点。逐对平均会让早先处理的点留在旧均值，
    // 形成肉眼不可见但拓扑上断开的细缝；先分组，再把整组写成同一坐标。
    const parent = refs.map((_, i) => i);
    function find(i) {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
      }
      return i;
    }
    function union(a, b) {
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent[rb] = ra;
    }
    for (let i = 0; i < refs.length; i++) {
      for (let j = i + 1; j < refs.length; j++) {
        if (Math.hypot(refs[i].x - refs[j].x, refs[i].y - refs[j].y) <= tolerance) union(i, j);
      }
    }
    const groups = new Map();
    for (let i = 0; i < refs.length; i++) {
      const root = find(i);
      let group = groups.get(root);
      if (!group) {
        group = { x: 0, y: 0, members: [] };
        groups.set(root, group);
      }
      group.x += refs[i].x;
      group.y += refs[i].y;
      group.members.push(refs[i]);
    }
    for (const group of groups.values()) {
      const x = group.x / group.members.length;
      const y = group.y / group.members.length;
      for (const ref of group.members) {
        ref.x = x;
        ref.y = y;
      }
    }
    return roads;
  }

  function bridgeRoadGaps(roads, maxGap, maxAngleDeg) {
    if (roads.length < 2 || !(maxGap > 0)) return roads;
    const parent = roads.map((_, i) => i);
    function find(i) {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
      }
      return i;
    }
    function union(a, b) {
      const ra = find(a), rb = find(b);
      if (ra === rb) return false;
      parent[rb] = ra;
      return true;
    }
    function cross(a, b, c) {
      return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    }
    function onSegment(point, a, b) {
      const epsilon = 1e-6;
      return Math.abs(cross(a, b, point)) <= epsilon &&
        point.x >= Math.min(a.x, b.x) - epsilon && point.x <= Math.max(a.x, b.x) + epsilon &&
        point.y >= Math.min(a.y, b.y) - epsilon && point.y <= Math.max(a.y, b.y) + epsilon;
    }
    function segmentsIntersect(a, b, c, d) {
      const abC = cross(a, b, c), abD = cross(a, b, d);
      const cdA = cross(c, d, a), cdB = cross(c, d, b);
      if (((abC > 0 && abD < 0) || (abC < 0 && abD > 0)) &&
          ((cdA > 0 && cdB < 0) || (cdA < 0 && cdB > 0))) return true;
      return onSegment(c, a, b) || onSegment(d, a, b) || onSegment(a, c, d) || onSegment(b, c, d);
    }

    // 先按现有交点分组，避免在同一连通分量内部生成无意义的连接线。
    for (let i = 0; i < roads.length; i++) {
      for (let j = i + 1; j < roads.length; j++) {
        let connected = false;
        for (let a = 1; !connected && a < roads[i].length; a++) {
          for (let b = 1; b < roads[j].length; b++) {
            if (segmentsIntersect(roads[i][a - 1], roads[i][a], roads[j][b - 1], roads[j][b])) {
              connected = true;
              break;
            }
          }
        }
        if (connected) union(i, j);
      }
    }

    const endpoints = [];
    for (let roadIndex = 0; roadIndex < roads.length; roadIndex++) {
      const road = roads[roadIndex];
      if (road.length < 2) continue;
      endpoints.push({
        id: endpoints.length,
        roadIndex: roadIndex,
        point: road[0],
        outward: { x: road[0].x - road[1].x, y: road[0].y - road[1].y }
      });
      const last = road.length - 1;
      endpoints.push({
        id: endpoints.length,
        roadIndex: roadIndex,
        point: road[last],
        outward: { x: road[last].x - road[last - 1].x, y: road[last].y - road[last - 1].y }
      });
    }

    const candidates = [];
    const minDirectionCos = Math.cos((Number(maxAngleDeg) || 15) * Math.PI / 180);
    const targetEndpointTolerance = Math.min(5, maxGap * 0.1);
    for (const endpoint of endpoints) {
      const outwardLength = Math.hypot(endpoint.outward.x, endpoint.outward.y);
      if (!outwardLength) continue;
      for (let roadIndex = 0; roadIndex < roads.length; roadIndex++) {
        if (find(endpoint.roadIndex) === find(roadIndex)) continue;
        const road = roads[roadIndex];
        for (let i = 1; i < road.length; i++) {
          const a = road[i - 1], b = road[i];
          const vx = b.x - a.x, vy = b.y - a.y;
          const length2 = vx * vx + vy * vy;
          if (!length2) continue;
          const t = Math.max(0, Math.min(1,
            ((endpoint.point.x - a.x) * vx + (endpoint.point.y - a.y) * vy) / length2
          ));
          let target = { x: a.x + t * vx, y: a.y + t * vy };
          if (Math.hypot(target.x - a.x, target.y - a.y) <= targetEndpointTolerance) target = a;
          else if (Math.hypot(target.x - b.x, target.y - b.y) <= targetEndpointTolerance) target = b;
          const dx = target.x - endpoint.point.x, dy = target.y - endpoint.point.y;
          const distance = Math.hypot(dx, dy);
          if (distance <= 1e-6 || distance > maxGap) continue;
          const directionCos = (endpoint.outward.x * dx + endpoint.outward.y * dy) /
            (outwardLength * distance);
          if (directionCos >= minDirectionCos) {
            candidates.push({ endpoint: endpoint, targetRoad: roadIndex, target: target, distance: distance });
          }
        }
      }
    }

    candidates.sort((a, b) => a.distance - b.distance);
    const usedEndpoints = new Set();
    const connectors = [];
    for (const candidate of candidates) {
      if (usedEndpoints.has(candidate.endpoint.id) ||
          find(candidate.endpoint.roadIndex) === find(candidate.targetRoad)) continue;
      usedEndpoints.add(candidate.endpoint.id);
      union(candidate.endpoint.roadIndex, candidate.targetRoad);
      connectors.push([
        { x: candidate.endpoint.point.x, y: candidate.endpoint.point.y },
        { x: candidate.target.x, y: candidate.target.y }
      ]);
    }
    return roads.concat(connectors);
  }

  function recognize(parsed, options) {
    options = options || {};
    const entities = parsed && Array.isArray(parsed.entities) ? parsed.entities : [];
    const textEntities = entities.filter((entity) => entity.type === 'TEXT' || entity.type === 'MTEXT');
    const pointEntities = entities.filter((entity) =>
      entity.type === 'TEXT' || entity.type === 'MTEXT' || entity.type === 'INSERT'
    );

    const houseBlockNames = normalizeBlockNames(options.houseBlockNames);
    const existingBoxBlockNames = normalizeBlockNames(options.existingBoxBlockNames);
    const plannedBoxBlockNames = normalizeBlockNames(options.plannedBoxBlockNames);
    const poleBlockNames = normalizeBlockNames(options.poleBlockNames);
    const entranceBlockNames = normalizeBlockNames(options.entranceBlockNames);

    const houses = rolePoints(
      pointEntities, options.houseLayer || '',
      (text) => /^(?:民房|房屋\d*)$/.test(text), houseBlockNames
    );
    const roadLabels = textEntities
      .filter((entity) =>
        /^(?:道路|村道|乡道|街道\d*)$/.test(cleanCadText(entity.text)) &&
        hasPoint(entity) && !isReferenceLayer(entity)
      )
      .map(pointOf);
    const sourceEntity = entranceBlockNames.length
      ? (blockRoleEntities(pointEntities, '', entranceBlockNames)[0] || null)
      : (pointEntities.find((entity) =>
        entity.type === 'INSERT' && /光交|交接箱|配线层/.test(String(entity.name || '')) &&
        hasPoint(entity) && !isReferenceLayer(entity)
      ) || textEntities.find((entity) =>
        /光交|配线层/.test(String(entity.text || '')) && hasPoint(entity) && !isReferenceLayer(entity)
      ));
    const sourceLabel = sourceEntity ? pointOf(sourceEntity) : null;
    const boxLabels = rolePoints(
      pointEntities, options.boxLayer || '',
      (text) => /^分纤箱编号[:：]/.test(text), existingBoxBlockNames
    );
    const newBoxTextLabels = plannedBoxBlockNames.length ? [] : textEntities
      .filter((entity) =>
        /新设.*分纤箱/.test(cleanCadText(entity.text)) && hasPoint(entity) &&
        (!options.plannedBoxLayer || (entity.layer || '0') === options.plannedBoxLayer) &&
        (Boolean(options.plannedBoxLayer) || !isReferenceLayer(entity))
      )
      .map(pointOf);
    const plannedBlockLabels = blockRoleEntities(
      pointEntities, options.plannedBoxLayer || '', plannedBoxBlockNames
    ).map(pointOf);
    const poleLabels = rolePoints(
      pointEntities, options.poleLayer || '',
      (text) => /^(?:电|原)?P\d+$/.test(text), poleBlockNames
    );
    const newBoxMarkers = newBoxTextLabels.concat(plannedBlockLabels);
    const isNearNewBox = (box) => newBoxMarkers.some((label) => Math.hypot(label.x - box.x, label.y - box.y) <= 60);
    const existingBoxLabels = existingBoxBlockNames.length
      ? boxLabels
      : boxLabels.filter((box) => !isNearNewBox(box));
    const plannedBoxLabels = uniquePoints(
      (existingBoxBlockNames.length ? [] : boxLabels.filter(isNearNewBox)).concat(plannedBlockLabels)
    );

    const geometries = entities
      .filter((entity) =>
        (entity.type === 'LINE' || entity.type === 'LWPOLYLINE') &&
        entity.vertices && entity.vertices.length >= 2 &&
        (!options.roadLayer || (entity.layer || '0') === options.roadLayer)
      )
      .map((entity) => ({
        type: entity.type,
        layer: entity.layer || '0',
        width: Number(entity.width) || 0,
        vertices: entity.vertices
      }));
    const semanticPoints = houses.concat(
      roadLabels,
      sourceLabel ? [sourceLabel] : [],
      existingBoxLabels,
      plannedBoxLabels,
      poleLabels
    );
    if (!semanticPoints.length) throw new Error('DXF 中没有找到可用的工程标注');

    const semanticExtent = Math.max(
      Math.max(...semanticPoints.map((point) => point.x)) - Math.min(...semanticPoints.map((point) => point.x)),
      Math.max(...semanticPoints.map((point) => point.y)) - Math.min(...semanticPoints.map((point) => point.y))
    ) || 1;
    const minRoadLength = Math.max(30, semanticExtent * 0.05);
    const roadMode = ['centerline', 'edges'].includes(options.roadMode) ? options.roadMode : 'auto';
    const roadLayerArcs = options.roadLayer
      ? entities.filter((entity) => entity.type === 'ARC' && (entity.layer || '0') === options.roadLayer)
      : [];
    const allLineInfos = geometries
      .filter((geometry) =>
        geometry.type === 'LINE' ||
        (geometry.type === 'LWPOLYLINE' && geometry.vertices.length === 2)
      )
      .map((geometry) => {
        const a = geometry.vertices[0], b = geometry.vertices[1];
        const dx = b.x - a.x, dy = b.y - a.y;
        const length = Math.hypot(dx, dy);
        let ux = length ? dx / length : 0;
        let uy = length ? dy / length : 0;
        if (ux < 0 || (Math.abs(ux) < 1e-9 && uy < 0)) {
          ux = -ux;
          uy = -uy;
        }
        const nx = -uy, ny = ux;
        const axisA = a.x * ux + a.y * uy;
        const axisB = b.x * ux + b.y * uy;
        return {
          type: geometry.type,
          a: a,
          b: b,
          length: length,
          ux: ux,
          uy: uy,
          nx: nx,
          ny: ny,
          axisMin: Math.min(axisA, axisB),
          axisMax: Math.max(axisA, axisB),
          normal: ((a.x + b.x) * nx + (a.y + b.y) * ny) / 2
        };
      });
    const lineInfos = allLineInfos.filter((geometry) =>
      options.roadLayer ? geometry.length > 1e-6 : geometry.length >= minRoadLength
    );

    const usedLines = new Set();
    const roadGeometries = [];
    let pairedRoadCount = 0;
    for (let i = 0; roadMode !== 'centerline' && i < lineInfos.length; i++) {
      if (usedLines.has(i)) continue;
      const a = lineInfos[i];
      let pair = -1;
      let bestGap = Infinity;
      for (let j = i + 1; j < lineInfos.length; j++) {
        if (usedLines.has(j)) continue;
        const b = lineInfos[j];
        if (a.type !== b.type) continue;
        const cross = Math.abs(a.ux * b.uy - a.uy * b.ux);
        if (cross > Math.sin(5 * Math.PI / 180)) continue;
        const bAxisA = b.a.x * a.ux + b.a.y * a.uy;
        const bAxisB = b.b.x * a.ux + b.b.y * a.uy;
        const bAxisMin = Math.min(bAxisA, bAxisB);
        const bAxisMax = Math.max(bAxisA, bAxisB);
        const overlap = Math.min(a.axisMax, bAxisMax) - Math.max(a.axisMin, bAxisMin);
        const bNormal = ((b.a.x + b.b.x) * a.nx + (b.a.y + b.b.y) * a.ny) / 2;
        const gap = Math.abs(a.normal - bNormal);
        if (overlap >= Math.min(a.length, b.length) * 0.55 && gap <= 12 && gap < bestGap) {
          pair = j;
          bestGap = gap;
        }
      }
      if (pair >= 0) {
        const b = lineInfos[pair];
        const bAxisA = b.a.x * a.ux + b.a.y * a.uy;
        const bAxisB = b.b.x * a.ux + b.b.y * a.uy;
        const start = Math.max(a.axisMin, Math.min(bAxisA, bAxisB));
        const end = Math.min(a.axisMax, Math.max(bAxisA, bAxisB));
        const bNormal = ((b.a.x + b.b.x) * a.nx + (b.a.y + b.b.y) * a.ny) / 2;
        const normal = (a.normal + bNormal) / 2;
        roadGeometries.push({
          vertices: [
            { x: a.ux * start + a.nx * normal, y: a.uy * start + a.ny * normal },
            { x: a.ux * end + a.nx * normal, y: a.uy * end + a.ny * normal }
          ]
        });
        pairedRoadCount++;
        usedLines.add(i);
        usedLines.add(pair);
      }
    }

    let directRoadCount = 0;
    for (let i = 0; i < lineInfos.length; i++) {
      if (usedLines.has(i)) continue;
      const line = lineInfos[i];
      const nearLabel = roadLabels.some((label) => {
        const vx = line.b.x - line.a.x, vy = line.b.y - line.a.y;
        const length2 = vx * vx + vy * vy;
        const t = length2
          ? Math.max(0, Math.min(1, ((label.x - line.a.x) * vx + (label.y - line.a.y) * vy) / length2))
          : 0;
        const x = line.a.x + t * vx, y = line.a.y + t * vy;
        return Math.hypot(label.x - x, label.y - y) <= Math.max(30, semanticExtent * 0.08);
      });
      if (roadMode !== 'edges' && (options.roadLayer || (line.type === 'LINE' && nearLabel))) {
        roadGeometries.push({ vertices: [line.a, line.b] });
        directRoadCount++;
      }
    }
    if (options.roadLayer && roadMode !== 'edges') {
      for (const geometry of geometries) {
        if (geometry.type !== 'LWPOLYLINE' || geometry.vertices.length === 2) continue;
        roadGeometries.push({ vertices: geometry.vertices });
        directRoadCount++;
      }
    }
    let arcRoadCount = 0;
    if (roadMode === 'centerline') {
      for (const entity of roadLayerArcs) {
        const vertices = arcToPolyline(entity);
        if (vertices.length < 2) continue;
        roadGeometries.push({ vertices: vertices });
        arcRoadCount++;
      }
    }
    const ignoredArcCount = roadLayerArcs.length - arcRoadCount;

    const points = semanticPoints.concat(roadGeometries.flatMap((geometry) => geometry.vertices));
    const minX = Math.min(...points.map((point) => point.x));
    const maxX = Math.max(...points.map((point) => point.x));
    const minY = Math.min(...points.map((point) => point.y));
    const maxY = Math.max(...points.map((point) => point.y));
    const toCanvas = (point) => ({ x: point.x - minX + 40, y: maxY - point.y + 40 });
    const snapTolerance = Math.max(5, Math.min(12, semanticExtent * 0.02));
    let roads = snapRoadEndpoints(
      roadGeometries.map((geometry) => geometry.vertices.map(toCanvas)),
      snapTolerance
    );
    const roadCountBeforeBridging = roads.length;
    if (roadMode !== 'centerline') {
      const bridgeTolerance = Math.min(80, Math.max(snapTolerance * 4, semanticExtent * 0.12));
      // 一次补桥可能刚好生成下一处弯道/T 口所需的目标段；最多迭代三次并在稳定后停止。
      for (let pass = 0; pass < 3; pass++) {
        const bridged = bridgeRoadGaps(roads, bridgeTolerance, 30);
        if (bridged.length === roads.length) break;
        roads = bridged;
      }
    }
    const bridgedRoadCount = roads.length - roadCountBeforeBridging;
    const inferredRoadIndexes = Array.from(
      { length: bridgedRoadCount },
      (_, index) => roadCountBeforeBridging + index
    );

    const households = houses.map(toCanvas);
    const reviewDistance = Math.min(1000000, Math.max(0.1,
      Number(options.reviewDistance) > 0 ? Number(options.reviewDistance) : 30
    ));
    const householdRoadAudit = auditHouseholdRoadDistances(households, roads, reviewDistance);
    return {
      imageW: maxX - minX + 80,
      imageH: maxY - minY + 80,
      roads: roads,
      inferredRoadIndexes: inferredRoadIndexes,
      households: households,
      roadReviewDistance: reviewDistance,
      reviewHouseholdIndexes: householdRoadAudit.farIndexes,
      entrance: sourceLabel ? toCanvas(sourceLabel) : null,
      existingBoxes: existingBoxLabels.map(toCanvas),
      plannedBoxes: plannedBoxLabels.map(toCanvas),
      polePoints: poleLabels.map(toCanvas),
      layers: Array.from(new Set(entities.map((entity) => entity.layer || '0'))).sort(),
      stats: {
        pairedRoadCount: pairedRoadCount,
        directRoadCount: directRoadCount,
        arcRoadCount: arcRoadCount,
        ignoredArcCount: ignoredArcCount,
        bridgedRoadCount: bridgedRoadCount,
        roadCount: roads.length,
        householdCount: houses.length,
        householdsWithinRoadReview: householdRoadAudit.withinCount,
        householdsFarFromRoad: householdRoadAudit.farIndexes.length,
        householdRoadMedianDistance: householdRoadAudit.medianDistance,
        householdRoadMaxDistance: householdRoadAudit.maxDistance,
        houseBlockRuleCount: houseBlockNames.length,
        existingBoxBlockRuleCount: existingBoxBlockNames.length,
        plannedBoxBlockRuleCount: plannedBoxBlockNames.length,
        poleBlockRuleCount: poleBlockNames.length,
        entranceBlockRuleCount: entranceBlockNames.length,
        existingBoxCount: existingBoxLabels.length,
        plannedBoxCount: plannedBoxLabels.length,
        poleCount: poleLabels.length,
        entranceFound: Boolean(sourceLabel),
        semanticExtent: semanticExtent,
        minRoadLength: minRoadLength,
        snapTolerance: snapTolerance
      }
    };
  }

  global.CadImport = {
    cleanCadText: cleanCadText,
    normalizeBlockNames: normalizeBlockNames,
    arcToPolyline: arcToPolyline,
    auditHouseholdRoadDistances: auditHouseholdRoadDistances,
    snapRoadEndpoints: snapRoadEndpoints,
    bridgeRoadGaps: bridgeRoadGaps,
    recognize: recognize
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.CadImport;
})(typeof window !== 'undefined' ? window : globalThis);
