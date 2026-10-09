// ทดสอบตรรกะ Auto Timeline (ไม่ต้องติดตั้งแพ็กเกจ ใช้ Node 18+ ที่มี node:test)
// รัน:  node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const AT = require('../autotimeline.js');

const rep = (ch, n) => ch.repeat(n);
const deepFreeze = (o) => { Object.values(o).forEach(v => { if (v && typeof v === 'object') deepFreeze(v); }); return Object.freeze(o); };

/* ---------- 1–3, 7: ภาษาและ Unicode ---------- */
test('Thai-only: นับกลุ่มอักขระ (สระ/วรรณยุกต์ไม่นับแยก) ทั้งสองเส้นทาง', () => {
  for (const fb of [false, true]) {
    assert.equal(AT.countSpoken('สวัสดี', fb), 4);   // ส วั ส ดี
    assert.equal(AT.countSpoken('น้ำ', fb), 1);      // น + ไม้โท + สระอำ
  }
  const e = AT.estimateText('สวัสดีครับ ยินดีต้อนรับ', {});
  assert.equal(e.hasVoice, true);
  assert.ok(Number.isFinite(e.seconds) && e.seconds >= 1);
});

test('English-only: นับตัวอักษร ไม่นับช่องว่าง/เครื่องหมาย', () => {
  assert.equal(AT.countSpoken('Hello, world!'), 10);
  assert.equal(AT.estimateText(rep('a', 110), { preset: 'normal' }).seconds, 10);
});

test('Mixed Thai/English', () => {
  assert.equal(AT.countSpoken('สวัสดี Hello'), 9);
  assert.equal(AT.countSpoken('สวัสดี Hello', true), 9);
});

test('Unicode combining characters และ emoji ไม่ทำให้พัง', () => {
  assert.equal(AT.countSpoken('e\u0301'), 1);
  assert.equal(AT.countSpoken('e\u0301', true), 1);
  assert.equal(AT.countSpoken('Hi 👨‍👩‍👧‍👦 🇹🇭 👍🏽'), 2);
  assert.equal(AT.countSpoken('Hi 👨‍👩‍👧‍👦 🇹🇭 👍🏽', true), 2);
  // มีแต่อีโมจิ/เครื่องหมาย = ไม่ถือว่ามีบทพูด
  assert.equal(AT.estimateText('😀😀 !!! ...', {}).hasVoice, false);
  // ข้อความแปลก ๆ ไม่ throw
  for (const v of [null, undefined, 0, {}, '\u200d\u200d', '\ufe0f', 'a\u0000b']) {
    assert.doesNotThrow(() => AT.estimateText(v, {}));
  }
});

/* ---------- 4: เครื่องหมายและย่อหน้า ---------- */
test('จังหวะหยุดท้ายประโยคและย่อหน้า', () => {
  const base = rep('a', 110);
  assert.equal(AT.estimateText(base + '.', {}).seconds, 10.4);
  assert.equal(AT.estimateText(base + '... ', {}).seconds, 10.4);           // ... นับเป็นหนึ่งจังหวะ
  assert.equal(AT.estimateText('3.5 ' + rep('a', 108), {}).seconds, 10.0);  // ทศนิยมไม่ใช่ท้ายประโยค
  assert.equal(AT.estimateText(rep('a', 55) + '\n\n' + rep('a', 55), {}).seconds, 10.6);
  assert.equal(AT.estimateText(rep('a', 55) + '\r\n' + rep('a', 55), {}).seconds, 10.6);
});

/* ---------- 5, 6: ฉากเปล่า / โปรเจกต์เปล่า ---------- */
test('empty voiceover: คงเวลาเดิมที่ใช้ได้ ไม่งั้นใช้ค่าเริ่มต้น', () => {
  const tl = AT.buildTimeline([
    { voice: '', start: 2, end: 5 },        // ใช้ได้ -> คงยาว 3.0
    { voice: '   ', start: 5, end: 4 },     // ไม่ถูกต้อง -> ค่าเริ่มต้น
    { start: NaN, end: Infinity }           // ไม่ถูกต้อง -> ค่าเริ่มต้น
  ], { defaultDuration: 2.5 });
  assert.deepEqual(tl.items.map(i => i.source), ['kept', 'default', 'default']);
  assert.deepEqual(tl.items.map(i => i.duration), [3, 2.5, 2.5]);
  assert.equal(tl.total, 8);
});

