/**
 * 分享链接的编解码。纯逻辑，不碰 DOM、不碰 localStorage。
 *
 * ## 链接里只放 FEN
 *
 * 放的是**局面**，不是「一局棋」。着法历史、挡位、执子方都不带 ——
 * 着法历史会让链接长到没法看，而挡位和执子方是**接收方**的偏好，
 * 不该被分享者覆盖。
 *
 * 所以链接的语义是「来看这个局面」，不是「来看我下的这盘棋」。
 *
 * ## 校验比 custom-endgames.js 松
 *
 * `validateEndgameFen` 会拒绝**已经终局**的局面 —— 那是**出题**的要求
 *（拿它当练习起点没有价值）。
 *
 * 但分享是**对局中途**截出来的：你刚好把对方将死的那一刻复制了链接，
 * 接收方打开就该看到那个局面。所以这里只查 `isLegalPosition`
 * —— 局面本身成不成立，不查「拿它当起点合不合适」。
 */

import { parseFen, toFen } from './position.js';
import { isLegalPosition } from './rules.js';

/** 分享参数名 */
export const SHARE_PARAM = 'fen';

/**
 * 当前局面的分享链接。
 *
 * **先清空已有的查询串与 hash**：那可能是上一次分享留下的 fen（复制完又走了几步、
 * 再复制一次，参数会叠加），也可能是别的调试参数。分享链接应当只带这一个参数。
 *
 * **空格编成 `%20`，不用 `searchParams.set`。** 后者会把空格编成 `+`，
 * 而 `+` 在查询串里是否等于空格**取决于解析方** —— HTML 表单场景下是，
 * 别的地方不一定。FEN 里有 5 个空格，一旦有一处把 `+` 当成字面量，整条 FEN 就废了。
 * `%20` 没有这个歧义。
 *
 * 读回来那边不用改：`searchParams.get` 对 `%20` 和 `+` 都能正确解码。
 */
export function shareUrl(fen, href) {
  const url = new URL(href);
  url.hash = '';
  url.search = '';
  url.search = `?${SHARE_PARAM}=${encodeURIComponent(fen)}`;
  return url.toString();
}

/**
 * 从链接里读出分享的局面。
 *
 * 返回 `{ found, ok, reason, fen }`：
 *
 * | 情况 | found | ok | 说明 |
 * |------|-------|----|------|
 * | 链接里没带 fen 参数 | `false` | `false` | **正常情况**（直接打开页面就是这样），reason 为空 |
 * | 带了但用不了 | `true` | `false` | reason 是要显示给用户的原因 |
 * | 带了且可用 | `true` | `true` | fen 是**规范化后**的，可以直接当起始局面 |
 *
 * 区分 found 和 ok 是为了让调用方知道「要不要报错」——
 * 没带参数不是错误，带了坏参数才是。
 */
export function readShareFen(href) {
  let raw;
  try {
    raw = new URL(href).searchParams.get(SHARE_PARAM);
  } catch {
    return { found: false, ok: false, reason: '链接无法解析', fen: '' };
  }
  if (raw === null) return { found: false, ok: false, reason: '', fen: '' };

  const text = raw.trim();
  if (!text) {
    return { found: true, ok: false, reason: '链接里的 FEN 是空的', fen: '' };
  }

  let pos;
  try {
    pos = parseFen(text);
  } catch (e) {
    return { found: true, ok: false, reason: `链接里的 FEN 解析失败：${e.message}`, fen: '' };
  }

  const legal = isLegalPosition(pos);
  if (!legal.ok) {
    return { found: true, ok: false, reason: `链接里的局面不合法：${legal.reason}`, fen: '' };
  }

  // 规范化：接收方拿到的一定是标准写法，方便和本地局面比对
  return { found: true, ok: true, reason: '', fen: toFen(pos) };
}
