/*
 * ClipScript TH — Auto Timeline
 * ตัวช่วยประมาณเวลาพากย์จากข้อความ (ไม่ใช้ AI/API ไม่วิเคราะห์ไฟล์เสียงจริง)
 *
 * ไฟล์นี้มี 2 ส่วน:
 *  1) ฟังก์ชันคำนวณล้วน ๆ (pure) — ทดสอบด้วย Node ได้: tests/autotimeline.test.js
 *  2) createController(deps) — ส่วนติดต่อผู้ใช้ที่ผูกกับ Script Editor เดิมใน index.html
 *
 * ข้อมูลเวลาใช้ฟิลด์เดิมของฉาก (start / end เป็นวินาที) เท่านั้น
 * ระยะเวลา (duration) = end - start ไม่มีการเก็บแยกเพื่อไม่ให้ข้อมูลขัดแย้งกัน
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ClipScriptAutoTimeline = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- ค่าคงที่ ---------- */
  var PRESETS = {
    slow: { label: 'ช้า', cps: 8 },
    normal: { label: 'ปกติ', cps: 11 },
    fast: { label: 'เร็ว', cps: 14 }
  };
  var PRESET_KEYS = ['slow', 'normal', 'fast', 'custom'];
  var LIM = {
    cpsMin: 2, cpsMax: 40,          // ตัวอักษรที่ออกเสียงต่อวินาที (กำหนดเอง)
    defMin: 0.5, defMax: 60,        // ความยาวเริ่มต้นของฉากที่ไม่มีบทพูด
    defDefault: 3,
    minScene: 1,                    // ฉากที่มีบทพูดสั้นที่สุด (วินาที)
    maxTime: 359999,                // เพดานเวลา ป้องกันค่าใหญ่ผิดปกติ
    maxDuration: 3600,
    sentencePause: 0.4,             // หยุดท้ายประโยค
    paragraphPause: 0.6             // หยุดระหว่างย่อหน้า/บรรทัด
  };
  var TARGETS = [15, 30, 45, 60, 90];

  /* ---------- ตัวเลข ---------- */
  function round1(n) { return Math.round(n * 10) / 10; }
  function toNum(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string' && v.trim() === '') return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }
  // เวลาที่ปลอดภัย: จำนวนจำกัด, ไม่ติดลบ, ทศนิยม 1 ตำแหน่ง
  function sanitizeTime(v, fallback) {
    if (fallback === undefined) fallback = 0;
    var n = toNum(v);
    if (n === null || n < 0) return fallback;
    return round1(Math.min(n, LIM.maxTime));
  }
  function fmt(n) { return (isFinite(n) ? n : 0).toFixed(1); }
  function fmtClock(n) {
    n = isFinite(n) && n > 0 ? n : 0;
    var m = Math.floor(n / 60), s = Math.floor(n % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  /* ---------- ตัวตั้งค่า ---------- */
  function validateSettingsInput(raw) {
    var r = raw && typeof raw === 'object' ? raw : {};
    var preset = PRESET_KEYS.indexOf(r.preset) >= 0 ? r.preset : 'normal';
    var cps;
    if (preset === 'custom') {
      cps = toNum(r.cps);
      if (cps === null || cps < LIM.cpsMin || cps > LIM.cpsMax) {
        return { ok: false, error: 'ความเร็วแบบกำหนดเองต้องเป็นตัวเลขระหว่าง ' + LIM.cpsMin + '–' + LIM.cpsMax + ' ตัวอักษรต่อวินาที' };
      }
    } else {
      cps = PRESETS[preset].cps;
    }
    var dd = toNum(r.defaultDuration);
    if (dd === null || dd < LIM.defMin || dd > LIM.defMax) {
      return { ok: false, error: 'ความยาวเริ่มต้นของฉากที่ไม่มีบทพูดต้องเป็นตัวเลขระหว่าง ' + LIM.defMin + '–' + LIM.defMax + ' วินาที' };
    }
    return { ok: true, settings: { preset: preset, cps: cps, defaultDuration: round1(dd) } };
  }
  // ใช้กับข้อมูลที่อ่านจากโปรเจกต์เก่า/นำเข้า: ไม่ throw, ถอยกลับเป็นค่าเริ่มต้น
  function normalizeSettings(raw) {
    var r = raw && typeof raw === 'object' ? raw : {};
    var preset = PRESET_KEYS.indexOf(r.preset) >= 0 ? r.preset : 'normal';
    var cps;
    if (preset === 'custom') {
      var n = toNum(r.cps);
      if (n !== null && n >= LIM.cpsMin && n <= LIM.cpsMax) cps = n;
      else { preset = 'normal'; cps = PRESETS.normal.cps; }
    } else {
      cps = PRESETS[preset].cps;
    }
    var dd = toNum(r.defaultDuration);
    dd = dd !== null && dd >= LIM.defMin && dd <= LIM.defMax ? round1(dd) : LIM.defDefault;
    return { preset: preset, cps: cps, defaultDuration: dd };
  }

  /* ---------- แบ่ง grapheme ---------- */
  var segmenter = null;
  try {
    if (typeof Intl !== 'undefined' && Intl.Segmenter) segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  } catch (e) { segmenter = null; }

  // ตัวต่อท้ายที่ต้องรวมกับตัวก่อนหน้า (ใช้เมื่อไม่มี Intl.Segmenter)
  var EXTEND_RE = /^[\p{M}\u0E33\u200C\u200D\uFE0E\uFE0F\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]$/u;
  var REGIONAL_RE = /^[\u{1F1E6}-\u{1F1FF}]$/u;

  function graphemes(text, forceFallback) {
    var s = text === null || text === undefined ? '' : String(text);
    if (!s) return [];
    if (segmenter && !forceFallback) {
      var out0 = [], it = segmenter.segment(s);
      for (var seg of it) out0.push(seg.segment);
      return out0;
    }
    var out = [];
    for (var ch of s) {
      var last = out.length - 1;
      if (last >= 0) {
        var prev = out[last];
        if (EXTEND_RE.test(ch) || prev.charAt(prev.length - 1) === '\u200D') { out[last] = prev + ch; continue; }
        if (REGIONAL_RE.test(ch) && Array.from(prev).length === 1 && REGIONAL_RE.test(prev)) { out[last] = prev + ch; continue; }
      }
      out.push(ch);
    }
    return out;
  }

  // นับเฉพาะ grapheme ที่ "ออกเสียงได้" (ตัวอักษร/ตัวเลข) — เว้นวรรค เครื่องหมาย และอีโมจิไม่นับ
  var SPOKEN_RE = /^[\p{L}\p{N}]/u;
  function countSpoken(text, forceFallback) {
    var list = graphemes(text, forceFallback), n = 0;
    for (var i = 0; i < list.length; i++) if (SPOKEN_RE.test(list[i])) n++;
    return n;
  }

  var SENTENCE_RE = /[.!?…。！？]+(?=\s|$|["'”’)\]])/gu;
  function countPauses(text) {
    var s = (text === null || text === undefined ? '' : String(text)).replace(/\r\n?/g, '\n');
    var paragraphs = s.split(/\n+/).filter(function (p) { return p.trim() !== ''; }).length;
    var m = s.match(SENTENCE_RE);
    return { sentences: m ? m.length : 0, paragraphBreaks: Math.max(0, paragraphs - 1) };
  }

  /* ---------- ประมาณเวลาจากข้อความ ---------- */
  function estimateText(text, rawSettings, forceFallback) {
    var st = normalizeSettings(rawSettings);
    var s = text === null || text === undefined ? '' : String(text);
    var empty = { hasVoice: false, graphemes: 0, sentences: 0, paragraphBreaks: 0, seconds: 0 };
    if (!s.trim()) return empty;
    var g = countSpoken(s, forceFallback);
    if (g === 0) return empty; // มีแต่เครื่องหมาย/อีโมจิ — ไม่ถือว่ามีบทพูด
    var p = countPauses(s);
    var sec = g / st.cps + p.sentences * LIM.sentencePause + p.paragraphBreaks * LIM.paragraphPause;
    sec = Math.max(LIM.minScene, round1(sec));
    return { hasVoice: true, graphemes: g, sentences: p.sentences, paragraphBreaks: p.paragraphBreaks, seconds: sec };
  }

  /* ---------- จัดลำดับเวลาต่อเนื่อง ---------- */
  // ทำงานเป็นหน่วย 0.1 วินาที (จำนวนเต็ม) เพื่อไม่ให้ทศนิยมคลาดเคลื่อนสะสม
  function sequence(items) {
    var cursor = 0;
    var out = (items || []).map(function (it, i) {
      var d = toNum(it && it.duration);
      if (d === null || d <= 0) d = 0.1;
      d = Math.min(d, LIM.maxDuration);
      var dt = Math.max(1, Math.round(d * 10));
      var res = {};
      for (var k in it) if (Object.prototype.hasOwnProperty.call(it, k)) res[k] = it[k];
      res.index = i;
      res.start = cursor / 10;
      res.end = (cursor + dt) / 10;
      res.duration = dt / 10;
      cursor += dt;
      return res;
    });
    return { items: out, total: cursor / 10 };
  }

  function buildTimeline(scenes, rawSettings, forceFallback) {
    var st = normalizeSettings(rawSettings);
    var list = Array.isArray(scenes) ? scenes : [];
    var items = list.map(function (s, i) {
      var sc = s && typeof s === 'object' ? s : {};
      var est = estimateText(sc.voice, st, forceFallback);
      var item = { section: typeof sc.section === 'string' ? sc.section : '', hasVoice: est.hasVoice, graphemes: est.graphemes };
      if (est.hasVoice) {
        item.duration = est.seconds; item.source = 'estimate';
      } else {
        var a = toNum(sc.start), b = toNum(sc.end);
        if (a !== null && b !== null && a >= 0 && b > a) {
          item.duration = Math.max(0.1, round1(b - a)); item.source = 'kept';
        } else {
          item.duration = st.defaultDuration; item.source = 'default';
        }
      }
      return item;
    });
    return sequence(items);
  }

  // อ่านไทม์ไลน์ปัจจุบันจาก start/end ที่มีอยู่ (ไม่แก้ข้อมูล)
  function readTimeline(scenes) {
    var list = Array.isArray(scenes) ? scenes : [];
    var prevEnd = 0, total = 0, overlaps = 0, invalid = 0;
    var items = list.map(function (s, i) {
      var sc = s && typeof s === 'object' ? s : {};
      var start = sanitizeTime(sc.start, 0), end = sanitizeTime(sc.end, 0);
      var dur = round1(Math.max(0, end - start));
      var isInvalid = end <= start;
      var isOverlap = i > 0 && start < prevEnd - 0.05;
      if (isInvalid) invalid++;
      if (isOverlap) overlaps++;
      prevEnd = end;
      if (end > total) total = end;
      return { index: i, section: typeof sc.section === 'string' ? sc.section : '', start: start, end: end, duration: dur, source: 'current', invalid: isInvalid, overlap: isOverlap };
    });
    return { items: items, total: total, overlaps: overlaps, invalid: invalid };
  }

  function targetStatus(total, target) {
    var t = toNum(target);
    if (t === null || t <= 0) return { state: 'none' };
    var diff = round1(total - t);
    if (total - t > 0.049) return { state: 'over', diff: diff, target: t };
    return { state: 'ok', target: t };
  }

  // สร้างฉากใหม่ที่ใส่เวลาตามตัวอย่าง (ไม่แก้อาเรย์/อ็อบเจกต์เดิม)
  function applyToScenes(scenes, items) {
    if (!Array.isArray(scenes) || !Array.isArray(items) || scenes.length !== items.length) return null;
    return scenes.map(function (s, i) {
      var copy = {};
      for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k)) copy[k] = s[k];
      copy.start = sanitizeTime(items[i].start, 0);
      copy.end = sanitizeTime(items[i].end, 0);
      return copy;
    });
  }

  function signature(scenes, extra) {
    return JSON.stringify([(scenes || []).map(function (s) { return [s.voice || '', Number(s.start) || 0, Number(s.end) || 0]; })]);
  }

  var pure = {
    PRESETS: PRESETS, LIMITS: LIM, TARGETS: TARGETS,
    sanitizeTime: sanitizeTime, formatSeconds: fmt, formatClock: fmtClock,
    validateSettingsInput: validateSettingsInput, normalizeSettings: normalizeSettings,
    graphemes: graphemes, countSpoken: countSpoken, countPauses: countPauses,
    estimateText: estimateText, sequence: sequence, buildTimeline: buildTimeline,
    readTimeline: readTimeline, targetStatus: targetStatus, applyToScenes: applyToScenes,
    signature: signature
  };

  /* ====================================================================
   * ส่วนติดต่อผู้ใช้ — ผูกกับ Script Editor เดิม
   * deps: { findProject(id), getActiveId(), readEditor(), applyEditorData(data),
   *         save(), toast(msg), escapeHtml(s) }
   * ==================================================================== */
  function createController(deps) {
    var esc = deps.escapeHtml;
    var state = { projectId: null, open: false, preview: null, msg: null };
    var refreshTimer = null;

    function $(id) { return document.getElementById(id); }
    function project() { return deps.findProject(deps.getActiveId()); }

    var SOURCE_LABEL = { estimate: 'ประมาณจากบทพูด', kept: 'คงเวลาเดิม', 'default': 'ค่าเริ่มต้น (ไม่มีบทพูด)' };

    function targetOptions(p) {
      var cur = toNum(p && p.targetDuration);
      cur = cur !== null && cur > 0 ? cur : 0;
      var vals = TARGETS.slice();
      if (cur > 0 && vals.indexOf(cur) < 0) { vals.push(cur); vals.sort(function (a, b) { return a - b; }); }
      return '<option value="0"' + (cur === 0 ? ' selected' : '') + '>ไม่กำหนด</option>' +
        vals.map(function (v) { return '<option value="' + v + '"' + (v === cur ? ' selected' : '') + '>' + v + ' วินาที</option>'; }).join('');
    }

    function controlsHtml(p) {
      var st = normalizeSettings(p && p.timelineSettings);
      var speedOpts = ['slow', 'normal', 'fast'].map(function (k) {
        return '<option value="' + k + '"' + (st.preset === k ? ' selected' : '') + '>' + PRESETS[k].label + ' (≈' + PRESETS[k].cps + ' ตัวอักษร/วินาที)</option>';
      }).join('') + '<option value="custom"' + (st.preset === 'custom' ? ' selected' : '') + '>กำหนดเอง</option>';
      return '<div class="at-head"><strong>◷ Auto Timeline</strong>' +
        '<button type="button" class="btn ghost small" data-at-close aria-label="ปิดแผง Auto Timeline">ปิด</button></div>' +
        '<p class="at-note">ระยะเวลาที่คำนวณเป็น <strong>ค่าประมาณ</strong> จากจำนวนตัวอักษรที่ออกเสียงและเครื่องหมายวรรคตอน อาจต่างจากเสียงพากย์จริง ' +
        'ระบบไม่ได้วิเคราะห์ไฟล์เสียง และไฟล์ SRT ที่ส่งออกไม่ได้ซิงก์กับเสียงจริง — ควรปรับเวลาตามเสียงพากย์จริงอีกครั้ง</p>' +
        '<div class="at-controls">' +
        '<div class="field"><label for="atSpeed">ความเร็วในการอ่าน</label><select id="atSpeed">' + speedOpts + '</select></div>' +
        '<div class="field"><label for="atCps">ตัวอักษร/วินาที (กำหนดเอง)</label><input id="atCps" type="number" inputmode="decimal" min="' + LIM.cpsMin + '" max="' + LIM.cpsMax + '" step="0.5" value="' + st.cps + '"' + (st.preset === 'custom' ? '' : ' disabled') + '></div>' +
        '<div class="field"><label for="atDefault">ความยาวฉากที่ไม่มีบทพูด (วินาที)</label><input id="atDefault" type="number" inputmode="decimal" min="' + LIM.defMin + '" max="' + LIM.defMax + '" step="0.5" value="' + st.defaultDuration + '"></div>' +
        '<div class="field"><label for="atTarget">ความยาวเป้าหมาย (เพื่อวางแผน)</label><select id="atTarget">' + targetOptions(p) + '</select></div>' +
        '</div>' +
        '<div class="actions"><button type="button" class="btn primary small" data-at-preview>▶ คำนวณและดูตัวอย่าง</button></div>' +
        '<div id="atResult" class="at-result" aria-live="polite"></div>';
    }

    function targetHtml(total, target) {
      var s = targetStatus(total, target);
      if (s.state === 'over') {
        return '<div class="at-warn" role="note">⚠ ความยาวโดยประมาณ ' + fmt(total) + ' วินาที เกินเป้าหมาย ' + s.target + ' วินาทีอยู่ ' + fmt(s.diff) +
          ' วินาที — ระบบไม่ได้ตัดหรือแก้บทพูดให้ คุณปรับบทหรือเวลาเองได้ (เป้าหมายใช้เพื่อวางแผนเท่านั้น ไม่ใช่เงื่อนไขของแพลตฟอร์ม)</div>';
      }
      if (s.state === 'ok') return '<div class="at-ok">✓ อยู่ภายในเป้าหมาย ' + s.target + ' วินาที (ตามค่าประมาณ)</div>';
      return '<div class="at-hint">ยังไม่ได้เลือกความยาวเป้าหมาย</div>';
    }

    function rowHtml(it, total, opts) {
      var n = it.index + 1;
      var left = total > 0 ? Math.min(100, it.start / total * 100) : 0;
      var width = total > 0 ? it.duration / total * 100 : 0;
      width = Math.max(0.8, Math.min(width, 100 - left));
      var label = 'ฉาก ' + n + ' เริ่ม ' + fmt(it.start) + ' จบ ' + fmt(it.end) + ' ระยะเวลา ' + fmt(it.duration) + ' วินาที';
      var badges = '';
      var src = it.manual ? 'manual' : it.source;
      if (src === 'manual') badges += '<span class="at-chip">ปรับเอง</span>';
      else if (SOURCE_LABEL[src]) badges += '<span class="at-chip">' + SOURCE_LABEL[src] + '</span>';
      if (it.overlap) badges += '<span class="at-chip bad">เวลาซ้อนทับฉากก่อนหน้า</span>';
      if (it.invalid) badges += '<span class="at-chip bad">เวลาจบไม่มากกว่าเวลาเริ่ม</span>';
      var dur = opts.editable
        ? '<label class="at-durlabel">ระยะเวลา <input class="at-dur" type="number" inputmode="decimal" min="0.1" max="' + LIM.maxDuration + '" step="0.1" value="' + fmt(it.duration) + '" data-at-dur="' + it.index + '" aria-label="ระยะเวลาฉาก ' + n + ' (วินาที)"> วินาที</label>'
        : '<strong>' + fmt(it.duration) + ' วินาที</strong>';
      var old = opts.editable ? '<span class="at-old">เดิม ' + fmt(it.oldStart) + '–' + fmt(it.oldEnd) + '</span>' : '';
      return '<li class="at-row"><div class="at-name"><strong>ฉาก ' + n + '</strong> · ' + esc(it.section || 'Scene') + '</div>' +
        '<div class="at-track" role="img" aria-label="' + esc(label) + '"><span class="at-bar src-' + esc(src) + (it.invalid ? ' bad' : '') + '" style="left:' + left.toFixed(2) + '%;width:' + width.toFixed(2) + '%"></span></div>' +
        '<div class="at-times"><span>เริ่ม ' + fmt(it.start) + '</span><span>จบ ' + fmt(it.end) + '</span>' + dur + old + badges + '</div></li>';
    }

    function renderResult() {
      var box = $('atResult');
      if (!box) return;
      var p = project();
      var target = toNum(p && p.targetDuration) || 0;
      var html = '';
      if (state.msg) html += '<div class="at-msg ' + state.msg.type + '">' + esc(state.msg.text) + '</div>';
      var pv = state.preview;
      if (pv) {
        var voiced = pv.items.filter(function (i) { return i.hasVoice; }).length;
        html += '<h3 class="at-sub">ตัวอย่างไทม์ไลน์ใหม่ <span class="at-chip">ยังไม่ได้ใช้</span></h3>' +
          '<div class="at-total">รวมโดยประมาณ <strong>' + fmt(pv.total) + ' วินาที</strong> (' + fmtClock(pv.total) + ' นาที) · ' + pv.items.length + ' ฉาก · มีบทพูด ' + voiced + ' ฉาก</div>' +
          targetHtml(pv.total, target);
        if (pv.stale) html += '<div class="at-msg error">ข้อมูลฉากเปลี่ยนไปหลังสร้างตัวอย่าง กรุณากด “คำนวณและดูตัวอย่าง” ใหม่ก่อนใช้งาน</div>';
        html += '<ol class="at-rows">' + pv.items.map(function (it) { return rowHtml(it, pv.total, { editable: true }); }).join('') + '</ol>' +
          '<p class="at-hint">ตัวอย่างนี้ยังไม่แก้ข้อมูลจนกว่าจะกด “ใช้ไทม์ไลน์นี้” — ปรับระยะเวลาแต่ละฉากได้ในช่อง (ฉากถัดไปจะเลื่อนตามอัตโนมัติ) ถ้าเปลี่ยนความเร็วอ่านให้กดคำนวณใหม่</p>' +
          '<div class="actions"><button type="button" class="btn primary small" data-at-apply' + (pv.stale ? ' disabled' : '') + '>✓ ใช้ไทม์ไลน์นี้</button>' +
          '<button type="button" class="btn small" data-at-cancel>ยกเลิก</button></div>';
      } else {
        var data = deps.readEditor();
        var scenes = data && data.scenes ? data.scenes : [];
        if (!scenes.length) {
          html += '<div class="at-hint">โปรเจกต์นี้ยังไม่มีฉาก เพิ่มฉากและใส่เสียงพากย์ก่อน แล้วกดคำนวณ</div>';
        } else {
          var cur = readTimeline(scenes);
          html += '<h3 class="at-sub">ไทม์ไลน์ปัจจุบัน</h3>' +
            '<div class="at-total">รวม <strong>' + fmt(cur.total) + ' วินาที</strong> (' + fmtClock(cur.total) + ' นาที) · ' + cur.items.length + ' ฉาก</div>' +
            targetHtml(cur.total, target);
          if (cur.overlaps) html += '<div class="at-warn" role="note">⚠ พบ ' + cur.overlaps + ' ฉากที่เวลาซ้อนทับฉากก่อนหน้า (แก้ได้ที่ช่อง เริ่ม/จบ ของฉาก)</div>';
          html += '<ol class="at-rows">' + cur.items.map(function (it) { return rowHtml(it, cur.total, { editable: false }); }).join('') + '</ol>' +
            '<p class="at-hint">แก้เวลาเองได้ที่ช่อง “เริ่ม/จบ (วินาที)” ของแต่ละฉาก ระบบจะไม่เปลี่ยนเวลาเองจนกว่าคุณจะกดคำนวณและใช้ตัวอย่าง</p>';
        }
      }
      box.innerHTML = html;
    }

    function renderPanel() {
      var panel = $('atPanel'), btn = $('atToggle');
      if (!panel) return;
      if (btn) btn.setAttribute('aria-expanded', state.open ? 'true' : 'false');
      if (!state.open) { panel.classList.add('hidden'); panel.innerHTML = ''; return; }
      panel.classList.remove('hidden');
      panel.innerHTML = controlsHtml(project());
      renderResult();
    }

    function readControls() {
      return {
        preset: $('atSpeed') ? $('atSpeed').value : 'normal',
        cps: $('atCps') ? $('atCps').value : '',
        defaultDuration: $('atDefault') ? $('atDefault').value : ''
      };
    }

    function makePreview() {
      var v = validateSettingsInput(readControls());
      if (!v.ok) { state.preview = null; state.msg = { type: 'error', text: v.error }; renderResult(); return; }
      var p = project();
      if (!p) return;
      p.timelineSettings = v.settings; // ตั้งค่าความเร็วอ่านของโปรเจกต์ (ฟิลด์เสริม โปรเจกต์เก่าไม่มีก็ใช้งานได้)
      deps.save();
      var scenes = (deps.readEditor().scenes || []);
      if (!scenes.length) { state.preview = null; state.msg = { type: 'error', text: 'ยังไม่มีฉากให้คำนวณ กรุณาเพิ่มฉากก่อน' }; renderResult(); return; }
      var tl = buildTimeline(scenes, v.settings);
      state.preview = {
        items: tl.items.map(function (it, i) {
          it.oldStart = sanitizeTime(scenes[i].start, 0);
          it.oldEnd = sanitizeTime(scenes[i].end, 0);
          it.manual = false;
          return it;
        }),
        total: tl.total, signature: signature(scenes), stale: false
      };
      var anyVoice = tl.items.some(function (i) { return i.hasVoice; });
      state.msg = anyVoice ? null : { type: 'info', text: 'ไม่พบบทพูดในฉากใดเลย จึงคงระยะเวลาเดิมของฉากที่ใช้ได้ และใช้ค่าเริ่มต้นกับฉากอื่น' };
      renderResult();
    }

    function apply() {
      var pv = state.preview;
      if (!pv) return;
      var data = deps.readEditor();
      if (signature(data.scenes) !== pv.signature) {
        pv.stale = true; state.msg = { type: 'error', text: 'ข้อมูลฉากเปลี่ยนไปหลังสร้างตัวอย่าง กรุณาคำนวณใหม่' }; renderResult(); return;
      }
      var next = applyToScenes(data.scenes, pv.items);
      if (!next) { state.msg = { type: 'error', text: 'ไม่สามารถใช้ไทม์ไลน์ได้ จำนวนฉากไม่ตรงกัน กรุณาคำนวณใหม่' }; state.preview = null; renderResult(); return; }
      data.scenes = next;
      state.preview = null;
      state.msg = { type: 'success', text: 'ใช้ไทม์ไลน์แล้ว (' + next.length + ' ฉาก) — ปรับเวลาเองได้ที่ช่อง เริ่ม/จบ ของแต่ละฉาก ค่านี้เป็นเพียงค่าประมาณ' };
      deps.applyEditorData(data); // บันทึกและวาดตัวแก้ไขใหม่ (เรียก init อีกครั้ง)
      deps.toast('ใช้ไทม์ไลน์แล้ว');
    }

    function onClick(e) {
      var t = e.target;
      if (t.closest('[data-at-close]')) { state.open = false; state.preview = null; state.msg = null; renderPanel(); var b = $('atToggle'); if (b) b.focus(); return; }
      if (t.closest('[data-at-preview]')) { makePreview(); return; }
      if (t.closest('[data-at-apply]')) { apply(); return; }
      if (t.closest('[data-at-cancel]')) { state.preview = null; state.msg = { type: 'info', text: 'ยกเลิกตัวอย่างแล้ว เวลาของฉากไม่มีการเปลี่ยนแปลง' }; renderResult(); return; }
    }

    function onChange(e) {
      var t = e.target;
      if (t.id === 'atSpeed') {
        var cps = $('atCps');
        if (cps) {
          var isCustom = t.value === 'custom';
          cps.disabled = !isCustom;
          if (!isCustom && PRESETS[t.value]) cps.value = PRESETS[t.value].cps;
        }
        return;
      }
      if (t.id === 'atTarget') {
        var p = project();
        if (!p) return;
        var v = toNum(t.value);
        p.targetDuration = v !== null && v > 0 ? v : 0;
        p.updated = Date.now();
        deps.save();
        renderResult();
        return;
      }
      if (t.hasAttribute && t.hasAttribute('data-at-dur') && state.preview) {
        var i = Number(t.getAttribute('data-at-dur'));
        var d = toNum(t.value);
        if (d === null || d <= 0 || d > LIM.maxDuration || !state.preview.items[i]) {
          state.msg = { type: 'error', text: 'ระยะเวลาต้องเป็นตัวเลขมากกว่า 0 และไม่เกิน ' + LIM.maxDuration + ' วินาที' };
          renderResult();
          return;
        }
        state.preview.items[i].duration = d;
        state.preview.items[i].manual = true;
        var re = sequence(state.preview.items);
        state.preview.items = re.items;
        state.preview.total = re.total;
        state.msg = null;
        renderResult();
      }
    }

    function scheduleRefresh() {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(function () {
        if (!state.open) return;
        state.msg = null;
        if (state.preview) state.preview.stale = signature(deps.readEditor().scenes) !== state.preview.signature;
        renderResult();
      }, 400);
    }

    function toggle() {
      state.open = !state.open;
      if (!state.open) { state.preview = null; state.msg = null; }
      renderPanel();
      if (state.open) { var s = $('atSpeed'); if (s) s.focus(); }
    }

    // เรียกทุกครั้งที่ตัวแก้ไขโปรเจกต์ถูกวาดใหม่
    function init(id) {
      if (state.projectId !== id) { state.projectId = id; state.open = false; state.msg = null; }
      state.preview = null; // ตัวอย่างเก่าอาจไม่ตรงกับฉากที่เปลี่ยนไป จึงทิ้งทุกครั้งที่วาดใหม่
      var panel = $('atPanel'), btn = $('atToggle');
      if (!panel) return;
      if (btn) btn.addEventListener('click', toggle);
      panel.addEventListener('click', onClick);
      panel.addEventListener('change', onChange);
      var list = $('sceneList');
      if (list) list.addEventListener('input', scheduleRefresh);
      renderPanel();
    }

    return { init: init };
  }

  pure.createController = createController;
  return pure;
});