test('empty project', () => {
  for (const v of [[], undefined, null]) {
    const tl = AT.buildTimeline(v, {});
    assert.deepEqual(tl, { items: [], total: 0 });
  }
  assert.deepEqual(AT.readTimeline([]), { items: [], total: 0, overlaps: 0, invalid: 0 });
});

/* ---------- 8: ต่อเนื่องไม่ซ้อนทับ ---------- */
test('sequential timing: ไม่ซ้อนทับ ไม่ติดลบ ไม่มี NaN', () => {
  const scenes = [
    { voice: 'สวัสดีครับทุกคน วันนี้มีเรื่องเล่า' },
    { voice: '' },
    { voice: 'Hello there. This is a test!' },
    { voice: '😀' }
  ];
  const tl = AT.buildTimeline(scenes, { preset: 'normal' });
  let prevEnd = 0;
  for (const it of tl.items) {
    assert.ok(Number.isFinite(it.start) && Number.isFinite(it.end) && Number.isFinite(it.duration));
    assert.ok(it.duration > 0);
    assert.equal(it.start, prevEnd);
    assert.ok(it.end > it.start);
    prevEnd = it.end;
  }
  assert.equal(tl.total, prevEnd);
});

test('ไม่มีทศนิยมคลาดเคลื่อนสะสม (50 ฉาก x 0.1 วินาที)', () => {
  const items = Array.from({ length: 50 }, () => ({ duration: 0.1 }));
  const r = AT.sequence(items);
  assert.equal(r.total, 5);
  assert.equal(r.items[49].end, 5);
});

/* ---------- 9: เปลี่ยนความเร็ว ---------- */
test('reading speed: ช้า > ปกติ > เร็ว และคำนวณใหม่ได้', () => {
  const scenes = [{ voice: rep('a', 110) }, { voice: rep('ก', 55) }];
  const slow = AT.buildTimeline(scenes, { preset: 'slow' }).total;
  const normal = AT.buildTimeline(scenes, { preset: 'normal' }).total;
  const fast = AT.buildTimeline(scenes, { preset: 'fast' }).total;
  assert.ok(slow > normal && normal > fast, `${slow} ${normal} ${fast}`);
  assert.equal(AT.estimateText(rep('a', 110), { preset: 'slow' }).seconds, 13.8);
  assert.equal(AT.estimateText(rep('a', 110), { preset: 'fast' }).seconds, 7.9);
  assert.equal(AT.estimateText(rep('a', 100), { preset: 'custom', cps: 20 }).seconds, 5);
});

/* ---------- 14: ตรวจอินพุตไม่ถูกต้อง ---------- */
test('invalid input handling', () => {
  for (const bad of ['abc', '', -1, 0, Infinity, NaN, 1000, null]) {
    assert.equal(AT.validateSettingsInput({ preset: 'custom', cps: bad, defaultDuration: 3 }).ok, false, String(bad));
  }
  for (const bad of ['', 'x', -2, 0, Infinity, 1e9]) {
    assert.equal(AT.validateSettingsInput({ preset: 'normal', defaultDuration: bad }).ok, false, String(bad));
  }
  assert.equal(AT.validateSettingsInput({ preset: 'custom', cps: '12.5', defaultDuration: '3' }).ok, true);
  // normalize ไม่ throw และได้ค่าปลอดภัยเสมอ (โปรเจกต์เก่า/ข้อมูลเสีย)
  for (const raw of [undefined, null, 'x', 5, { preset: 'custom', cps: 'zz' }, { preset: 'weird' }]) {
    const s = AT.normalizeSettings(raw);
    assert.ok(Number.isFinite(s.cps) && s.cps > 0 && Number.isFinite(s.defaultDuration) && s.defaultDuration > 0);
  }
  assert.equal(AT.sanitizeTime(NaN), 0);
  assert.equal(AT.sanitizeTime(-5), 0);
  assert.equal(AT.sanitizeTime(Infinity), 0);
  assert.equal(AT.sanitizeTime('abc', 7), 7);
  assert.equal(AT.sanitizeTime(1.2349), 1.2);
  // ระยะเวลาที่แก้เองผิดปกติ ไม่ทำให้ลำดับพัง
  const r = AT.sequence([{ duration: NaN }, { duration: -3 }, { duration: Infinity }, { duration: 2 }]);
  assert.ok(r.items.every(i => i.duration > 0 && Number.isFinite(i.end)));
});

