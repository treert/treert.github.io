#!/usr/bin/env node
/**
 * 找出「CSS 里写了类选择器，但页面上根本没有这个类」的情况。
 *
 * 用法：node conway-life-game/tools/check-css-classes.mjs [站点根目录]
 *
 * 为什么要专门查这个：CSS 选择器匹配不到任何元素时不会报任何错，规则就那么静默失效了。
 * 实测抓到过一处——`.btn-play.is-playing`（播放按钮变红），但 `btn-play` 其实是元素的
 * id 而不是 class，这条规则从写下那天起就没生效过，肉眼和浏览器控制台都看不出来。
 *
 * 局限：只看字面量。用模板字符串拼出来的类名（`pat-${x}`）会被当成"没声明"，
 * 所以真要这么写的话，得往下面的 EXTRA 里补一条白名单。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(process.argv[2] || join(HERE, '..', '..'));

/** 动态拼出来的类名，正则看不出来，列在这儿免得误报 */
const EXTRA = new Set([]);

const SKIP_DIRS = new Set(['node_modules', '.git', '.codebuddy', '.playwright-cli', 'tmp']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(ROOT);
const cssFiles = files.filter((f) => extname(f) === '.css');
const htmlFiles = files.filter((f) => extname(f) === '.html');
const jsFiles = files.filter((f) => extname(f) === '.js' || extname(f) === '.mjs');

// 把注释去掉：注释里的 `.foo` 不是选择器
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

/** CSS 里出现的所有类选择器 */
function selectorsIn(css) {
  const out = new Set();
  for (const m of stripComments(css).matchAll(/\.([a-zA-Z][\w-]*)/g)) out.add(m[1]);
  return out;
}

/** HTML/JS 里实际声明出来的类名 */
function declaredIn(src, isHtml) {
  const out = new Set();
  const add = (s) => {
    for (const c of String(s).trim().split(/\s+/)) if (c) out.add(c);
  };

  // class="a b c"
  for (const m of src.matchAll(/class\s*=\s*["']([^"']*)["']/g)) add(m[1]);
  // className = 'a b'
  for (const m of src.matchAll(/className\s*=\s*["']([^"']*)["']/g)) add(m[1]);
  // classList.add/toggle/remove('a')
  for (const m of src.matchAll(/classList\.(?:add|toggle|remove|contains)\(\s*["']([^"']+)["']/g)) add(m[1]);
  // classList.add('a', 'b')
  for (const m of src.matchAll(/classList\.(?:add|remove)\(([^)]*)\)/g)) {
    for (const q of m[1].matchAll(/["']([^"']+)["']/g)) add(q[1]);
  }
  if (!isHtml) {
    // JS 里拼 HTML 的情况：<div class="a b">
    for (const m of src.matchAll(/class=\\?["']([^"'\\]*)["']/g)) add(m[1]);
  }
  return out;
}

const declared = new Set(EXTRA);
for (const f of [...htmlFiles, ...jsFiles]) {
  for (const c of declaredIn(readFileSync(f, 'utf8'), extname(f) === '.html')) declared.add(c);
}

let bad = 0;
console.log(`扫描 ${relative(process.cwd(), ROOT) || '.'}：${cssFiles.length} 个 CSS，${declared.size} 个已声明的类\n`);

for (const f of cssFiles) {
  const missing = [...selectorsIn(readFileSync(f, 'utf8'))].filter((c) => !declared.has(c)).sort();
  const rel = relative(process.cwd(), f);
  if (!missing.length) {
    console.log(`ok    ${rel}`);
  } else {
    bad += missing.length;
    console.log(`FAIL  ${rel}`);
    for (const c of missing) console.log(`        .${c}  找不到对应的 class`);
  }
}

console.log(bad === 0 ? '\n全部通过' : `\n有 ${bad} 个类选择器匹配不到任何元素`);
process.exitCode = bad === 0 ? 0 : 1;
