/* 分纤箱布点估算工具 —— 界面与交互 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const SAVE_KEY = 'fiberTool.project.v1';

  const state = {
    image: null,
    imageDataURL: null,
    imageW: 0,
    imageH: 0,
    calibration: null,      // {px, meters, p1, p2}
    roads: [],              // 每段路：[{x,y}, ...]
    inferredRoadIndexes: [], // 自动补桥道路在 roads 中的索引（需人工复核）
    households: [],         // [{x,y}]
    roadReviewDistance: null, // CAD 户点离路复核阈值（图纸单位）
    entrance: null,         // {x,y}
    existingBoxes: [],      // [{x,y}]
    cadPolePoints: [],      // DXF 中识别到的杆位（仅作图纸参考）
    cadPlannedBoxes: [],    // DXF 中识别到的新设箱位（不直接参与计算）
    mode: 'greenfield',
    params: { maxDistance: 100, capacity: 16, poleSpacing: 50 },
    tool: 'road',
    currentRoad: [],
    calibP1: null,
    results: null,
    history: []             // [{type:...}]
  };

  const view = { cx: 0, cy: 0, scale: 1 };

  let canvas, ctx, wrap, dpr;
  let pendingDxfImport = null;

  /* ---------- 启动 ---------- */

  function init() {
    canvas = $('mapCanvas');
    ctx = canvas.getContext('2d');
    wrap = $('canvasWrap');
    dpr = window.devicePixelRatio || 1;

    bindEvents();
    resize();
    updateHelp();
    updateStatus();
    restoreProject();
    if (state.imageW) fitView();
    draw();
  }

  function resize() {
    const w = wrap.clientWidth, h = wrap.clientHeight;
    canvas.width = Math.max(1, Math.floor(w * dpr));
    canvas.height = Math.max(1, Math.floor(h * dpr));
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    draw();
  }

  window.addEventListener('resize', () => { resize(); if (state.imageW && !view.fittedOnce) fitView(); draw(); });

  /* ---------- 事件绑定 ---------- */

  function bindEvents() {
    document.querySelectorAll('.tool-btn').forEach((btn) => {
      btn.addEventListener('click', () => setTool(btn.dataset.tool));
    });

    $('btnUpload').addEventListener('click', () => $('fileImage').click());
    $('fileImage').addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (f) loadImageFile(f);
      e.target.value = '';
    });
    $('btnUploadDxf').addEventListener('click', () => $('fileDxf').click());
    $('fileDxf').addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (f) loadDxfFile(f);
      e.target.value = '';
    });
    $('btnDemo').addEventListener('click', loadDemo);
    $('btnSave').addEventListener('click', saveProjectFile);
    $('btnOpen').addEventListener('click', () => $('fileProject').click());
    $('fileProject').addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (f) loadProjectFile(f);
      e.target.value = '';
    });
    $('btnClearAll').addEventListener('click', clearAll);
    $('btnClearRoads').addEventListener('click', () => {
      state.roads = [];
      state.inferredRoadIndexes = [];
      state.history = [];
      invalidate();
    });
    $('btnClearHouses').addEventListener('click', () => { state.households = []; state.history = []; invalidate(); });
    $('btnClearBoxes').addEventListener('click', () => { state.existingBoxes = []; state.history = []; invalidate(); });
    $('btnClearCalib').addEventListener('click', () => { state.calibration = null; state.history = []; invalidate(); });
    $('btnUndo').addEventListener('click', undo);
    $('btnFinishRoad').addEventListener('click', finishRoad);

    $('btnCalc').addEventListener('click', calc);
    ['paramDistance', 'paramCapacity', 'paramPole'].forEach((id) => {
      $(id).addEventListener('change', onParamsChange);
    });
    $('modeSelect').addEventListener('change', (e) => {
      state.mode = e.target.value;
      invalidate();
    });

    $('btnPng').addEventListener('click', exportPng);
    $('btnCsv').addEventListener('click', exportCsv);
    $('btnDxf').addEventListener('click', exportDxf);

    $('calibOk').addEventListener('click', () => {
      const meters = parseFloat($('calibMeters').value);
      if (!(meters > 0)) { alert('请输入大于 0 的实际距离'); return; }
      const p1 = state.calibStart;
      const p2 = state.calibP1;
      const before = state.calibration;
      state.calibration = { px: dist(p1, p2), meters: meters, p1: p1, p2: p2 };
      state.calibP1 = null;
      state.calibStart = null;
      hideModal();
      historyPush('calib', { before: before, after: state.calibration });
      invalidate();
    });
    $('calibCancel').addEventListener('click', () => {
      state.calibP1 = null;
      state.calibStart = null;
      hideModal();
      draw();
    });
    $('dxfRerun').addEventListener('click', rerunDxfRecognition);
    $('dxfCancel').addEventListener('click', cancelDxfImport);
    $('dxfConfirm').addEventListener('click', confirmDxfImport);

    // 画布
    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); if (state.tool === 'road') finishRoad(); });
    canvas.addEventListener('dblclick', (e) => { if (state.tool === 'road') { e.preventDefault(); finishRoad(); } });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (pendingDxfImport) {
          cancelDxfImport();
          return;
        }
        state.currentRoad = [];
        state.calibP1 = null;
        state.calibStart = null;
        hideModal();
        draw();
      }
    });
  }

  let panning = null;
  function onMouseDown(e) {
    const pt = imgFromEvent(e);
    if (e.button === 1 || state.tool === 'pan') {
      panning = { x: e.clientX, y: e.clientY };
      return;
    }
    if (e.button !== 0) return;
    handleToolClick(pt);
  }
  function onMouseMove(e) {
    if (panning) {
      const dx = e.clientX - panning.x, dy = e.clientY - panning.y;
      panning = { x: e.clientX, y: e.clientY };
      view.cx -= dx / view.scale;
      view.cy -= dy / view.scale;
      draw();
    }
  }
  function onMouseUp() { panning = null; }
  function onWheel(e) {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const w = wrap.clientWidth, h = wrap.clientHeight;
    const imgX = (mx - w / 2) / view.scale + view.cx;
    const imgY = (my - h / 2) / view.scale + view.cy;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    view.scale = Math.min(50, Math.max(0.02, view.scale * factor));
    view.cx = imgX - (mx - w / 2) / view.scale;
    view.cy = imgY - (my - h / 2) / view.scale;
    draw();
  }

  function imgFromEvent(e) {
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const w = wrap.clientWidth, h = wrap.clientHeight;
    return {
      x: (mx - w / 2) / view.scale + view.cx,
      y: (my - h / 2) / view.scale + view.cy
    };
  }

  function handleToolClick(pt) {
    switch (state.tool) {
      case 'road':
        state.currentRoad.push(pt);
        draw();
        break;
      case 'house':
        state.households.push(pt);
        historyPush('house');
        invalidate();
        break;
      case 'entrance':
        {
          const before = state.entrance;
          state.entrance = pt;
          historyPush('entrance', { before: before, after: pt });
        }
        invalidate();
        break;
      case 'box':
        state.existingBoxes.push(pt);
        historyPush('box', { index: state.existingBoxes.length - 1 });
        invalidate();
        break;
      case 'calib':
        if (!state.calibP1) {
          state.calibP1 = pt;
          state.calibStart = pt;
          draw();
        } else {
          const p2 = pt;
          state.calibP1 = p2;
          const px = dist(state.calibStart, p2);
          if (px < 2) { alert('参考线太短，请重新点击'); state.calibP1 = null; state.calibStart = null; draw(); break; }
          $('calibPx').textContent = Math.round(px);
          showModal();
        }
        break;
      case 'erase':
        eraseAt(pt);
        break;
    }
  }

  /* ---------- 工具与操作 ---------- */

  function setTool(t) {
    if (state.tool === 'road' && state.currentRoad.length >= 2) finishRoad();
    state.tool = t;
    document.querySelectorAll('.tool-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.tool === t);
      b.setAttribute('aria-pressed', b.dataset.tool === t ? 'true' : 'false');
    });
    updateHelp();
    draw();
  }

  function finishRoad() {
    if (state.currentRoad.length >= 2) {
      state.roads.push(state.currentRoad.slice());
      state.currentRoad = [];
      historyPush('road');
      invalidate();
    } else {
      state.currentRoad = [];
      draw();
    }
  }

  function historyPush(type, data) {
    state.history.push(Object.assign({ type: type }, data || {}));
    if (state.history.length > 500) state.history.shift();
  }

  function normalizeInferredRoadIndexes(indexes, roadCount) {
    if (!Array.isArray(indexes)) return [];
    return Array.from(new Set(indexes
      .map(Number)
      .filter((index) => Number.isInteger(index) && index >= 0 && index < roadCount)
    )).sort((a, b) => a - b);
  }

  function currentHouseholdRoadAudit() {
    if (!(state.roadReviewDistance > 0) || !state.households.length) return null;
    return CadImport.auditHouseholdRoadDistances(
      state.households,
      state.roads,
      state.roadReviewDistance
    );
  }

  function removeRoadAt(index) {
    const inferred = state.inferredRoadIndexes.includes(index);
    state.roads.splice(index, 1);
    state.inferredRoadIndexes = state.inferredRoadIndexes
      .filter((roadIndex) => roadIndex !== index)
      .map((roadIndex) => roadIndex > index ? roadIndex - 1 : roadIndex);
    return inferred;
  }

  function insertRoadAt(index, road, inferred) {
    state.roads.splice(index, 0, road);
    const indexes = state.inferredRoadIndexes.map((roadIndex) =>
      roadIndex >= index ? roadIndex + 1 : roadIndex
    );
    if (inferred) indexes.push(index);
    state.inferredRoadIndexes = normalizeInferredRoadIndexes(indexes, state.roads.length);
  }

  function undo() {
    if (state.tool === 'road' && state.currentRoad.length) {
      state.currentRoad.pop();
      draw();
      return;
    }
    const h = state.history.pop();
    if (!h) { alert('没有可撤销的操作'); return; }
    switch (h.type) {
      case 'road': state.roads.pop(); break;
      case 'house': state.households.pop(); break;
      case 'entrance': state.entrance = h.before || null; break;
      case 'box': state.existingBoxes.pop(); break;
      case 'calib': state.calibration = h.before || null; break;
      case 'erase':
        if (h.target === 'entrance') state.entrance = h.value;
        else if (h.target === 'roads') insertRoadAt(h.index, h.value, h.inferredRoad);
        else if (Array.isArray(state[h.target])) state[h.target].splice(h.index, 0, h.value);
        break;
    }
    invalidate();
  }

  function eraseAt(pt) {
    const tolerance = 14 / view.scale;
    let best = null;
    function consider(target, index, value, distance) {
      if (distance <= tolerance && (!best || distance < best.distance)) {
        best = { target: target, index: index, value: value, distance: distance };
      }
    }
    state.households.forEach((point, index) => consider('households', index, point, dist(pt, point)));
    state.existingBoxes.forEach((point, index) => consider('existingBoxes', index, point, dist(pt, point)));
    state.cadPolePoints.forEach((point, index) => consider('cadPolePoints', index, point, dist(pt, point)));
    state.cadPlannedBoxes.forEach((point, index) => consider('cadPlannedBoxes', index, point, dist(pt, point)));
    if (state.entrance) consider('entrance', -1, state.entrance, dist(pt, state.entrance));
    state.roads.forEach((road, index) => {
      let roadDistance = Infinity;
      for (let i = 0; i + 1 < road.length; i++) {
        roadDistance = Math.min(roadDistance, FiberCore.projectToSegment(pt, road[i], road[i + 1]).d);
      }
      consider('roads', index, road, roadDistance);
    });
    if (!best) {
      $('statusBar').textContent = '未选中对象；请靠近户点、道路、入口或箱杆参考点点击。';
      return;
    }
    if (best.target === 'entrance') state.entrance = null;
    else if (best.target === 'roads') best.inferredRoad = removeRoadAt(best.index);
    else state[best.target].splice(best.index, 1);
    historyPush('erase', best);
    invalidate();
  }

  function invalidate() {
    state.results = null;
    renderResults();
    autosave();
    updateStatus();
    draw();
  }

  function onParamsChange() {
    state.params.maxDistance = clampNum(parseFloat($('paramDistance').value), 1, 1000, 100);
    state.params.capacity = Math.round(clampNum(parseFloat($('paramCapacity').value), 1, 200, 16));
    state.params.poleSpacing = clampNum(parseFloat($('paramPole').value), 1, 200, 50);
    invalidate();
  }

  function clampNum(v, lo, hi, def) {
    if (!(v >= lo)) v = def;
    return Math.min(hi, Math.max(lo, v));
  }

  function clearAll() {
    if (!confirm('确定清空当前工程（地图、标注、结果）吗？')) return;
    state.image = null;
    state.imageDataURL = null;
    state.imageW = 0;
    state.imageH = 0;
    state.calibration = null;
    state.roads = [];
    state.inferredRoadIndexes = [];
    state.households = [];
    state.roadReviewDistance = null;
    state.entrance = null;
    state.existingBoxes = [];
    state.cadPolePoints = [];
    state.cadPlannedBoxes = [];
    state.currentRoad = [];
    state.calibP1 = null;
    state.calibStart = null;
    state.results = null;
    state.history = [];
    localStorage.removeItem(SAVE_KEY);
    renderResults();
    updateStatus();
    draw();
  }

  function clearTransientInput() {
    state.currentRoad = [];
    state.calibP1 = null;
    state.calibStart = null;
    hideModal();
  }

  /* ---------- 计算 ---------- */

  function calc() {
    if (!state.households.length) { alert('请先在图上点出住户（户点）'); return; }
    if (!state.roads.length) { alert('请先画出路网'); return; }
    if (!state.calibration) { alert('请先做比例校准（比例校准工具，点两个点并输入实际距离）'); return; }
    const mPerPx = state.calibration.meters / state.calibration.px;
    const res = FiberCore.placeBoxes({
      roads: state.roads,
      households: state.households,
      entrance: state.entrance,
      existingBoxes: state.existingBoxes,
      params: state.params,
      mPerPx: mPerPx,
      mode: state.mode
    });
    state.results = res;
    renderResults();
    autosave();
    updateStatus();
    draw();
    if (res.warnings.length) alert(res.warnings.join('\n'));
  }

  /* ---------- 结果面板 ---------- */

  function renderResults() {
    const res = state.results;
    const sum = $('resultSummary');
    const tab = $('resultTable');
    if (!res) {
      sum.innerHTML = '<span style="color:#8a97a6">尚未计算。标注完成后点"计算布点"。</span>';
      tab.innerHTML = '';
      return;
    }
    const modeName = res.mode === 'brownfield' ? '有箱补点' : '无箱新建';
    const totalBoxes = res.boxes.length + (res.mode === 'brownfield' ? state.existingBoxes.length : 0);
    let html = '';
    html += '<div>模式：' + modeName + '</div>';
    html += '<div>分纤箱数量（合计）：<span class="num">' + totalBoxes + '</span>' +
            (res.mode === 'brownfield' ? '（新增 <span class="num">' + res.boxes.length + '</span>）' : '') + '</div>';
    html += '<div>覆盖户数：<span class="num">' + res.coveredCount + '</span> / ' + state.households.length + '</div>';
    if (res.uncovered.length) html += '<div style="color:#d9534f">未覆盖户数：' + res.uncovered.length + '</div>';
    if (res.warnings && res.warnings.length) {
      html += '<div style="color:#d9534f">警告：' + res.warnings.join('；') + '</div>';
    }
    if (res.cableLengthM != null) {
      html += '<div>主干光缆长度：<span class="num">' + res.cableLengthM + '</span> 米</div>';
      if (res.mode === 'brownfield') html += '<div>新增光缆长度：<span class="num">' + res.addedCableM + '</span> 米</div>';
      html += '<div>杆子根数：<span class="num">' + res.poleCount + '</span>（约 ' + state.params.poleSpacing + ' 米一根）</div>';
    } else {
      html += '<div style="color:#e67e22">未标进村点：光缆/杆子未计算</div>';
    }
    sum.innerHTML = html;

    if (res.boxes.length) {
      let t = '<table><tr><th>箱号</th><th>覆盖户数</th><th>X(米)</th><th>Y(米)</th><th>到进村点(米)</th></tr>';
      for (const b of res.boxes) {
        t += '<tr><td>' + b.id + '</td><td>' + b.assigned.length + '</td><td>' + b.xM + '</td><td>' + b.yM + '</td><td>' + (b.entM != null ? b.entM : '—') + '</td></tr>';
      }
      t += '</table>';
      tab.innerHTML = t;
    } else {
      tab.innerHTML = '';
    }
  }

  /* ---------- 绘制 ---------- */

  function draw() {
    const w = wrap.clientWidth, h = wrap.clientHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!state.imageW) {
      ctx.fillStyle = '#b8c2cd';
      ctx.font = '16px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('点击"上传地图"或"载入示例村"开始', w / 2, h / 2);
      ctx.textAlign = 'left';
      return;
    }
    ctx.save();
    ctx.translate(w / 2 - view.cx * view.scale, h / 2 - view.cy * view.scale);
    ctx.scale(view.scale, view.scale);
    paintScene(ctx, view.scale);
    ctx.restore();
  }

  function paintScene(g, scale) {
    if (state.image) g.drawImage(state.image, 0, 0, state.imageW, state.imageH);
    const lw = (px) => px / scale;
    const r = (px) => px / scale;

    // 校准线
    if (state.calibration) {
      g.strokeStyle = '#f1c40f';
      g.lineWidth = lw(2);
      g.beginPath();
      g.moveTo(state.calibration.p1.x, state.calibration.p1.y);
      g.lineTo(state.calibration.p2.x, state.calibration.p2.y);
      g.stroke();
      g.fillStyle = '#f1c40f';
      g.font = 'bold ' + lw(14) + 'px sans-serif';
      g.fillText('校准 ' + state.calibration.meters + 'm', (state.calibration.p1.x + state.calibration.p2.x) / 2, (state.calibration.p1.y + state.calibration.p2.y) / 2 - lw(8));
    }

    // 路网
    g.strokeStyle = '#1f6fb2';
    g.lineWidth = lw(3);
    g.lineJoin = 'round';
    g.lineCap = 'round';
    const inferredRoads = new Set(state.inferredRoadIndexes);
    for (let roadIndex = 0; roadIndex < state.roads.length; roadIndex++) {
      const road = state.roads[roadIndex];
      if (road.length < 2) continue;
      const inferred = inferredRoads.has(roadIndex);
      g.setLineDash(inferred ? [lw(8), lw(5)] : []);
      g.strokeStyle = inferred ? '#f39c12' : '#1f6fb2';
      g.lineWidth = lw(inferred ? 4 : 3);
      g.beginPath();
      g.moveTo(road[0].x, road[0].y);
      for (let i = 1; i < road.length; i++) g.lineTo(road[i].x, road[i].y);
      g.stroke();
    }
    g.setLineDash([]);
    // 当前路
    if (state.currentRoad.length) {
      g.setLineDash([lw(8), lw(6)]);
      g.strokeStyle = '#f39c12';
      g.lineWidth = lw(3);
      g.beginPath();
      g.moveTo(state.currentRoad[0].x, state.currentRoad[0].y);
      for (let i = 1; i < state.currentRoad.length; i++) g.lineTo(state.currentRoad[i].x, state.currentRoad[i].y);
      g.stroke();
      g.setLineDash([]);
    }

    // 校准点（第一点）
    if (state.calibP1 && !state.calibration) {
      g.fillStyle = '#f1c40f';
      g.beginPath();
      g.arc(state.calibP1.x, state.calibP1.y, r(5), 0, Math.PI * 2);
      g.fill();
    }

    // 户点；红色外圈表示超过 CAD 导入时设置的离路复核阈值。
    const roadAudit = currentHouseholdRoadAudit();
    const reviewHouseholds = new Set(roadAudit ? roadAudit.farIndexes : []);
    for (let houseIndex = 0; houseIndex < state.households.length; houseIndex++) {
      const h = state.households[houseIndex];
      g.fillStyle = '#e07b00';
      g.strokeStyle = '#fff';
      g.lineWidth = lw(1.5);
      g.beginPath();
      g.arc(h.x, h.y, r(4), 0, Math.PI * 2);
      g.fill();
      g.stroke();
      if (reviewHouseholds.has(houseIndex)) {
        g.strokeStyle = '#d63031';
        g.lineWidth = lw(2.5);
        g.beginPath();
        g.arc(h.x, h.y, r(8), 0, Math.PI * 2);
        g.stroke();
      }
    }

    // 进村点
    if (state.entrance) {
      g.fillStyle = '#d63031';
      g.strokeStyle = '#fff';
      g.lineWidth = lw(1.5);
      const e = state.entrance, s = r(9);
      g.beginPath();
      g.moveTo(e.x, e.y - s);
      g.lineTo(e.x + s * 0.9, e.y + s * 0.7);
      g.lineTo(e.x - s * 0.9, e.y + s * 0.7);
      g.closePath();
      g.fill();
      g.stroke();
      g.fillStyle = '#d63031';
      g.font = 'bold ' + lw(13) + 'px sans-serif';
      g.fillText('进村点', e.x + r(10), e.y - r(8));
    }

    // 已有箱
    for (const b of state.existingBoxes) {
      g.fillStyle = '#8e44ad';
      g.strokeStyle = '#fff';
      g.lineWidth = lw(1.5);
      g.fillRect(b.x - r(6), b.y - r(6), r(12), r(12));
      g.strokeRect(b.x - r(6), b.y - r(6), r(12), r(12));
      g.fillStyle = '#8e44ad';
      g.font = 'bold ' + lw(13) + 'px sans-serif';
      g.fillText('E', b.x + r(9), b.y - r(8));
    }

    // DXF 中识别到的参考杆位和新设箱位（不参与当前算法）
    for (const p of state.cadPolePoints) {
      g.fillStyle = '#526b72';
      g.fillRect(p.x - r(2), p.y - r(2), r(4), r(4));
    }
    for (const b of state.cadPlannedBoxes) {
      g.strokeStyle = '#e26d3d';
      g.fillStyle = 'rgba(226,109,61,.12)';
      g.lineWidth = lw(2);
      g.strokeRect(b.x - r(7), b.y - r(7), r(14), r(14));
      g.fillRect(b.x - r(7), b.y - r(7), r(14), r(14));
      g.fillStyle = '#b94d26';
      g.font = 'bold ' + lw(11) + 'px sans-serif';
      g.fillText('CAD', b.x + r(9), b.y - r(8));
    }

    // 结果
    const res = state.results;
    if (res) {
      // 覆盖圈
      const maxDpx = state.params.maxDistance / (state.calibration ? state.calibration.meters / state.calibration.px : 1);
      for (const b of res.boxes) {
        g.fillStyle = 'rgba(39,174,96,.10)';
        g.strokeStyle = 'rgba(39,174,96,.35)';
        g.lineWidth = lw(1.2);
        g.beginPath();
        g.arc(b.x, b.y, maxDpx, 0, Math.PI * 2);
        g.fill();
        g.stroke();
      }
      // 户到箱连线
      g.strokeStyle = 'rgba(127,140,141,.5)';
      g.lineWidth = lw(1);
      for (const b of res.boxes) {
        for (const i of b.assigned) {
          g.beginPath();
          g.moveTo(b.x, b.y);
          g.lineTo(state.households[i].x, state.households[i].y);
          g.stroke();
        }
      }
      // 光缆路由
      if (res.routeEdges.length && res.nodes.length) {
        g.strokeStyle = '#c0392b';
        g.lineWidth = lw(3);
        g.beginPath();
        for (const e of res.routeEdges) {
          const a = res.nodes[e.a], b = res.nodes[e.b];
          g.moveTo(a.x, a.y);
          g.lineTo(b.x, b.y);
        }
        g.stroke();
      }
      // 杆子
      g.fillStyle = '#7f8c8d';
      for (const p of res.polePoints) {
        g.beginPath();
        g.arc(p.x, p.y, r(2.5), 0, Math.PI * 2);
        g.fill();
      }
      // 新箱
      for (const b of res.boxes) {
        g.fillStyle = '#27ae60';
        g.strokeStyle = '#fff';
        g.lineWidth = lw(2);
        g.beginPath();
        g.arc(b.x, b.y, r(8), 0, Math.PI * 2);
        g.fill();
        g.stroke();
        g.fillStyle = '#1e8449';
        g.font = 'bold ' + lw(14) + 'px sans-serif';
        g.fillText(b.id, b.x + r(10), b.y - r(10));
      }
      // 未覆盖户
      g.fillStyle = '#d63031';
      for (const i of res.uncovered) {
        g.beginPath();
        g.arc(state.households[i].x, state.households[i].y, r(5), 0, Math.PI * 2);
        g.fill();
      }
    }
  }

  /* ---------- 导出 ---------- */

  function download(content, filename, mime) {
    const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }

  function exportPng() {
    if (!state.imageW) { alert('请先上传地图'); return; }
    const W = state.imageW, H = state.imageH;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, W, H);
    if (state.image) g.drawImage(state.image, 0, 0, W, H);
    g.save();
    g.scale(1, 1);
    paintScene(g, 1);
    g.restore();
    download(c.toDataURL('image/png'), '分纤箱布点标注图.png', 'image/png');
  }

  function exportCsv() {
    const res = state.results;
    if (!res) { alert('请先计算布点'); return; }
    const mPerPx = state.calibration ? state.calibration.meters / state.calibration.px : 0;
    const csv = FiberCore.buildCSV({
      result: res,
      households: state.households,
      existingBoxes: state.existingBoxes,
      poleSpacing: state.params.poleSpacing,
      mPerPx: mPerPx
    });
    download(csv, '分纤箱布点清单.csv', 'text/csv;charset=utf-8');
  }

  function exportDxf() {
    const res = state.results;
    if (!res) { alert('请先计算布点'); return; }
    if (!state.calibration) { alert('请先做比例校准'); return; }
    const dxf = FiberCore.buildDXF({
      roads: state.roads,
      households: state.households,
      entrance: state.entrance,
      existingBoxes: state.existingBoxes,
      boxes: res.boxes,
      routeEdges: res.routeEdges,
      nodes: res.nodes,
      mPerPx: state.calibration.meters / state.calibration.px,
      polePoints: res.polePoints
    });
    download(dxf, '分纤箱布点示意.dxf', 'application/dxf');
  }

  /* ---------- 工程保存/加载 ---------- */

  function serialize() {
    return JSON.stringify({
      version: 1,
      imageDataURL: state.imageDataURL,
      imageW: state.imageW,
      imageH: state.imageH,
      calibration: state.calibration,
      roads: state.roads,
      inferredRoadIndexes: state.inferredRoadIndexes,
      households: state.households,
      roadReviewDistance: state.roadReviewDistance,
      entrance: state.entrance,
      existingBoxes: state.existingBoxes,
      cadPolePoints: state.cadPolePoints,
      cadPlannedBoxes: state.cadPlannedBoxes,
      mode: state.mode,
      params: state.params,
      results: state.results
    });
  }

  let saveTimer = null;
  function autosave(silent) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(SAVE_KEY, serialize());
        if (!silent && $('statusBar')) $('statusBar').textContent = '工程已自动保存。';
      } catch (err) {
        console.warn('自动保存失败（可能图片过大）', err);
        if ($('statusBar')) $('statusBar').textContent = '自动保存失败，请点击“保存工程”下载 JSON。';
      }
    }, 400);
  }

  function restoreProject() {
    let raw = null;
    try { raw = localStorage.getItem(SAVE_KEY); } catch (e) { /* ignore */ }
    if (!raw) return;
    try {
      const data = JSON.parse(raw);
      applyProject(data);
      $('statusBar').textContent = '已自动恢复上次工程；如需重新开始，点"清空工程"。';
    } catch (e) {
      console.warn('恢复工程失败', e);
    }
  }

  function saveProjectFile() {
    download(serialize(), '分纤箱布点工程.json', 'application/json');
  }

  function loadProjectFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        applyProject(JSON.parse(reader.result));
        autosave();
        $('statusBar').textContent = '工程已加载。';
      } catch (e) {
        alert('工程文件解析失败：' + e.message);
      }
    };
    reader.readAsText(file);
  }

  function normalizeProject(data) {
    if (!data || typeof data !== 'object') throw new Error('工程数据不是对象');
    const point = (p, name) => {
      if (!p || !Number.isFinite(Number(p.x)) || !Number.isFinite(Number(p.y))) {
        throw new Error(name + '坐标无效');
      }
      return { x: Number(p.x), y: Number(p.y) };
    };
    const roads = Array.isArray(data.roads) ? data.roads.map((road, i) => {
      if (!Array.isArray(road) || road.length < 2) throw new Error('第' + (i + 1) + '段道路无效');
      return road.map((p) => point(p, '道路'));
    }) : [];
    const inferredRoadIndexes = normalizeInferredRoadIndexes(data.inferredRoadIndexes, roads.length);
    const households = Array.isArray(data.households) ? data.households.map((p) => point(p, '户点')) : [];
    const roadReviewDistance = Number(data.roadReviewDistance) > 0
      ? Math.min(1000000, Math.max(0.1, Number(data.roadReviewDistance)))
      : null;
    const existingBoxes = Array.isArray(data.existingBoxes) ? data.existingBoxes.map((p) => point(p, '已有箱')) : [];
    const calibration = data.calibration || null;
    if (calibration && (!(Number(calibration.px) > 0) || !(Number(calibration.meters) > 0))) {
      throw new Error('比例校准数据无效');
    }
    if (calibration) {
      calibration.p1 = point(calibration.p1, '校准点');
      calibration.p2 = point(calibration.p2, '校准点');
      calibration.px = Number(calibration.px);
      calibration.meters = Number(calibration.meters);
    }
    const rawParams = data.params || {};
    const maxDistance = clampNum(Number(rawParams.maxDistance ?? 100), 1, 1000, 100);
    const capacity = Math.round(clampNum(Number(rawParams.capacity ?? 16), 1, 200, 16));
    const poleSpacing = clampNum(Number(rawParams.poleSpacing ?? 50), 1, 200, 50);
    const rawResults = data.results;
    const validResults = rawResults && typeof rawResults === 'object' &&
      Array.isArray(rawResults.boxes) && Array.isArray(rawResults.uncovered) &&
      Array.isArray(rawResults.warnings) && Array.isArray(rawResults.routeEdges) &&
      Array.isArray(rawResults.nodes) &&
      rawResults.boxes.every((b) =>
        b && /^B\d+$/.test(String(b.id)) && Number.isFinite(Number(b.x)) &&
        Number.isFinite(Number(b.y)) && Number.isFinite(Number(b.xM)) &&
        Number.isFinite(Number(b.yM)) && (b.entM == null || Number.isFinite(Number(b.entM))) &&
        Array.isArray(b.assigned) &&
        b.assigned.every((i) => Number.isInteger(Number(i)) && Number(i) >= 0 && Number(i) < households.length)
      ) &&
      rawResults.uncovered.every((i) => Number.isInteger(Number(i)) && Number(i) >= 0 && Number(i) < households.length) &&
      rawResults.warnings.every((w) => typeof w === 'string') &&
      Number.isFinite(Number(rawResults.coveredCount)) &&
      (rawResults.cableLengthM == null || Number.isFinite(Number(rawResults.cableLengthM))) &&
      (rawResults.addedCableM == null || Number.isFinite(Number(rawResults.addedCableM))) &&
      (rawResults.poleCount == null || Number.isFinite(Number(rawResults.poleCount)));
    return {
      imageDataURL: typeof data.imageDataURL === 'string' ? data.imageDataURL : null,
      imageW: Number(data.imageW) > 0 ? Number(data.imageW) : 0,
      imageH: Number(data.imageH) > 0 ? Number(data.imageH) : 0,
      calibration: calibration,
      roads: roads,
      inferredRoadIndexes: inferredRoadIndexes,
      households: households,
      roadReviewDistance: roadReviewDistance,
      entrance: data.entrance ? point(data.entrance, '进村点') : null,
      existingBoxes: existingBoxes,
      cadPolePoints: Array.isArray(data.cadPolePoints) ? data.cadPolePoints.map((p) => point(p, 'CAD杆位')) : [],
      cadPlannedBoxes: Array.isArray(data.cadPlannedBoxes) ? data.cadPlannedBoxes.map((p) => point(p, 'CAD箱位')) : [],
      mode: data.mode === 'brownfield' ? 'brownfield' : 'greenfield',
      params: { maxDistance: maxDistance, capacity: capacity, poleSpacing: poleSpacing },
      results: validResults ? rawResults : null
    };
  }

  function applyProject(data) {
    const project = normalizeProject(data);
    state.imageDataURL = project.imageDataURL;
    state.imageW = project.imageW;
    state.imageH = project.imageH;
    state.image = null;
    state.calibration = project.calibration;
    state.roads = project.roads;
    state.inferredRoadIndexes = project.inferredRoadIndexes;
    state.households = project.households;
    state.roadReviewDistance = project.roadReviewDistance;
    state.entrance = project.entrance;
    state.existingBoxes = project.existingBoxes;
    state.cadPolePoints = project.cadPolePoints;
    state.cadPlannedBoxes = project.cadPlannedBoxes;
    state.mode = project.mode;
    state.params = project.params;
    state.results = project.results;
    clearTransientInput();
    state.history = [];
    $('paramDistance').value = state.params.maxDistance;
    $('paramCapacity').value = state.params.capacity;
    $('paramPole').value = state.params.poleSpacing;
    $('modeSelect').value = state.mode;
    if (state.imageDataURL) {
      const img = new Image();
      img.onload = () => {
        state.image = img;
        state.imageW = img.naturalWidth;
        state.imageH = img.naturalHeight;
        fitView();
        renderResults();
        updateStatus();
        draw();
      };
      img.src = state.imageDataURL;
    } else {
      fitView();
      renderResults();
      updateStatus();
      draw();
    }
  }

  function loadImageFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        state.image = img;
        state.imageDataURL = reader.result;
        state.imageW = img.naturalWidth;
        state.imageH = img.naturalHeight;
        state.calibration = null;
        state.roads = [];
        state.inferredRoadIndexes = [];
        state.households = [];
        state.roadReviewDistance = null;
        state.entrance = null;
        state.existingBoxes = [];
        state.cadPolePoints = [];
        state.cadPlannedBoxes = [];
        state.results = null;
        state.history = [];
        clearTransientInput();
        fitView();
        invalidate();
        $('statusBar').textContent = '地图已加载。请先用"比例校准"工具校准，再画路网、点户点。';
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  function captureWorkspace() {
    return { state: Object.assign({}, state), view: Object.assign({}, view) };
  }

  function restoreWorkspace(snapshot) {
    Object.assign(state, snapshot.state);
    Object.assign(view, snapshot.view);
    $('paramDistance').value = state.params.maxDistance;
    $('paramCapacity').value = state.params.capacity;
    $('paramPole').value = state.params.poleSpacing;
    $('modeSelect').value = state.mode;
    renderResults();
    updateStatus();
    draw();
  }

  function populateLayerSelect(id, layers, selected) {
    const select = $(id);
    select.textContent = '';
    const automatic = document.createElement('option');
    automatic.value = '';
    automatic.textContent = '自动识别';
    select.appendChild(automatic);
    for (const layer of layers) {
      const option = document.createElement('option');
      option.value = layer;
      option.textContent = layer;
      select.appendChild(option);
    }
    select.value = selected || '';
  }

  function selectedDxfLayers() {
    return {
      roadLayer: $('dxfRoadLayer').value,
      roadMode: $('dxfRoadMode').value,
      houseLayer: $('dxfHouseLayer').value,
      boxLayer: $('dxfBoxLayer').value,
      plannedBoxLayer: $('dxfPlannedBoxLayer').value,
      poleLayer: $('dxfPoleLayer').value,
      houseBlockNames: $('dxfHouseBlocks').value,
      existingBoxBlockNames: $('dxfExistingBoxBlocks').value,
      plannedBoxBlockNames: $('dxfPlannedBoxBlocks').value,
      poleBlockNames: $('dxfPoleBlocks').value,
      entranceBlockNames: $('dxfEntranceBlocks').value,
      reviewDistance: clampNum(parseFloat($('dxfReviewDistance').value), 0.1, 1000000, 30)
    };
  }

  function countRoadComponents(roads) {
    if (!roads.length) return 0;
    const graph = FiberCore.buildRoadGraph(roads, 1);
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

  function applyDxfPreview(candidate) {
    state.image = null;
    state.imageDataURL = null;
    state.imageW = candidate.imageW;
    state.imageH = candidate.imageH;
    state.calibration = null;
    state.roads = candidate.roads;
    state.inferredRoadIndexes = normalizeInferredRoadIndexes(candidate.inferredRoadIndexes, candidate.roads.length);
    state.households = candidate.households;
    state.roadReviewDistance = candidate.roadReviewDistance;
    state.entrance = candidate.entrance;
    state.existingBoxes = candidate.existingBoxes;
    state.cadPolePoints = candidate.polePoints;
    state.cadPlannedBoxes = candidate.plannedBoxes;
    state.mode = candidate.existingBoxes.length ? 'brownfield' : 'greenfield';
    $('modeSelect').value = state.mode;
    state.currentRoad = [];
    state.calibP1 = null;
    state.calibStart = null;
    state.results = null;
    state.history = [];
    fitView();
    renderResults();
    updateStatus();
    draw();
  }

  function renderDxfImportSummary(candidate) {
    const stats = candidate.stats;
    const components = countRoadComponents(candidate.roads);
    candidate.stats.roadComponents = components;
    let html = '<div>户点 <strong>' + stats.householdCount + '</strong>；道路 <strong>' + stats.roadCount +
      '</strong> 段；路网分量 <strong>' + components + '</strong></div>';
    html += '<div>入口 ' + (stats.entranceFound ? '已识别' : '未识别') +
      '；已有箱 ' + stats.existingBoxCount + '；新设箱参考 ' + stats.plannedBoxCount +
      '；杆位参考 ' + stats.poleCount + '</div>';
    html += '<div>双边线中心线 ' + stats.pairedRoadCount + ' 段；直接道路 ' + stats.directRoadCount +
      ' 段；缺口补桥 ' + stats.bridgedRoadCount + ' 段</div>';
    if (stats.arcRoadCount || stats.ignoredArcCount) {
      html += '<div>圆弧中心线 ' + stats.arcRoadCount + ' 段；未直接采用的道路层圆弧 ' +
        stats.ignoredArcCount + ' 段</div>';
    }
    const blockRuleTotal = stats.houseBlockRuleCount + stats.existingBoxBlockRuleCount +
      stats.plannedBoxBlockRuleCount + stats.poleBlockRuleCount + stats.entranceBlockRuleCount;
    if (blockRuleTotal) {
      html += '<div>图块名规则：民房 ' + stats.houseBlockRuleCount + '；已有箱 ' +
        stats.existingBoxBlockRuleCount + '；新设箱 ' + stats.plannedBoxBlockRuleCount +
        '；电杆 ' + stats.poleBlockRuleCount + '；进村点 ' + stats.entranceBlockRuleCount + '</div>';
    }
    const medianRoadDistance = formatDrawingDistance(stats.householdRoadMedianDistance);
    const maxRoadDistance = formatDrawingDistance(stats.householdRoadMaxDistance);
    html += '<div>户点到路网：阈值内 <strong>' + stats.householdsWithinRoadReview + ' / ' +
      stats.householdCount + '</strong>（≤ ' + formatDrawingDistance(candidate.roadReviewDistance) +
      ' 图纸单位）；中位 ' + medianRoadDistance + '；最远 ' + maxRoadDistance + '</div>';
    if (!stats.roadCount) html += '<div class="warning">未识别到道路，请指定道路图层后重新识别。</div>';
    else if (components > 1) html += '<div class="warning">路网仍有 ' + components + ' 个断开的分量，请复核或手工连接。</div>';
    if (stats.roadCount && stats.householdsFarFromRoad) {
      html += '<div class="warning">有 ' + stats.householdsFarFromRoad +
        ' 个户点远离当前路网，已在画布上加红圈；请检查漏识别道路或误识别户点。</div>';
    }
    $('dxfImportSummary').innerHTML = html;
  }

  function formatDrawingDistance(value) {
    if (!Number.isFinite(Number(value))) return '—';
    return String(Math.round(Number(value) * 10) / 10);
  }

  function runDxfRecognition(options) {
    const candidate = CadImport.recognize(pendingDxfImport.parsed, options);
    pendingDxfImport.options = options;
    pendingDxfImport.candidate = candidate;
    applyDxfPreview(candidate);
    renderDxfImportSummary(candidate);
    $('statusBar').textContent = '正在预览 DXF 识别结果；确认后才会保存到工程。';
  }

  function rerunDxfRecognition() {
    if (!pendingDxfImport) return;
    try {
      runDxfRecognition(selectedDxfLayers());
    } catch (err) {
      alert('重新识别失败：' + err.message);
    }
  }

  function confirmDxfImport() {
    if (!pendingDxfImport) return;
    const candidate = pendingDxfImport.candidate;
    pendingDxfImport = null;
    $('dxfImportModal').classList.add('hidden');
    autosave(true);
    $('statusBar').textContent = 'DXF 已确认导入：民房 ' + candidate.households.length +
      ' 户；道路 ' + candidate.roads.length + ' 段；路网分量 ' + candidate.stats.roadComponents +
      '；离路复核 ' + candidate.stats.householdsFarFromRoad + ' 户。请人工复核并校准比例。';
  }

  function cancelDxfImport() {
    if (!pendingDxfImport) return;
    const before = pendingDxfImport.before;
    pendingDxfImport = null;
    $('dxfImportModal').classList.add('hidden');
    restoreWorkspace(before);
    autosave(true);
    $('statusBar').textContent = '已取消 DXF 导入，原工程未被替换。';
  }

  function loadDxfFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = DxfLite.parse(reader.result);
        const layers = Array.from(new Set(parsed.entities.map((entity) => entity.layer || '0'))).sort();
        clearTimeout(saveTimer);
        saveTimer = null;
        pendingDxfImport = {
          parsed: parsed,
          fileName: file.name,
          before: captureWorkspace(),
          options: {},
          candidate: null
        };
        $('dxfImportFile').textContent = file.name;
        populateLayerSelect('dxfRoadLayer', layers, '');
        $('dxfRoadMode').value = 'auto';
        populateLayerSelect('dxfHouseLayer', layers, '');
        populateLayerSelect('dxfBoxLayer', layers, '');
        populateLayerSelect('dxfPlannedBoxLayer', layers, '');
        populateLayerSelect('dxfPoleLayer', layers, '');
        $('dxfReviewDistance').value = '30';
        ['dxfHouseBlocks', 'dxfExistingBoxBlocks', 'dxfPlannedBoxBlocks', 'dxfPoleBlocks', 'dxfEntranceBlocks']
          .forEach((id) => { $(id).value = ''; });
        runDxfRecognition({});
        $('dxfImportModal').classList.remove('hidden');
      } catch (err) {
        if (pendingDxfImport) restoreWorkspace(pendingDxfImport.before);
        pendingDxfImport = null;
        alert('DXF 导入失败：' + err.message);
      }
    };
    reader.readAsText(file);
  }

  function fitView() {
    if (!state.imageW) return;
    const w = wrap.clientWidth, h = wrap.clientHeight;
    view.scale = Math.min(w / state.imageW, h / state.imageH) * 0.92;
    view.cx = state.imageW / 2;
    view.cy = state.imageH / 2;
    view.fittedOnce = true;
  }

  /* ---------- 示例村 ---------- */

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function loadDemo() {
    const W = 1200, H = 800;
    const bg = document.createElement('canvas');
    bg.width = W; bg.height = H;
    const g = bg.getContext('2d');
    g.fillStyle = '#f4f1e8';
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#e2e9cf';
    g.fillRect(60, 60, 420, 300);
    g.fillRect(720, 60, 400, 300);
    g.fillRect(60, 500, 420, 240);
    g.fillRect(720, 500, 400, 240);
    g.strokeStyle = '#b9d8ef';
    g.lineWidth = 26;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(0, 760);
    g.quadraticCurveTo(300, 760, 450, 700);
    g.quadraticCurveTo(650, 620, 700, 560);
    g.quadraticCurveTo(760, 500, 900, 520);
    g.quadraticCurveTo(1050, 540, 1200, 520);
    g.stroke();
    g.fillStyle = '#8a8a7a';
    g.font = 'bold 28px sans-serif';
    g.fillText('示例村（演示用）', 470, 48);

    const roads = [
      [{ x: 60, y: 400 }, { x: 1140, y: 400 }],
      [{ x: 300, y: 60 }, { x: 300, y: 740 }],
      [{ x: 700, y: 60 }, { x: 700, y: 740 }],
      [{ x: 300, y: 200 }, { x: 700, y: 200 }],
      [{ x: 300, y: 620 }, { x: 700, y: 620 }]
    ];
    const rnd = mulberry32(20260801);
    const segs = [
      [[60, 400], [1140, 400]], [[300, 60], [300, 740]], [[700, 60], [700, 740]],
      [[300, 200], [700, 200]], [[300, 620], [700, 620]]
    ];
    const households = [];
    for (let n = 0; n < 30; n++) {
      const s = segs[Math.floor(rnd() * segs.length)];
      const t = 0.08 + rnd() * 0.84;
      const px = s[0][0] + (s[1][0] - s[0][0]) * t;
      const py = s[0][1] + (s[1][1] - s[0][1]) * t;
      const dx = s[1][1] - s[0][1], dy = s[0][0] - s[1][0];
      const dl = Math.hypot(dx, dy) || 1;
      const off = (14 + rnd() * 22) * (rnd() < 0.5 ? -1 : 1);
      households.push({
        x: Math.max(10, Math.min(W - 10, px + (dx / dl) * off)),
        y: Math.max(10, Math.min(H - 10, py + (dy / dl) * off))
      });
    }

    state.image = null;
    state.imageDataURL = bg.toDataURL('image/png');
    state.imageW = W;
    state.imageH = H;
    const img = new Image();
    img.onload = () => {
      state.image = img;
      state.roads = roads;
      state.inferredRoadIndexes = [];
      state.households = households;
      state.roadReviewDistance = null;
      state.entrance = { x: 60, y: 400 };
      state.existingBoxes = [];
      state.calibration = { px: 200, meters: 100, p1: { x: 60, y: 400 }, p2: { x: 260, y: 400 } };
      state.mode = 'greenfield';
      state.params = { maxDistance: 100, capacity: 16, poleSpacing: 50 };
      state.results = null;
      state.history = [];
      clearTransientInput();
      $('paramDistance').value = 100;
      $('paramCapacity').value = 16;
      $('paramPole').value = 50;
      $('modeSelect').value = 'greenfield';
      fitView();
      invalidate();
      $('statusBar').textContent = '示例村已载入（30户）。直接点"计算布点"看结果，或先修改参数/加已有箱切换补点模式。';
    };
    img.src = state.imageDataURL;
  }

  /* ---------- 帮助与状态 ---------- */

  const HELP = {
    road: '点击添加路点，双击或点"完成当前路"结束一段路；右键/ESC 取消。路网要沿着村子的路画。',
    house: '在每户位置点一下（一个点=一户）。',
    entrance: '点击光缆进村的位置（一个点）。',
    box: '点击已有分纤箱的位置（有箱补点模式用；可点多个）。',
    calib: '沿地图自带比例尺（或任意已知距离）点两个点，然后输入实际米数。',
    pan: '按住左键拖动平移；滚轮在任何工具下都可缩放。',
    erase: '点击删除最近的误识别户点、整段道路、入口、已有箱或 CAD 参考点；可撤销。'
  };

  function updateHelp() {
    $('helpText').textContent = HELP[state.tool] || '';
  }

  function updateStatus() {
    const calib = state.calibration ? '校准' + state.calibration.meters + 'm' : '未校准';
    const roadAudit = currentHouseholdRoadAudit();
    $('statusBar').textContent =
      '路网 ' + state.roads.length + ' 段 | 户点 ' + state.households.length +
      (state.inferredRoadIndexes.length ? ' | 推断补桥 ' + state.inferredRoadIndexes.length + ' 段' : '') +
      (roadAudit && roadAudit.farIndexes.length ? ' | 离路复核 ' + roadAudit.farIndexes.length + ' 户' : '') +
      ' | 进村点 ' + (state.entrance ? '已标' : '未标') +
      ' | 已有箱 ' + state.existingBoxes.length + ' | ' + calib +
      ' | 模式：' + (state.mode === 'brownfield' ? '有箱补点' : '无箱新建');
  }

  function dist(a, b) { return Math.hypot(b.x - a.x, b.y - a.y); }

  function showModal() { $('calibModal').classList.remove('hidden'); }
  function hideModal() { $('calibModal').classList.add('hidden'); }

  init();
})();