/* ---------- เป้าหมายความยาว ---------- */
test('target length warning (ไม่ตัดบท)', () => {
  assert.equal(AT.targetStatus(40, 0).state, 'none');
  assert.equal(AT.targetStatus(40, 'x').state, 'none');
  assert.equal(AT.targetStatus(30, 30).state, 'ok');
  const over = AT.targetStatus(34.5, 30);
  assert.equal(over.state, 'over');
  assert.equal(over.diff, 4.5);
});

/* ---------- 10, 11: ยกเลิก / ใช้ตัวอย่าง (ระดับข้อมูล) ---------- */
test('preview ไม่แก้ข้อมูลเดิม (cancel = ไม่เกิดอะไรขึ้น)', () => {
  const scenes = deepFreeze([
    { section: 'Hook', voice: rep('a', 22), visual: 'v', onscreen: 'o', sfx: 's', start: 0, end: 4 },
    { section: 'Ctx', voice: '', visual: '', onscreen: '', sfx: '', start: 4, end: 9 }
  ]);
  const before = JSON.stringify(scenes);
  AT.buildTimeline(scenes, {});            // ถ้าแก้ข้อมูล จะ throw เพราะ deepFreeze
  assert.equal(JSON.stringify(scenes), before);
});

test('apply เขียนเวลาตามตัวอย่างและคงฟิลด์อื่น', () => {
  const scenes = deepFreeze([
    { section: 'A', voice: rep('a', 22), visual: 'vis', onscreen: 'on', sfx: 'x', start: 0, end: 4, extra: 'keep' },
    { section: 'B', voice: '', visual: '', onscreen: '', sfx: '', start: 4, end: 9 }
  ]);
  const tl = AT.buildTimeline(scenes, { preset: 'normal' });
  assert.deepEqual(tl.items.map(i => [i.start, i.end]), [[0, 2], [2, 7]]);
  const next = AT.applyToScenes(scenes, tl.items);
  assert.deepEqual(next.map(s => [s.start, s.end]), [[0, 2], [2, 7]]);
  assert.equal(next[0].visual, 'vis');
  assert.equal(next[0].extra, 'keep');
  assert.equal(scenes[0].end, 4);                   // ต้นฉบับไม่ถูกแก้
  assert.equal(AT.applyToScenes(scenes, tl.items.slice(1)), null);
});

test('แก้ระยะเวลาเองในตัวอย่างแล้วฉากถัดไปเลื่อนตาม', () => {
  const tl = AT.buildTimeline([{ voice: rep('a', 22) }, { voice: rep('a', 22) }], {});
  tl.items[0].duration = 5;
  const r = AT.sequence(tl.items);
  assert.deepEqual(r.items.map(i => [i.start, i.end]), [[0, 5], [5, 7]]);
});

test('readTimeline ตรวจเวลาซ้อนทับและไม่ถูกต้อง', () => {
  const r = AT.readTimeline([{ start: 0, end: 5 }, { start: 3, end: 6 }, { start: 6, end: 6 }, { start: 'x', end: -1 }]);
  assert.equal(r.overlaps, 2);   // ฉาก 2 (3<5) และฉาก 4 (0<6)
  assert.equal(r.invalid, 2);    // ฉาก 3 และฉาก 4
  assert.equal(r.total, 6);
});

/* ---------- 12–13 ---------- */
// การบันทึก/โหลด/นำเข้า JSON เก่า/ส่งออก, การแก้ไข-เรียงลำดับฉากเดิม และ layout มือถือ
// ผูกกับ DOM + localStorage ของ index.html จึงไม่ได้ครอบคลุมโดยไฟล์นี้ (ดูรายการทดสอบด้วยมือใน README)
