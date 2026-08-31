/* 本地 DXF 导入器：只解析当前工程需要的 TEXT、MTEXT、LINE、LWPOLYLINE、INSERT */
(function (global) {
  'use strict';

  function toValue(code, value) {
    if (code >= 10 && code <= 59 || code >= 110 && code <= 149 || code >= 210 && code <= 239) {
      return Number(value);
    }
    if (code >= 60 && code <= 99 || code >= 370 && code <= 409) return parseInt(value, 10);
    return value;
  }

  function parsePairs(source) {
    const lines = source.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
    const pairs = [];
    for (let i = 0; i + 1 < lines.length; i += 2) {
      const code = Number(lines[i].trim());
      if (!Number.isFinite(code)) continue;
      pairs.push({ code: code, value: toValue(code, lines[i + 1].trim()) });
    }
    return pairs;
  }

  function parseEntity(pairs, start, end) {
    const first = pairs[start];
    const entity = { type: first.value };
    for (let i = start + 1; i < end; i++) {
      const p = pairs[i];
      if (p.code === 8) entity.layer = String(p.value);
      else if (p.code === 1) entity.text = String(p.value);
      else if (p.code === 2) entity.name = String(p.value);
      else if (p.code === 10) {
        entity.x = p.value;
        if (i + 1 < end && pairs[i + 1].code === 20) entity.y = pairs[i + 1].value;
      } else if (p.code === 11) {
        entity.x2 = p.value;
        if (i + 1 < end && pairs[i + 1].code === 21) entity.y2 = pairs[i + 1].value;
      } else if (p.code === 20 && entity.y == null) entity.y = p.value;
      else if (p.code === 21 && entity.y2 == null) entity.y2 = p.value;
      else if (p.code === 43) entity.width = p.value;
      else if (p.code === 70) entity.flags = p.value;
    }
    if (entity.type === 'LWPOLYLINE') {
      entity.vertices = [];
      for (let i = start + 1; i < end; i++) {
        if (pairs[i].code !== 10) continue;
        const point = { x: pairs[i].value, y: null };
        if (i + 1 < end && pairs[i + 1].code === 20) point.y = pairs[i + 1].value;
        if (point.y != null) entity.vertices.push(point);
      }
    }
    if (entity.type === 'LINE' && [entity.x, entity.y, entity.x2, entity.y2].every(Number.isFinite)) {
      entity.vertices = [{ x: entity.x, y: entity.y }, { x: entity.x2, y: entity.y2 }];
    }
    return entity;
  }

  function parse(source) {
    const pairs = parsePairs(source);
    const entities = [];
    let inEntities = false;
    for (let i = 0; i < pairs.length; i++) {
      if (pairs[i].code === 0 && pairs[i].value === 'SECTION') {
        inEntities = pairs[i + 1] && pairs[i + 1].code === 2 && pairs[i + 1].value === 'ENTITIES';
        continue;
      }
      if (pairs[i].code === 0 && pairs[i].value === 'ENDSEC') {
        inEntities = false;
        continue;
      }
      if (!inEntities || pairs[i].code !== 0 || pairs[i].value === 'EOF') continue;
      let end = i + 1;
      while (end < pairs.length && pairs[end].code !== 0) end++;
      const type = pairs[i].value;
      if (['TEXT', 'MTEXT', 'LINE', 'LWPOLYLINE', 'INSERT'].includes(type)) {
        entities.push(parseEntity(pairs, i, end));
      }
      i = end - 1;
    }
    return { entities: entities };
  }

  global.DxfLite = { parse: parse };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.DxfLite;
})(typeof window !== 'undefined' ? window : globalThis);
