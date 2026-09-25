// 阅读模式实现：注入脚本 + 回传报告解析
#include "reader.h"

namespace tib {

bool ParseReaderReport(const std::string& json, ReaderReport& out) {
  CefRefPtr<CefValue> value = CefParseJSON(json, JSON_PARSER_RFC);
  CefRefPtr<CefDictionaryValue> dict =
      (value && value->GetType() == VTYPE_DICTIONARY) ? value->GetDictionary() : nullptr;
  if (!dict) return false;
  out.ok = dict->HasKey("ok") && dict->GetBool("ok");
  out.active = dict->HasKey("active") && dict->GetBool("active");
  out.title = dict->HasKey("title") ? dict->GetString("title").ToString() : std::string();
  out.chars = dict->HasKey("chars") ? dict->GetInt("chars") : 0;
  out.paragraphs = dict->HasKey("paragraphs") ? dict->GetInt("paragraphs") : 0;
  out.error = dict->HasKey("error") ? dict->GetString("error").ToString() : std::string();
  return true;
}

std::string ReaderEnterScript() {
  // 说明几处刻意的选择：
  //   * 全部包在 IIFE + try/catch 里：任何异常都只能变成一条报告，不能污染页面；
  //   * 打分时对链接文本量做惩罚 —— 导航栏、推荐位、列表页的"链接密度"远高于正文；
  //   * 类名/ID 里带 nav/footer/comment/ad 等的元素直接扣分或剔除（启发式，够用即可）；
  //   * 覆盖层用 position:fixed + 最高 z-index，不改动原页面结构，退出时整个移除；
  //   * 已有覆盖层时不重复构建，只回一条"当前已激活" —— 保证这个脚本是幂等的。
  return R"JS(
(function () {
  var PREFIX = '__TIB_READER__';
  var ROOT = '__tib_reader_root__';
  function report(o) { try { console.log(PREFIX + JSON.stringify(o)); } catch (e) {} }
  function textLen(el) { return el && el.textContent ? el.textContent.replace(/\s+/g, ' ').trim().length : 0; }
  try {
    var old = document.getElementById(ROOT);
    if (old) {
      report({ ok: true, active: true, title: old.getAttribute('data-title') || document.title,
               chars: Number(old.getAttribute('data-chars') || 0),
               paragraphs: Number(old.getAttribute('data-paras') || 0) });
      return;
    }

    var BAD = /(^|[\s_-])(nav|menu|sidebar|side|comment|footer|header|ad|ads|advert|share|social|related|recommend|promo|banner|popup|modal|breadcrumb|pagination|subscribe|newsletter|widget|meta|cookie|login|signup)([\s_-]|$)/i;

    function linkLen(el) {
      var n = 0, as = el.getElementsByTagName('a');
      for (var i = 0; i < as.length; i++) n += textLen(as[i]);
      return n;
    }
    function score(el) {
      var ps = el.getElementsByTagName('p'), s = 0;
      for (var i = 0; i < ps.length; i++) {
        var t = textLen(ps[i]);
        if (t > 40) s += t;
      }
      if (s === 0) s = textLen(el) * 0.3;
      s -= linkLen(el) * 1.2;
      var cls = (el.className && typeof el.className === 'string') ? el.className : '';
      if (BAD.test(cls) || BAD.test(el.id || '')) s -= 800;
      if (el.tagName === 'ARTICLE' || el.tagName === 'MAIN') s += 150;
      return s;
    }

    var cands = document.querySelectorAll('article, main, [role="main"], .article, .post, .content, #content, div, section');
    var best = null, bestScore = 0;
    for (var i = 0; i < cands.length; i++) {
      var sc = score(cands[i]);
      if (sc > bestScore) { bestScore = sc; best = cands[i]; }
    }
    if (!best || bestScore < 200) {
      report({ ok: false, active: false, error: '这个页面没有可提取的正文（正文过短，或内容都在导航/脚本里）' });
      return;
    }

    var clone = best.cloneNode(true);
    var drop = clone.querySelectorAll('script,style,noscript,iframe,form,button,input,select,textarea,svg,canvas,video,audio,aside,footer,header,nav');
    for (var d = drop.length - 1; d >= 0; d--) { if (drop[d].parentNode) drop[d].parentNode.removeChild(drop[d]); }
    var all = clone.querySelectorAll('*');
    for (var a = 0; a < all.length; a++) {
      var el = all[a];
      var cls2 = (el.className && typeof el.className === 'string') ? el.className : '';
      var id2 = el.id || '';
      var role = el.getAttribute ? (el.getAttribute('role') || '') : '';
      if (BAD.test(cls2) || BAD.test(id2) || /navigation|banner|complementary|contentinfo|search/i.test(role)) {
        if (el.parentNode) el.parentNode.removeChild(el);
      }
    }
    // 过短的段落大多是版权行、按钮文字、图片说明，去掉后正文更干净
    var ps2 = clone.querySelectorAll('p, li');
    for (var p2 = 0; p2 < ps2.length; p2++) {
      var node = ps2[p2];
      if (textLen(node) < 25 && node.getElementsByTagName('img').length === 0 && node.parentNode) {
        node.parentNode.removeChild(node);
      }
    }

    var chars = textLen(clone);
    var paras = clone.querySelectorAll('p').length;
    if (chars < 200) {
      report({ ok: false, active: false, error: '提取到的正文太短（' + chars + ' 字符），已放弃进入阅读模式' });
      return;
    }

    var h1src = document.querySelector('h1');
    var title = (h1src && textLen(h1src) > 4) ? h1src.textContent.replace(/\s+/g, ' ').trim() : (document.title || '');

    var host = document.createElement('div');
    host.id = ROOT;
    host.setAttribute('data-title', document.title || '');
    host.setAttribute('data-chars', String(chars));
    host.setAttribute('data-paras', String(paras));
    host.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483647;' +
      'background:#fbfbfd;color:#1d1d1f;overflow:auto;padding:48px 16px 96px;';
    var art = document.createElement('div');
    art.style.cssText = 'max-width:42rem;margin:0 auto;font:400 19px/1.75 -apple-system,"Segoe UI",' +
      '"Microsoft YaHei",sans-serif;';
    var h1 = document.createElement('h1');
    h1.textContent = title;
    h1.style.cssText = 'font-size:34px;line-height:1.25;margin:0 0 8px;font-weight:600;';
    var meta = document.createElement('div');
    meta.textContent = '阅读模式 · 约 ' + chars + ' 字符 · ' + paras + ' 段 · 按 Esc 或再按一次阅读按钮退出';
    meta.style.cssText = 'color:#6e6e73;font-size:13px;margin-bottom:28px;';
    var body = document.createElement('div');
    body.style.cssText = 'word-break:break-word;';
    while (clone.firstChild) body.appendChild(clone.firstChild);
    var imgs = body.getElementsByTagName('img');
    for (var m = 0; m < imgs.length; m++) imgs[m].style.cssText = 'max-width:100%;height:auto;border-radius:12px;';
    art.appendChild(h1);
    art.appendChild(meta);
    art.appendChild(body);
    host.appendChild(art);

    // 退出能力：Esc 与"再点一次阅读按钮"都走同一个函数，保证两条路径行为一致
    window.__tibReaderExit = function () {
      var el = document.getElementById(ROOT);
      if (el) {
        var prev = el.getAttribute('data-prev-overflow') || '';
        if (el.parentNode) el.parentNode.removeChild(el);
        document.documentElement.style.overflow = prev;
      }
      if (window.__tibReaderKey) {
        document.removeEventListener('keydown', window.__tibReaderKey, true);
        window.__tibReaderKey = null;
      }
      report({ ok: true, active: false });
      return true;
    };
    window.__tibReaderKey = function (e) {
      if (e && (e.key === 'Escape' || e.keyCode === 27)) window.__tibReaderExit();
    };
    document.addEventListener('keydown', window.__tibReaderKey, true);

    host.setAttribute('data-prev-overflow', document.documentElement.style.overflow || '');
    document.documentElement.style.overflow = 'hidden';
    document.body.appendChild(host);

    report({ ok: true, active: true, title: title, chars: chars, paragraphs: paras });
  } catch (e) {
    report({ ok: false, active: false, error: String(e && e.message ? e.message : e) });
  }
})();
)JS";
}

std::string ReaderExitScript() {
  return R"JS(
(function () {
  try {
    if (typeof window.__tibReaderExit === 'function') { window.__tibReaderExit(); return; }
    var el = document.getElementById('__tib_reader_root__');
    if (el) {
      var prev = el.getAttribute('data-prev-overflow') || '';
      if (el.parentNode) el.parentNode.removeChild(el);
      document.documentElement.style.overflow = prev;
    }
    console.log('__TIB_READER__' + JSON.stringify({ ok: true, active: false }));
  } catch (e) {
    console.log('__TIB_READER__' + JSON.stringify({ ok: false, active: false, error: String(e && e.message ? e.message : e) }));
  }
})();
)JS";
}

}  // namespace tib
