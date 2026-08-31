/* 分纤箱布点估算工具 —— 核心算法（纯 JS，无 DOM 依赖，浏览器/Node 通用） */
(function (global) {
  'use strict';

  const EPS = 1e-6;
  const SNAP_TOLERANCE_PX = 20;

  function clamp01(t) { return t < 0 ? 0 : t > 1 ? 1 : t; }
  function segLen(a, b) { return Math.hypot(b.x - a.x, b.y - a.y); }
  function pointKey(x, y) { return Math.round(x * 1000) + ',' + Math.round(y * 1000); }
  function validPoint(p) {
    return p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y));
  }

  // 线段交点；返回 {t,u,x,y} 或 null（t/u 为参数值）
  function segIntersect(p1, p2, p3, p4) {
    const d1x = p2.x - p1.x, d1y = p2.y - p1.y;
    const d2x = p4.x - p3.x, d2y = p4.y - p3.y;
    const denom = d1x * d2y - d1y * d2x;
    if (Math.abs(denom) < 1e-9) return null;
    const dx = p3.x - p1.x, dy = p3.y - p1.y;
    let t = (dx * d2y - dy * d2x) / denom;
    let u = (dx * d1y - dy * d1x) / denom;
    if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null;
    t = clamp01(t); u = clamp01(u);
    return { t: t, u: u, x: p1.x + t * d1x, y: p1.y + t * d1y };
  }

  // 点到线段最近点，返回 {x,y,t,d}
  function projectToSegment(pt, a, b) {
    const vx = b.x - a.x, vy = b.y - a.y;
    const len2 = vx * vx + vy * vy;
    let t = len2 > 0 ? ((pt.x - a.x) * vx + (pt.y - a.y) * vy) / len2 : 0;
    t = clamp01(t);
    const x = a.x + vx * t, y = a.y + vy * t;
    return { x: x, y: y, t: t, d: Math.hypot(pt.x - x, pt.y - y) };
  }

  // 点到一组线段中最近线段
  function projectToSegments(pt, segments) {
    let best = null, bestD = Infinity;
    for (const s of segments) {
      const p = projectToSegment(pt, s.p1, s.p2);
      if (p.d < bestD) { bestD = p.d; best = p; }
    }
    return best;
  }

  // 路网折线 -> 图（交点和端点处切分），边长为米
  function buildRoadGraph(roads, mPerPx) {
    const segments = [];
    for (const road of roads) {
      for (let i = 0; i + 1 < road.length; i++) {
        segments.push({ p1: road[i], p2: road[i + 1] });
      }
    }
    const splits = segments.map(() => [0, 1]);
    for (let i = 0; i < segments.length; i++) {
      for (let j = i + 1; j < segments.length; j++) {
        const ip = segIntersect(segments[i].p1, segments[i].p2, segments[j].p1, segments[j].p2);
        if (ip) {
          splits[i].push(ip.t);
          splits[j].push(ip.u);
          continue;
        }
        // 平行但共线的道路也必须切分，否则重叠道路会被错误建成多个分量。
        const a = segments[i], b = segments[j];
        const avx = a.p2.x - a.p1.x, avy = a.p2.y - a.p1.y;
        const cross = (b.p1.x - a.p1.x) * avy - (b.p1.y - a.p1.y) * avx;
        const cross2 = (b.p2.x - a.p1.x) * avy - (b.p2.y - a.p1.y) * avx;
        const alen2 = avx * avx + avy * avy;
        if (alen2 < EPS || Math.abs(cross) > 1e-7 || Math.abs(cross2) > 1e-7) continue;
        const bvx = b.p2.x - b.p1.x, bvy = b.p2.y - b.p1.y;
        const blen2 = bvx * bvx + bvy * bvy;
        if (blen2 < EPS) continue;
        const ti1 = ((b.p1.x - a.p1.x) * avx + (b.p1.y - a.p1.y) * avy) / alen2;
        const ti2 = ((b.p2.x - a.p1.x) * avx + (b.p2.y - a.p1.y) * avy) / alen2;
        const tj1 = ((a.p1.x - b.p1.x) * bvx + (a.p1.y - b.p1.y) * bvy) / blen2;
        const tj2 = ((a.p2.x - b.p1.x) * bvx + (a.p2.y - b.p1.y) * bvy) / blen2;
        if (Math.max(0, Math.min(ti1, ti2)) <= Math.min(1, Math.max(ti1, ti2)) + EPS &&
            Math.max(0, Math.min(tj1, tj2)) <= Math.min(1, Math.max(tj1, tj2)) + EPS) {
          splits[i].push(clamp01(ti1), clamp01(ti2));
          splits[j].push(clamp01(tj1), clamp01(tj2));
        }
      }
    }
    const nodeMap = new Map();
    const nodes = [];
    const edges = [];
    function getNode(x, y) {
      const key = pointKey(x, y);
      if (nodeMap.has(key)) return nodeMap.get(key);
      const idx = nodes.length;
      nodes.push({ x: x, y: y, key: key });
      nodeMap.set(key, idx);
      return idx;
    }
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      const ts = Array.from(new Set(splits[i])).sort((a, b) => a - b);
      const pts = [];
      for (const t of ts) {
        const x = s.p1.x + (s.p2.x - s.p1.x) * t;
        const y = s.p1.y + (s.p2.y - s.p1.y) * t;
        const last = pts[pts.length - 1];
        if (!last || Math.hypot(x - last.x, y - last.y) > 1) pts.push({ x: x, y: y });
      }
      for (let k = 0; k + 1 < pts.length; k++) {
        const a = getNode(pts[k].x, pts[k].y);
        const b = getNode(pts[k + 1].x, pts[k + 1].y);
        if (a !== b) {
          edges.push({ a: a, b: b, len: segLen(pts[k], pts[k + 1]) * mPerPx });
        }
      }
    }
    const graph = {
      nodes: nodes, edges: edges, segments: segments, mPerPx: mPerPx,
      nodeMap: nodeMap, edgeMap: null, adj: null, dirty: true, getNode: getNode
    };
    return graph;
  }

  // 惰性重建邻接表/边表
  function ensureGraph(graph) {
    if (!graph.dirty) return;
    graph.edgeMap = new Map();
    const adj = Array.from({ length: graph.nodes.length }, () => []);
    for (const e of graph.edges) {
      const key = e.a < e.b ? e.a + ':' + e.b : e.b + ':' + e.a;
      graph.edgeMap.set(key, e.len);
      adj[e.a].push({ v: e.b, w: e.len });
      adj[e.b].push({ v: e.a, w: e.len });
    }
    graph.adj = adj;
    graph.dirty = false;
  }

  // 把点接到路网上（投影到最近边并拆分边），返回节点下标
  function attachPoint(graph, pt, maxDistancePx) {
    if (!validPoint(pt)) return null;
    ensureGraph(graph);
    let be = -1, bd = Infinity, bp = null;
    graph.edges.forEach((e, i) => {
      const proj = projectToSegment(pt, graph.nodes[e.a], graph.nodes[e.b]);
      if (proj.d < bd) { bd = proj.d; be = i; bp = proj; }
    });
    if (be < 0 || (maxDistancePx != null && bd > maxDistancePx)) return null;
    const e = graph.edges[be];
    const a = graph.nodes[e.a], b = graph.nodes[e.b];
    if (Math.hypot(bp.x - a.x, bp.y - a.y) < 1) return e.a;
    if (Math.hypot(bp.x - b.x, bp.y - b.y) < 1) return e.b;
    const idx = graph.getNode(bp.x, bp.y);
    const la = Math.hypot(a.x - bp.x, a.y - bp.y) * graph.mPerPx;
    const lb = Math.hypot(b.x - bp.x, b.y - bp.y) * graph.mPerPx;
    graph.edges.splice(be, 1);
    graph.edges.push({ a: e.a, b: idx, len: la });
    graph.edges.push({ a: idx, b: e.b, len: lb });
    graph.dirty = true;
    return idx;
  }

  // Dijkstra：返回 {dist, prev}
  function dijkstra(graph, start) {
    ensureGraph(graph);
    const n = graph.nodes.length;
    const dist = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const done = new Uint8Array(n);
    dist[start] = 0;
    const adj = graph.adj;
    for (;;) {
      let u = -1, best = Infinity;
      for (let i = 0; i < n; i++) {
        if (!done[i] && dist[i] < best) { best = dist[i]; u = i; }
      }
      if (u < 0) break;
      done[u] = 1;
      for (const ed of adj[u]) {
        if (!done[ed.v] && dist[u] + ed.w < dist[ed.v]) {
          dist[ed.v] = dist[u] + ed.w;
          prev[ed.v] = u;
        }
      }
    }
    return { dist: dist, prev: prev };
  }

  function edgeKey(a, b) { return a < b ? a + ':' + b : b + ':' + a; }

  // 一组目标节点到起点的最短路径并集（光缆路由）
  function routeTo(graph, d0, destNodes) {
    ensureGraph(graph);
    const set = new Set();
    let unionLen = 0;
    for (const dest of destNodes) {
      let cur = dest;
      while (cur !== -1 && d0.prev[cur] !== -1) {
        const p = d0.prev[cur];
        const key = edgeKey(p, cur);
        if (!set.has(key)) {
          set.add(key);
          const len = graph.edgeMap.get(key);
          if (len !== undefined) unionLen += len;
        }
        cur = p;
      }
    }
    const unionEdges = [];
    for (const key of set) {
      const parts = key.split(':');
      unionEdges.push({ a: Number(parts[0]), b: Number(parts[1]) });
    }
    return { unionLen: unionLen, unionEdges: unionEdges };
  }

  // 主入口：计算分纤箱布点
  // input: {roads, households, entrance, existingBoxes, params, mPerPx, mode}
  function placeBoxes(input) {
    const roads = input.roads || [];
    const households = input.households || [];
    const entrance = input.entrance || null;
    const existingBoxes = input.existingBoxes || [];
    const params = input.params || {};
    const mPerPx = Number(input.mPerPx);
    const maxD = Number(params.maxDistance ?? 100);
    const cap = Math.round(Number(params.capacity ?? 16));
    const poleSpacing = Number(params.poleSpacing ?? 50);
    const mode = input.mode || 'greenfield';
    const H = households.length;

    const out = {
      mode: mode, boxes: [], cableLengthM: null, addedCableM: null, totalCableM: null,
      poleCount: null, polePoints: [], coveredCount: 0, existingCoveredCount: 0,
      uncovered: [], unreachableBoxes: [], routeEdges: [], nodes: [], warnings: []
    };

    if (!roads.length || H === 0 || !Number.isFinite(mPerPx) || mPerPx <= 0 ||
        !Number.isFinite(maxD) || maxD <= 0 || !Number.isFinite(cap) || cap < 1 ||
        !Number.isFinite(poleSpacing) || poleSpacing <= 0) {
      if (!mPerPx || mPerPx <= 0) out.warnings.push('未完成比例校准');
      if (!Number.isFinite(maxD) || maxD <= 0) out.warnings.push('覆盖距离必须为正数');
      if (!Number.isFinite(cap) || cap < 1) out.warnings.push('每箱户数必须为正整数');
      if (!Number.isFinite(poleSpacing) || poleSpacing <= 0) out.warnings.push('杆距必须为正数');
      return out;
    }
    for (const road of roads) {
      if (!Array.isArray(road) || road.length < 2 || road.some((p) => !validPoint(p))) {
        out.warnings.push('路网包含无效道路，无法计算');
        return out;
      }
    }
    if (entrance && !validPoint(entrance) || existingBoxes.some((b) => !validPoint(b)) ||
        households.some((h) => !validPoint(h))) {
      out.warnings.push('标注点坐标无效，无法计算');
      return out;
    }

    const graph = buildRoadGraph(roads, mPerPx);
    const maxDpx = maxD / mPerPx;

    // 先把进村点和已有箱接到图上
    const snapPx = SNAP_TOLERANCE_PX;
    const entranceNode = entrance ? attachPoint(graph, entrance, snapPx) : null;
    if (entrance && entranceNode == null) out.warnings.push('进村点距离路网过远，未参与路由');
    const existingNodes = existingBoxes.map((b) => attachPoint(graph, b, snapPx));
    if (existingNodes.some((n) => n == null)) out.warnings.push('部分已有箱距离路网过远，已跳过其路由');
    ensureGraph(graph);
    const dBase = entranceNode != null ? dijkstra(graph, entranceNode) : null;
    const baseDist = dBase ? dBase.dist : null;

    // 候选箱位：沿路每 5 米采样 + 每户在路上的投影点
    const candPts = [];
    const candEnt = []; // 到进村点光缆距离的近似值（米）
    const seen = new Set();
    function pushCand(x, y, entApprox) {
      const k = pointKey(x, y);
      if (seen.has(k)) return;
      seen.add(k);
      candPts.push({ x: x, y: y });
      candEnt.push(entApprox);
    }

    function approxEntDist(px, py) {
      if (baseDist == null) return 0;
      let best = Infinity;
      for (const e of graph.edges) {
        const a = graph.nodes[e.a], b = graph.nodes[e.b];
        const vx = b.x - a.x, vy = b.y - a.y;
        const len2 = vx * vx + vy * vy;
        let t = len2 > 0 ? ((px - a.x) * vx + (py - a.y) * vy) / len2 : 0;
        t = clamp01(t);
        const dx = a.x + vx * t - px, dy = a.y + vy * t - py;
        if (Math.hypot(dx, dy) > 1e-6) continue; // 只认在路上的点
        const viaA = (baseDist[e.a] !== undefined ? baseDist[e.a] : Infinity) + t * e.len;
        const viaB = (baseDist[e.b] !== undefined ? baseDist[e.b] : Infinity) + (1 - t) * e.len;
        const d = Math.min(viaA, viaB);
        if (d < best) best = d;
      }
      return best === Infinity ? 0 : best;
    }

    const sampleStep = 5; // 米
    for (const e of graph.edges) {
      const a = graph.nodes[e.a], b = graph.nodes[e.b];
      const n = Math.max(1, Math.floor(e.len / sampleStep));
      for (let k = 1; k < n; k++) {
        const t = k / n;
        const x = a.x + (b.x - a.x) * t;
        const y = a.y + (b.y - a.y) * t;
        const viaA = (baseDist != null ? baseDist[e.a] : 0) + t * e.len;
        const viaB = (baseDist != null ? baseDist[e.b] : 0) + (1 - t) * e.len;
        pushCand(x, y, baseDist != null ? Math.min(viaA, viaB) : 0);
      }
    }
    for (let i = 0; i < H; i++) {
      const proj = projectToSegments(households[i], graph.segments);
      if (proj) pushCand(proj.x, proj.y, approxEntDist(proj.x, proj.y));
    }

    // 已有箱覆盖（不占容量）
    let pool = [];
    for (let i = 0; i < H; i++) pool.push(i);
    if (mode === 'brownfield' && existingNodes.length) {
      pool = [];
      for (let i = 0; i < H; i++) {
        let covered = false;
        for (const en of existingNodes) {
          if (en == null) continue;
          const np = graph.nodes[en];
          if (Math.hypot(households[i].x - np.x, households[i].y - np.y) <= maxDpx) {
            covered = true;
            break;
          }
        }
        if (covered) out.existingCoveredCount++;
        else pool.push(i);
      }
    }

    const covered = new Uint8Array(H);
    let remaining = pool.length;
    const selected = []; // {cand, assigned:[]}

    // 贪心：每轮选覆盖最多未覆盖户、总距离最小的候选点
    while (remaining > 0) {
      let best = -1, bestCnt = 0, bestSum = Infinity, bestEd = Infinity;
      for (let j = 0; j < candPts.length; j++) {
        let used = false;
        for (const s of selected) {
          if (s.cand === j) { used = true; break; }
        }
        if (used) continue;
        let cnt = 0, sum = 0;
        for (let k = 0; k < pool.length; k++) {
          const i = pool[k];
          if (!covered[i]) {
            const d = Math.hypot(households[i].x - candPts[j].x, households[i].y - candPts[j].y);
            if (d <= maxDpx) { cnt++; sum += d; }
          }
        }
        if (!cnt) continue;
        const ed = candEnt[j];
        if (cnt > bestCnt ||
            (cnt === bestCnt && (sum < bestSum - 1e-9 || (Math.abs(sum - bestSum) <= 1e-9 && ed < bestEd)))) {
          best = j; bestCnt = cnt; bestSum = sum; bestEd = ed;
        }
      }
      if (best < 0) break;
      const order = [];
      for (let k = 0; k < pool.length; k++) {
        const i = pool[k];
        if (!covered[i]) {
          const d = Math.hypot(households[i].x - candPts[best].x, households[i].y - candPts[best].y);
          if (d <= maxDpx) order.push([i, d]);
        }
      }
      order.sort((a, b) => a[1] - b[1]);
      const assigned = order.slice(0, cap).map((o) => o[0]);
      for (const i of assigned) { covered[i] = 1; remaining--; }
      selected.push({ cand: best, assigned: assigned });
    }

    // 局部优化：每箱在服务户覆盖范围内微调位置（k-medoids 式）
    function coversSet(j, A) {
      for (const i of A) {
        if (Math.hypot(households[i].x - candPts[j].x, households[i].y - candPts[j].y) > maxDpx) return false;
      }
      return true;
    }
    function sumDistToSet(j, A) {
      let s = 0;
      for (const i of A) s += Math.hypot(households[i].x - candPts[j].x, households[i].y - candPts[j].y);
      return s;
    }
    for (let iter = 0; iter < 20; iter++) {
      let changed = false;
      for (const s of selected) {
        let cx = 0, cy = 0;
        for (const i of s.assigned) { cx += households[i].x; cy += households[i].y; }
        cx /= s.assigned.length; cy /= s.assigned.length;
        let bestJ = s.cand, bestCost = sumDistToSet(s.cand, s.assigned);
        let bestEd0 = candEnt[bestJ];
        for (let j = 0; j < candPts.length; j++) {
          if (Math.hypot(candPts[j].x - cx, candPts[j].y - cy) > maxDpx) continue;
          if (!coversSet(j, s.assigned)) continue;
          const c = sumDistToSet(j, s.assigned);
          const ed = candEnt[j];
          if (c < bestCost - 1e-9 || (Math.abs(c - bestCost) <= 1e-9 && ed < bestEd0)) {
            bestJ = j; bestCost = c; bestEd0 = ed;
          }
        }
        if (bestJ !== s.cand) { s.cand = bestJ; changed = true; }
      }
      if (!changed) break;
    }

    // 收尾：把仍未被覆盖、但离某个箱在覆盖距离内且有容量的户就近补进去
    {
      let changed = true;
      while (changed) {
        changed = false;
        for (let k = 0; k < pool.length; k++) {
          const i = pool[k];
          if (covered[i]) continue;
          let bestB = -1, bestD = Infinity;
          for (let bi = 0; bi < selected.length; bi++) {
            const s = selected[bi];
            if (s.assigned.length >= cap) continue;
            const d = Math.hypot(households[i].x - candPts[s.cand].x, households[i].y - candPts[s.cand].y);
            if (d <= maxDpx && d < bestD) { bestD = d; bestB = bi; }
          }
          if (bestB >= 0) {
            selected[bestB].assigned.push(i);
            covered[i] = 1;
            remaining--;
            changed = true;
          }
        }
      }
    }

    // 输出箱子
    const boxNodes = [];
    out.boxes = selected.map((s, idx) => {
      const cp = candPts[s.cand];
      boxNodes.push(attachPoint(graph, cp, snapPx));
      return {
        id: 'B' + (idx + 1),
        x: cp.x, y: cp.y,
        xM: +(cp.x * mPerPx).toFixed(1),
        yM: +(cp.y * mPerPx).toFixed(1),
        assigned: s.assigned.slice(),
        entM: null
      };
    });

    let coveredNew = 0;
    for (let k = 0; k < pool.length; k++) if (covered[pool[k]]) coveredNew++;
    out.coveredCount = coveredNew + out.existingCoveredCount;
    for (const i of pool) if (!covered[i]) out.uncovered.push(i);

    // 光缆与杆子
    if (entranceNode != null) {
      ensureGraph(graph);
      const d0 = dijkstra(graph, entranceNode);
      const reachableNew = [];
      let unreachableHouseholds = 0;
      for (let i = 0; i < boxNodes.length; i++) {
        if (boxNodes[i] == null || !Number.isFinite(d0.dist[boxNodes[i]])) {
          out.unreachableBoxes.push(out.boxes[i].id);
          for (const h of out.boxes[i].assigned) {
            if (!out.uncovered.includes(h)) {
              out.uncovered.push(h);
              unreachableHouseholds++;
            }
          }
        } else {
          reachableNew.push(boxNodes[i]);
        }
      }
      out.coveredCount = Math.max(0, out.coveredCount - unreachableHouseholds);
      if (out.unreachableBoxes.length) out.warnings.push('部分新箱位与进村点路网不连通，相关户未计入有效覆盖');
      const reachableExisting = existingNodes.filter((n) => n != null && Number.isFinite(d0.dist[n]));
      const dests = (mode === 'brownfield' ? reachableExisting : []).concat(reachableNew);
      const routeAll = routeTo(graph, d0, dests);
      out.totalCableM = +routeAll.unionLen.toFixed(1);
      let baseLen = 0;
      if (mode === 'brownfield' && reachableExisting.length) {
        baseLen = routeTo(graph, d0, reachableExisting).unionLen;
      }
      out.addedCableM = +Math.max(0, routeAll.unionLen - baseLen).toFixed(1);
      out.cableLengthM = out.totalCableM;
      out.poleCount = Math.ceil(routeAll.unionLen / poleSpacing);
      out.routeEdges = routeAll.unionEdges;
      out.nodes = graph.nodes;
      const polePts = [];
      for (const e of routeAll.unionEdges) {
        const a = graph.nodes[e.a], b = graph.nodes[e.b];
        const lenPx = Math.hypot(b.x - a.x, b.y - a.y);
        const n = Math.floor((lenPx * mPerPx) / poleSpacing);
        for (let k = 1; k < n; k++) {
          polePts.push({ x: a.x + (b.x - a.x) * (k / n), y: a.y + (b.y - a.y) * (k / n) });
        }
      }
      out.polePoints = polePts;
      for (let i = 0; i < out.boxes.length; i++) {
        out.boxes[i].entM = Number.isFinite(d0.dist[boxNodes[i]]) ? +d0.dist[boxNodes[i]].toFixed(1) : null;
      }
    } else {
      out.warnings.push('未标进村点，光缆长度与杆子数量未计算');
    }
    return out;
  }

  // 生成 CSV 工程量清单（UTF-8 BOM，便于 Excel 直接打开）
  // d: {result, households, existingBoxes, poleSpacing, mPerPx}
  function buildCSV(d) {
    const result = d && d.result;
    if (!result || !Array.isArray(result.boxes)) throw new Error('缺少有效的计算结果');
    const households = Array.isArray(d.households) ? d.households : [];
    const existingBoxes = Array.isArray(d.existingBoxes) ? d.existingBoxes : [];
    const mPerPx = Number(d.mPerPx) > 0 ? Number(d.mPerPx) : 0;
    const rows = [];
    rows.push(['项目', '数值']);
    rows.push(['模式', result.mode === 'brownfield' ? '有箱补点' : '无箱新建']);
    rows.push(['分纤箱数量（合计）', result.boxes.length + (result.mode === 'brownfield' ? existingBoxes.length : 0)]);
    rows.push(['分纤箱数量（新增）', result.boxes.length]);
    rows.push(['覆盖户数', result.coveredCount + '/' + households.length]);
    rows.push(['未覆盖户数', Array.isArray(result.uncovered) ? result.uncovered.length : 0]);
    rows.push(['主干光缆长度（米）', result.cableLengthM == null ? '' : result.cableLengthM]);
    rows.push(['新增光缆长度（米）', result.addedCableM == null ? '' : result.addedCableM]);
    rows.push(['杆子根数', result.poleCount == null ? '' : result.poleCount]);
    rows.push(['杆距（米）', Number(d.poleSpacing) > 0 ? Number(d.poleSpacing) : '']);
    rows.push([]);
    rows.push(['每箱明细']);
    rows.push(['箱号', '类型', '覆盖户数', 'X(米)', 'Y(米)', '到进村点光缆(米)', '覆盖户号']);
    if (result.mode === 'brownfield') {
      existingBoxes.forEach((box, index) => {
        rows.push([
          'E' + (index + 1), '已有', '',
          (Number(box.x) * mPerPx).toFixed(1),
          (Number(box.y) * mPerPx).toFixed(1), '', ''
        ]);
      });
    }
    for (const box of result.boxes) {
      rows.push([
        box.id, '新增', Array.isArray(box.assigned) ? box.assigned.length : 0,
        box.xM, box.yM, box.entM == null ? '' : box.entM,
        Array.isArray(box.assigned) ? box.assigned.map((index) => Number(index) + 1).join(';') : ''
      ]);
    }
    return '\uFEFF' + rows.map((row) => row.map((cell) =>
      '"' + String(cell).replace(/"/g, '""') + '"'
    ).join(',')).join('\r\n');
  }

  // 生成示意 DXF（字符串）
  // d: {roads, households, entrance, existingBoxes, boxes, routeEdges, nodes, mPerPx, polePoints}
  function buildDXF(d) {
    const lines = [];
    function layerDef(name, color) {
      lines.push('0', 'LAYER', '2', name, '70', '0', '62', String(color), '6', 'CONTINUOUS');
    }
    lines.push(
      '0', 'SECTION', '2', 'HEADER',
      '9', '$ACADVER', '1', 'AC1015',
      '9', '$INSUNITS', '70', '6',
      '0', 'ENDSEC'
    );
    lines.push('0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'LAYER', '70', '8');
    lines.push('0', 'LAYER', '2', '0', '70', '0', '62', '7', '6', 'CONTINUOUS');
    layerDef('ROAD', 5); layerDef('CABLE', 1); layerDef('BOX', 3);
    layerDef('EXIST', 6); layerDef('POLE', 8); layerDef('HOUSE', 2); layerDef('ENTRANCE', 1);
    lines.push('0', 'ENDTAB', '0', 'ENDSEC');
    lines.push('0', 'SECTION', '2', 'ENTITIES');
    const m = d.mPerPx;
    function M(x, y) { return [+(x * m).toFixed(2), +(y * m).toFixed(2)]; }
    function line(layer, x1, y1, x2, y2) {
      const p1 = M(x1, y1), p2 = M(x2, y2);
      lines.push('0', 'LINE', '8', layer, '10', String(p1[0]), '20', String(p1[1]), '30', '0',
                 '11', String(p2[0]), '21', String(p2[1]), '31', '0');
    }
    function point(layer, x, y) {
      const p = M(x, y);
      lines.push('0', 'POINT', '8', layer, '10', String(p[0]), '20', String(p[1]), '30', '0');
    }
    function circle(layer, x, y, rM) {
      const p = M(x, y);
      lines.push('0', 'CIRCLE', '8', layer, '10', String(p[0]), '20', String(p[1]), '30', '0', '40', String(rM));
    }
    function text(layer, x, y, s) {
      const p = M(x, y);
      lines.push('0', 'TEXT', '8', layer, '10', String(p[0]), '20', String(p[1]), '30', '0', '40', '3', '1', s);
    }
    for (const road of d.roads || []) {
      for (let i = 0; i + 1 < road.length; i++) {
        line('ROAD', road[i].x, road[i].y, road[i + 1].x, road[i + 1].y);
      }
    }
    if (d.routeEdges && d.nodes) {
      for (const e of d.routeEdges) {
        const a = d.nodes[e.a], b = d.nodes[e.b];
        line('CABLE', a.x, a.y, b.x, b.y);
      }
    }
    for (const h of d.households || []) point('HOUSE', h.x, h.y);
    if (d.entrance) point('ENTRANCE', d.entrance.x, d.entrance.y);
    for (const b of d.existingBoxes || []) {
      circle('EXIST', b.x, b.y, 2);
      text('EXIST', b.x, b.y, 'E');
    }
    for (const b of d.boxes || []) {
      circle('BOX', b.x, b.y, 2);
      text('BOX', b.x, b.y, b.id);
    }
    for (const p of d.polePoints || []) point('POLE', p.x, p.y);
    lines.push('0', 'ENDSEC', '0', 'EOF');
    return lines.join('\r\n');
  }

  global.FiberCore = {
    placeBoxes: placeBoxes,
    buildRoadGraph: buildRoadGraph,
    dijkstra: dijkstra,
    attachPoint: attachPoint,
    projectToSegment: projectToSegment,
    projectToSegments: projectToSegments,
    segLen: segLen,
    buildCSV: buildCSV,
    buildDXF: buildDXF
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.FiberCore;
})(typeof window !== 'undefined' ? window : globalThis);
