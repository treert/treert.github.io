/**
 * 全站共用的小脚本：深色模式。
 *
 * 必须用普通 <script> 同步加载在 <head> 里（不能加 defer / async，也不能改成 module）——
 * 它要在首次绘制之前把 <html data-theme> 定下来。否则深色模式的用户会先看到
 * 一帧白屏再跳成深色，非常刺眼。
 *
 * 主题优先级：localStorage 里的选择 > 系统偏好。用户没手动切过就跟着系统走。
 */
(function () {
  var KEY = 'site-theme';
  var root = document.documentElement;

  function stored() {
    try {
      var v = localStorage.getItem(KEY);
      return v === 'dark' || v === 'light' ? v : null;
    } catch (e) {
      return null; // 隐私模式下 localStorage 会抛异常
    }
  }

  function systemDark() {
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  function apply(theme) {
    root.setAttribute('data-theme', theme);
  }

  // 先定主题，再管界面
  apply(stored() || (systemDark() ? 'dark' : 'light'));

  function syncButton(btn) {
    var dark = root.getAttribute('data-theme') === 'dark';
    // 显示的是"点下去会变成什么"，不是当前状态
    btn.textContent = dark ? '\u2600\uFE0E' : '\u263E\uFE0E';
    btn.title = dark ? '切换到浅色模式' : '切换到深色模式';
    btn.setAttribute('aria-label', btn.title);
  }

  function toggle() {
    var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    apply(next);
    try {
      localStorage.setItem(KEY, next);
    } catch (e) {
      /* 存不了就算了，这次会话内还是能切 */
    }
    // 画布颜色是 JS 画的，光换 CSS 变量它不会跟着变，得让页面自己重画一遍
    window.dispatchEvent(new CustomEvent('themechange', { detail: { theme: next } }));
  }

  function mount() {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-toggle';
    btn.addEventListener('click', toggle);
    syncButton(btn);
    document.body.appendChild(btn);
    window.addEventListener('themechange', function () {
      syncButton(btn);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
