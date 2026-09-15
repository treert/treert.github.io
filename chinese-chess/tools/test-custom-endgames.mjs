#!/usr/bin/env node
/**
 * 自定义残局测试。直接跑 Node，不需要浏览器、不需要装依赖。
 *
 * 用法：node chinese-chess/tools/test-custom-endgames.mjs
 *
 * ## 这里测的重点是「输入校验」
 *
 * 用户手粘的 FEN 什么形状都有，而**一条坏数据存进 localStorage 之后会一直留在那里** ——
 * 每次打开局面库都要过一遍，选中它还会把对局带进一个非法局面。
 * 所以入库前的校验必须钉死，而且每条都要断言**失败原因**不是空的
 * （界面要把它显示给用户，说「不行」而不说为什么等于没说）。
 *
 * ## 另外钉住「逐条校验」这条策略
 *
 * 列表里一条坏数据不该连累其他条。这和 persist.js 的「整份丢弃」**正好相反**，
 * 因为那边的语义是「一个对局」（半份对局比没有更难查），
 * 这边是「一个列表」（丢一条总比丢全部好）。理由写在 js/custom-endgames.js 里。
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (name) => import(pathToFileURL(resolve(HERE, '../js/', name)).href);

const C = await load('custom-endgames.js');

let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  const detail = ok
    ? ''
    : `\n        期望 ${JSON.stringify(expected)}\n        实际 ${JSON.stringify(actual)}`;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail}`);
}

// === 假 storage ===

/** 内存版 localStorage，接口与真的一致 */
function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    /** 测试用：直接塞一段原始字符串进去，模拟损坏 / 旧版本的数据 */
    _raw: (k, v) => { map.set(k, v); },
  };
}

/** 配额满的 storage：setItem 抛 */
function fullStorage() {
  const s = fakeStorage();
  return { ...s, setItem: () => { throw new Error('QuotaExceededError'); } };
}

// === 几个现成的 FEN ===

const VALID = '4ka3/9/9/9/9/9/9/9/9/R2K5 w - - 0 1';   // 单车例胜单士
const MATE = '3k5/9/9/9/9/3RR4/9/9/9/4K4 b - - 0 1';    // 将死：轮走方（黑）正被将军
const STALE = '3k5/R8/9/9/9/4R4/9/9/9/4K4 b - - 0 1';   // 困毙：没被将军但一步也走不了
const FACEOFF = '4k4/9/9/9/9/9/9/9/9/4K4 w - - 0 1';    // 将帅照面

// === 校验：能用的局面 ===

{
  const v = C.validateEndgameFen(VALID);
  check('合法 FEN 通过校验', v.ok, true);
  check('通过时返回规范化后的 FEN', v.fen, VALID);

  // 尾部三个字段本模块不使用，一律规范化成 `- - 0 1`
  const messy = C.validateEndgameFen('4ka3/9/9/9/9/9/9/9/9/R2K5 w - - 12 34');
  check('尾部字段被规范化', messy.fen, VALID);

  // 首尾空白 / 多空格也要能吃下（从网页上复制来的经常带）
  const padded = C.validateEndgameFen(`  ${VALID}  `);
  check('容忍首尾空白', padded.ok, true);
}

// === 校验：各类非法输入，每一条都要给出原因 ===

{
  const cases = [
    ['空字符串', ''],
    ['null', null],
    ['undefined', undefined],
    ['不是 FEN 的普通文字', 'not a fen'],
    ['行数不对（只有 9 行）', '4ka3/9/9/9/9/9/9/9/R2K5 w - - 0 1'],
    ['某一行列数不对', '4ka3/9/9/9/9/9/9/9/9/R2K w - - 0 1'],
    ['有无法识别的字符', '4kZa3/9/9/9/9/9/9/9/9/R2K5 w - - 0 1'],
    ['轮走方不是 w/b', '4ka3/9/9/9/9/9/9/9/9/R2K5 x - - 0 1'],
    ['将帅照面', FACEOFF],
    ['轮走方正被将军', MATE],
    ['已经终局（困毙）', STALE],
  ];
  for (const [label, fen] of cases) {
    const v = C.validateEndgameFen(fen);
    check(`拒绝：${label}`, v.ok, false);
    check(`拒绝 ${label} 时给出原因`, typeof v.reason === 'string' && v.reason.length > 0, true);
  }

  // 两条最容易被搞混的：都「下不下去了」，但原因完全不同。
  // 只断言「原因不同」不够 —— 两个都写错成同一句话时也会不同，
  // 所以各自钉住关键词。
  check('被将军的局面报「被将军」', C.validateEndgameFen(MATE).reason.includes('被将军'), true);
  check('已终局的局面报「终局」', C.validateEndgameFen(STALE).reason.includes('终局'), true);
  check('照面的局面报「照面」', C.validateEndgameFen(FACEOFF).reason.includes('照面'), true);
}

// === 增删查 ===

{
  const st = fakeStorage();
  check('空 storage 读出空列表', C.loadCustom(st), []);

  const r = C.addCustom(st, { name: '我的残局', fen: VALID });
  check('新增成功', r.ok, true);
  check('返回的条目带 id', typeof r.entry.id === 'string' && r.entry.id.length > 0, true);
  check('id 有 custom- 前缀', r.entry.id.startsWith('custom-'), true);
  check('分类是 custom', r.entry.category, C.CUSTOM_CATEGORY);
  check('标了 custom 标记', r.entry.custom, true);
  check('结论为空（自定义局面不编造胜负）', r.entry.result, null);
  check('难度为空', r.entry.difficulty, null);

  const list = C.loadCustom(st);
  check('读回来一条', list.length, 1);
  check('名字对得上', list[0].name, '我的残局');
  check('FEN 对得上', list[0].fen, VALID);
  check('id 对得上', list[0].id, r.entry.id);

  // 名字前后空白要去掉
  const r2 = C.addCustom(st, { name: '  带空白的名字  ', fen: STALE.replace(' b ', ' w ') });
  check('名字去掉首尾空白', r2.ok ? r2.entry.name : null, '带空白的名字');

  // 删
  check('删除成功', C.removeCustom(st, r.entry.id), true);
  check('删完只剩一条', C.loadCustom(st).length, 1);
  check('删不存在的 id 返回 false', C.removeCustom(st, 'no-such-id'), false);
}

