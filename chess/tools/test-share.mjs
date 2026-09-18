#!/usr/bin/env node
/**
 * 分享链接测试。直接跑 Node，不需要浏览器、不需要装依赖。
 *
 * 用法：node chess/tools/test-share.mjs
 *
 * ## 为什么值得单独测
 *
 * 这个模块只有两个函数，但两头都在处理**别人给的输入**：
 *
 *   - 生成链接：输入是当前局面，但 `href` 是浏览器给的、可能带着上一次分享留下的参数
 *   - 读取链接：输入是**任意 URL** —— 别人可以把它改成任何样子
 *
 * 后者尤其危险：它直接决定 `initialFen`。一个没校验住的 FEN
 * 会让对局从一个非法局面开始，而那时候报错的地方离原因已经很远了。
 *
 * ## 钉住「比出题校验松」这条刻意的不一致
 *
 * 出题（把局面收进局面库当练习题）要求**轮走方有合法着法** —— 已经将死 / 逼和的局面
 * 存下来也练不了。而分享是**对局中途**截出来的：你刚好把对方将死那一刻复制了链接，
 * 接收方打开就该看到那个局面。这是**故意**的，但很容易被后来的人当成 bug 顺手「修掉」，
 * 所以这里两边都断言，让不一致变成显式的。
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (name) => import(pathToFileURL(resolve(HERE, '../js/', name)).href);

const S = await load('share.js');
const Pos = await load('position.js');
const Ru = await load('rules.js');

let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  const detail = ok
    ? ''
    : `\n        期望 ${JSON.stringify(expected)}\n        实际 ${JSON.stringify(actual)}`;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail}`);
}

const PAGE = 'https://example.com/chess/';

/** 普通可用局面：白后 + 双王 */
const VALID = '4k3/8/8/8/8/8/8/3QK3 w - - 0 1';

/** 轮走方被将军（他应将就是了）—— 两侧的标准都该接受 */
const IN_CHECK = '4k3/8/8/8/8/8/4r3/R3K3 w - - 0 1';

/** 已经终局：出题要拒绝（没有练习价值），分享要接受（对局中间就可能停在这里） */
const MATE = 'R5k1/5ppp/8/8/8/8/8/6K1 b - - 0 1';      // 将死
const STALE = 'k7/8/1Q6/8/8/8/8/K7 b - - 0 1';           // 逼和

/** 出题侧的标准：不仅局面成立，还要**有练习价值**（轮走方得有合法着法） */
const hasLegalMove = (fen) => Ru.generateLegalMoves(Pos.parseFen(fen)).length > 0;

console.log('分享链接测试\n');

// ============================================================
console.log('=== 生成链接 ===');
{
  const url = S.shareUrl(VALID, PAGE);
  const u = new URL(url);

  check('带上 fen 参数', u.searchParams.get('fen'), VALID);
  check('参数只有 fen 一个', [...u.searchParams.keys()], ['fen']);
  check('原页面路径不变', u.pathname, '/chess/');
  check('链接里没有裸空格', url.includes(' '), false);
  // 空格必须是 %20，不能是 + —— 后者在查询串里的含义取决于解析方
  check('空格编成 %20 而不是 +', url.includes('+'), false);
  check('空格确实被编过', url.includes('%20'), true);

  // 上一次分享留下的参数必须被清掉 —— 否则会带出旧局面的残渣
  const again = S.shareUrl(IN_CHECK, url);
  check('二次分享覆盖掉旧的 fen', new URL(again).searchParams.get('fen'), IN_CHECK);
  check('二次分享后仍只有一个参数', [...new URL(again).searchParams.keys()], ['fen']);

  // 调试用的 ?v= 之类也不该被带出去
  const dirty = S.shareUrl(VALID, 'https://example.com/chess/?v=123#top');
  const d = new URL(dirty);
  check('清掉无关参数', [...d.searchParams.keys()], ['fen']);
  check('清掉 hash', d.hash, '');
}

// ============================================================
console.log('\n=== 往返 ===');
{
  const url = S.shareUrl(VALID, PAGE);
  const r = S.readShareFen(url);
  check('往返后 ok', r.ok, true);
  check('往返后 found', r.found, true);
  check('往返后 FEN 一致', r.fen, VALID);

  // 手工编码（%20）也得能读回来
  check('手工 %20 编码也能读', S.readShareFen(`${PAGE}?fen=${encodeURIComponent(VALID)}`).fen, VALID);
}

