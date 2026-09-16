/**
 * 采样（determinization）：把一个 `view` 变成一个**完全信息的世界**（design.md §7.2）。
 *
 * 这是 PIMC 的核心一步，也是全模块唯一一处"造出别人的手牌"的地方 ——
 * 而它**不可能作弊**，因为它的输入里在信息论意义上就没有真相：
 * 它只有 `unseenOf(view)`（还没出现过的牌）和各家的剩余张数。
 *
 * 判据（§3.1）：**能从"只看公开牌面的观众视角"推出来的信息，就不是泄漏。**
 *
 * 有一段容易写错的地方（§4.5、future-work 的 B3）：
 *
 *   农民视角下，底牌是公开的但它在地主手里。所以"分给地主的张数"
 *   必须**扣掉那几张已知的底牌** —— 否则分完会发现牌数对不上。
 *
 *   具体地：`unseen.length = 另两家手牌总数 − 我知道且还没被打出的底牌数`。
 *   按各家 `handCount` 直接分会在牌数上无声地错掉（少 3 张），
 *   所以这里在分配前就把地主的份额减掉，并且**用一个断言兜住总量**。
 */

import { sortHand, shuffle } from '../cards.js';
import { unseenOf, playedOf, otherSeats } from '../view.js';

/**
 * 从 view 造一个可能的世界。
 *
 * @returns `{ hands }` —— 三家手牌都齐全（我自己的就是真的，另两家是猜的）
 * @throws 当各家的份额与未见过的牌数对不上（说明状态机或 view 坏了 —— 
 *         这种错必须在测试里炸出来，不能悄悄糊过去，见 test-ai.mjs）
 */
export function sampleWorld(view, rng) {
  const unseen = unseenOf(view);
  const played = new Set(playedOf(view));
  const others = otherSeats(view);

  const shares = others.map((p) => {
    if (p.seat === view.landlord && p.seat !== view.seat) {
      // 地主手里有我知道的底牌（它们不在 unseen 里），所以要少分这么多
      const known = view.trump.filter((c) => !played.has(c)).length;
      return p.handCount - known;
    }
    return p.handCount;
  });

  const total = shares.reduce((a, b) => a + b, 0);
  if (total !== unseen.length) {
    throw new Error(
      `采样分配对不上：另两家需要 ${total} 张，但未见过的牌只有 ${unseen.length} 张`
      + `（座位 ${view.seat}，角色 ${view.role}，底牌 ${view.trump.length}）`,
    );
  }

  const pool = shuffle(unseen, rng);
  const hands = [[], [], []];
  hands[view.seat] = view.myHand.slice();

  let at = 0;
  for (let i = 0; i < others.length; i++) {
    if (shares[i] < 0) {
      throw new Error(`采样份额为负：座位 ${others[i].seat} 要 ${shares[i]} 张`);
    }
    hands[others[i].seat] = sortHand(pool.slice(at, at + shares[i]));
    at += shares[i];
  }

  return { hands };
}