// === 新增时的拒绝路径 ===

{
  const st = fakeStorage();

  const noName = C.addCustom(st, { name: '', fen: VALID });
  check('拒绝空名字', noName.ok, false);
  check('空名字给出原因', typeof noName.reason === 'string' && noName.reason.length > 0, true);

  const blankName = C.addCustom(st, { name: '   ', fen: VALID });
  check('拒绝纯空白名字', blankName.ok, false);

  const longName = C.addCustom(st, { name: 'x'.repeat(41), fen: VALID });
  check('拒绝超长名字', longName.ok, false);

  const badFen = C.addCustom(st, { name: '好的名字', fen: FACEOFF });
  check('拒绝非法局面', badFen.ok, false);
  check('非法局面把原因带出来', badFen.reason.includes('照面'), true);

  check('被拒绝的都没写进去', C.loadCustom(st), []);

  // 重复局面
  check('第一次存成功', C.addCustom(st, { name: '甲', fen: VALID }).ok, true);
  const dup = C.addCustom(st, { name: '乙', fen: VALID });
  check('拒绝重复局面', dup.ok, false);
  check('重复时提示已经存过', dup.reason.includes('甲'), true);
  check('重复的没写进去', C.loadCustom(st).length, 1);
}

// === 损坏数据 ===

{
  const st = fakeStorage();
  st._raw(C.CUSTOM_KEY, '{{{ 不是 JSON');
  check('JSON 损坏时读出空列表而不是抛', C.loadCustom(st), []);

  const st2 = fakeStorage();
  st2._raw(C.CUSTOM_KEY, JSON.stringify({ v: 999, items: [{ id: 'a', name: 'a', fen: VALID }] }));
  check('版本不匹配时读出空列表', C.loadCustom(st2), []);

  const st3 = fakeStorage();
  st3._raw(C.CUSTOM_KEY, JSON.stringify({ v: C.VERSION, items: 'not an array' }));
  check('items 不是数组时读出空列表', C.loadCustom(st3), []);

  // 逐条校验：坏的那条丢掉，好的留下
  const good = { id: 'good-1', name: '好的', fen: VALID, source: '自定义局面' };
  const badFen = { id: 'bad-1', name: '局面非法', fen: FACEOFF, source: '自定义局面' };
  const noId = { name: '没 id', fen: VALID };
  const st4 = fakeStorage();
  st4._raw(C.CUSTOM_KEY, JSON.stringify({
    v: C.VERSION,
    items: [good, badFen, noId, null, 'string'],
  }));
  const kept = C.loadCustom(st4);
  check('逐条校验：只留下好的那条', kept.length, 1);
  check('逐条校验：留下的是对的那条', kept[0].id, 'good-1');
  check('读回来的条目也带 custom 标记', kept[0].custom, true);
  check('读回来的条目结论也是空', kept[0].result, null);
}

// === storage 不可用 / 写失败 ===

{
  check('storage 为 null 时读出空列表', C.loadCustom(null), []);
  check('storage 为 null 时新增失败但不抛', C.addCustom(null, { name: 'x', fen: VALID }).ok, false);
  check('storage 为 null 时删除返回 false', C.removeCustom(null, 'x'), false);

  const full = fullStorage();
  const r = C.addCustom(full, { name: '配额满了', fen: VALID });
  check('配额满时新增失败但不抛', r.ok, false);
  check('配额满时给出原因', typeof r.reason === 'string' && r.reason.length > 0, true);
}

// === id 唯一性 ===

{
  const { CELLS, K, R } = await load('config.js');
  const { toFen, indexOf } = await load('position.js');

  // 造一批互不相同的合法局面：黑将在 (3,0)、红帅在 (4,9)，红车换位置。
  //
  // 两个坑：
  //   - 红车不能放在纵线 3 上 —— 那会直接将军黑将，
  //     而 isLegalPosition 要求「非轮走方不被将军」（这里是红先，非轮走方就是黑）
  //   - 两将必须不同纵线，否则照面
  const fens = [];
  for (let y = 3; y <= 7; y++) {
    for (let x = 0; x <= 8; x++) {
      if (x === 3) continue;
      const cells = new Int8Array(CELLS);
      cells[indexOf(3, 0)] = -K;
      cells[indexOf(4, 9)] = K;
      cells[indexOf(x, y)] = R;
      fens.push(toFen({ cells, side: 1 }));
    }
  }
  check('构造出的局面互不相同', new Set(fens).size, fens.length);

  const st = fakeStorage();
  const ids = new Set();
  let added = 0;
  for (const fen of fens) {
    // 同一次 tick 里连存多条 —— 如果 id 只用时间戳就会撞
    const r = C.addCustom(st, { name: `局面 ${added}`, fen });
    if (r.ok) { ids.add(r.entry.id); added++; }
  }
  check('确实存进去了多条', added, fens.length);
  check('连存多条时 id 不重复', ids.size, added);
}

// === 收尾 ===

console.log('');
console.log(failed === 0 ? `全部通过` : `${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