// ============================================================
console.log('\n=== 没带参数（正常情况，不是错误）===');
{
  const r = S.readShareFen(PAGE);
  check('found 为 false', r.found, false);
  check('ok 为 false', r.ok, false);
  check('reason 为空 —— 没有错要报', r.reason, '');

  const r2 = S.readShareFen(`${PAGE}?v=123`);
  check('只有别的参数时同样 found=false', r2.found, false);
}

// ============================================================
console.log('\n=== 带了坏参数（必须报出原因）===');
{
  const cases = [
    ['空字符串', `${PAGE}?fen=`, '空的'],
    ['只有空格', `${PAGE}?fen=%20%20`, '空的'],
    ['不是 FEN 的普通文字', `${PAGE}?fen=${encodeURIComponent('你好世界')}`, '解析失败'],
    ['行数不对（只有 7 行）', `${PAGE}?fen=${encodeURIComponent('8/8/8/8/8/8/8 w - - 0 1')}`, '解析失败'],
    ['没有黑王', `${PAGE}?fen=${encodeURIComponent('8/8/8/8/8/8/8/4K3 w - - 0 1')}`, '不合法'],
    ['两个王相邻', `${PAGE}?fen=${encodeURIComponent('8/8/8/8/8/8/1k6/K7 w - - 0 1')}`, '不合法'],
    ['兵停在第八排', `${PAGE}?fen=${encodeURIComponent('P6k/8/8/8/8/8/8/K7 w - - 0 1')}`, '不合法'],
  ];

  for (const [name, url, keyword] of cases) {
    const r = S.readShareFen(url);
    check(`${name} → found=true`, r.found, true);
    check(`${name} → ok=false`, r.ok, false);
    check(`${name} → 原因里有「${keyword}」`, r.reason.includes(keyword), true);
  }
}

// ============================================================
console.log('\n=== 刻意比「出题」松：已经终局的局面也接受 ===');
{
  for (const [name, fen] of [['将死', MATE], ['逼和', STALE]]) {
    check(`该${name}局面确实已经终局（出题侧会拒绝）`, hasLegalMove(fen), false);
    check(`分享校验接受${name}局面`, S.readShareFen(S.shareUrl(fen, PAGE)).ok, true);
    check(`分享校验读回来还是原局面`, S.readShareFen(S.shareUrl(fen, PAGE)).fen, fen);
  }

  // 「轮走方被将军」是合法局面（他应将就是了），两侧都该接受
  check('分享校验接受被将军的局面', S.readShareFen(S.shareUrl(IN_CHECK, PAGE)).ok, true);

  // 两边都该拒绝的东西：局面本身不成立
  const FACEOFF = '4k3/8/8/8/8/8/8/4K3 w - - 0 1'; // 两王照面，中间无子也是合法的？
  // 王之间隔着一条纵线是合法的（国象不像象棋有照面规则），所以换一个真非法的：
  const TWO_KINGS = '4k3/4k3/8/8/8/8/8/4K3 w - - 0 1';
  check('（对照）两王照面在国象里是合法的', S.readShareFen(S.shareUrl(FACEOFF, PAGE)).ok, true);
  check('分享校验拒绝两个黑王', S.readShareFen(S.shareUrl(TWO_KINGS, PAGE)).ok, false);
}

// ============================================================
console.log('\n=== 规范化 ===');
{
  // 尾部字段写乱、多余空白 —— 读回来应当统一成标准写法
  const sloppy = '4k3/8/8/8/8/8/8/3QK3   w   -   -   12   34';
  const r = S.readShareFen(`${PAGE}?fen=${encodeURIComponent(sloppy)}`);
  check('乱写的尾部被规范化', r.fen, '4k3/8/8/8/8/8/8/3QK3 w - - 12 34');

  // 少写后两段也能读（手写的 FEN 常常只有四段）
  const short = '4k3/8/8/8/8/8/8/3QK3 w - -';
  check('只写四段也能读', S.readShareFen(`${PAGE}?fen=${encodeURIComponent(short)}`).fen, VALID);
}

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
