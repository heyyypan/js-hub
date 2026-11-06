/*
 * 腾讯视频 App 去广告 —— i.video.qq.com tRPC/protobuf 响应改写
 *
 * 适用：腾讯视频 iOS 客户端（抓包版本 9.04.75）
 * 用法：Loon 插件里以 http-response 脚本调用（需 requires-body=true, binary-body-mode=true）
 *   http-response ^https:\/\/i\.video\.qq\.com\/$ script-path=<本文件URL>, requires-body=true,
 *                 binary-body-mode=true, argument=[{hideShortDrama},{hideGoods}], tag=...
 *
 * 处理内容（均按响应内容自动识别，没有命中广告结构就原样放行）：
 *   1. 首页/频道页 getMVLPage：删除 _ad_ 类卡片/模块（轮播图广告、中间横幅大图广告），
 *      并删除顶层 InnerAdPromotionEventList（首页下拉刷新顶部横幅）
 *   2. 个人中心 MVLPersonalService：删除 user_center_ad_middle 等广告占位模块
 *   3. GetPersonalCenterAdData：删除个人中心顶部/中间广告数据
 *   4. GetFloatActivity：删除「免费看」悬浮挂件及弹窗数据
 *   5. GetRecentGameSlip：清空首页顶部游戏推荐卡片
 *   6. 底部导航 GetTabListRsp：可选删除「短剧」/「好物」按钮（argument: hideShortDrama, hideGoods）
 *
 * 帧格式：tRPC 帧 = 16 字节帧头(魔数 0x0930, 总长, 头长) + 头部 protobuf + 包体 protobuf
 */

'use strict';

// ───────────────────────── 参数 ─────────────────────────
// hideShortDrama：屏蔽底部「短剧」按钮（默认 false，实验性）
// hideGoods     ：屏蔽底部「好物」按钮（默认 false）
function parseArgs(raw) {
  const out = { hideShortDrama: false, hideGoods: false };
  const toBool = (v) => !(v === false || /^\s*"?(false|0|off)"?\s*$/i.test(String(v)));
  if (raw == null) return out;
  if (typeof raw === 'object') {
    if (raw.hideShortDrama !== undefined) out.hideShortDrama = toBool(raw.hideShortDrama);
    if (raw.hideGoods !== undefined) out.hideGoods = toBool(raw.hideGoods);
    return out;
  }
  const str = String(raw);
  for (const k of ['hideShortDrama', 'hideGoods']) {
    const m = str.match(new RegExp(k + '\\s*[=:]\\s*"?(true|false)"?', 'i'));
    if (m) out[k] = toBool(m[1]);
  }
  return out;
}

// ───────────────────────── 字节工具 ─────────────────────────
function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function ascii(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return s;
}

function asciiBytes(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

// 在 b 中查找 ASCII 子串（朴素搜索，足够快）
function hasAscii(b, needle) {
  const n = asciiBytes(needle);
  const first = n[0];
  const last = b.length - n.length;
  outer: for (let i = 0; i <= last; i++) {
    if (b[i] !== first) continue;
    for (let j = 1; j < n.length; j++) if (b[i + j] !== n[j]) continue outer;
    return true;
  }
  return false;
}

// ───────────────────────── protobuf 工具（无 schema） ─────────────────────────
function readVarint(b, p) {
  let r = 0, m = 1;
  for (let i = 0; i < 10; i++) {
    if (p >= b.length) throw new Error('varint eof');
    const c = b[p++];
    r += (c & 0x7f) * m;
    if (!(c & 0x80)) return [r, p];
    m *= 128;
  }
  throw new Error('varint too long');
}

function encVarint(n) {
  const a = [];
  while (n >= 128) { a.push((n % 128) | 0x80); n = Math.floor(n / 128); }
  a.push(n);
  return Uint8Array.from(a);
}

function encLen(f, payload) {
  return concat([encVarint(f * 8 + 2), encVarint(payload.length), payload]);
}

// 解析一层消息 → [{f, w, s, e, ps, pe}]；s/e = 整条记录范围，ps/pe = LEN 负载范围
function parseMsg(b) {
  const ents = [];
  let p = 0;
  while (p < b.length) {
    const s = p;
    let k;
    [k, p] = readVarint(b, p);
    const f = Math.floor(k / 8), w = k % 8;
    if (f === 0) throw new Error('field 0');
    let ps = -1, pe = -1;
    if (w === 0) { [, p] = readVarint(b, p); }
    else if (w === 1) { p += 8; }
    else if (w === 5) { p += 4; }
    else if (w === 2) {
      let l;
      [l, p] = readVarint(b, p);
      ps = p; pe = p + l; p = pe;
    } else throw new Error('bad wire type ' + w);
    if (p > b.length) throw new Error('overrun');
    ents.push({ f, w, s, e: p, ps, pe });
  }
  return ents;
}

/**
 * 逐条编辑一层消息。回调 fn(ent, payload|null) 的返回值：
 *   undefined → 保持原样   null → 删除该条
 *   Uint8Array → 用它替换 LEN 负载（字段号不变）   {raw: Uint8Array} → 整条原样替换
 * 没有任何改动时返回原对象（可用 === 判断是否变化）。
 */
function editMsg(b, fn) {
  const ents = parseMsg(b);
  const parts = [];
  let changed = false;
  for (const e of ents) {
    const payload = e.w === 2 ? b.subarray(e.ps, e.pe) : null;
    const r = fn(e, payload);
    // 回调原样返回负载（内层没有改动）也视为保持原样
    if (r === undefined || (payload !== null && r === payload)) parts.push(b.subarray(e.s, e.e));
    else if (r === null) changed = true;
    else if (r instanceof Uint8Array) { changed = true; parts.push(encLen(e.f, r)); }
    else { changed = true; parts.push(r.raw); }
  }
  return changed ? concat(parts) : b;
}

// 取某条记录里第一个 LEN 字段 f 的 ASCII 内容（card/module 的 id=1，type=2）
function strField(b, f) {
  for (const e of parseMsg(b)) if (e.f === f && e.w === 2) return ascii(b.subarray(e.ps, e.pe));
  return '';
}

// google.protobuf.Any 的 type_url 末段（Any = {1: type_url, 2: value}）
function anyTypeOf(b) {
  const t = strField(b, 1);
  return t.slice(t.lastIndexOf('.') + 1);
}

// ───────────────────────── 广告判定 ─────────────────────────
// 卡片/模块类型里含独立的 "ad" 词，如 _ad_insert_mix_block、user_center_ad_middle
const isAdType = (t) => /(^|_)ad(_|$)/.test(t);

// 顶层 Any 里的广告类型：AdFeedInfo / AdFeedImagePoster / InnerAdCommonPromotion... 等
const AD_ANY_MARKERS = ['protocol.pb.Ad', 'protocol.pb.InnerAd'];
const hasAdAny = (b) => AD_ANY_MARKERS.some((m) => hasAscii(b, m));

// ───────────────────────── MVL 版面（首页/频道/个人中心） ─────────────────────────
function editCards(p4) {
  // module.f4 = { 1: idx, 2: { 1: card, 1: card ... } }
  return editMsg(p4, (e, p) => {
    if (e.f !== 2 || e.w !== 2) return undefined;
    return editMsg(p, (e2, p2) => {
      if (e2.f !== 1 || e2.w !== 2) return undefined;
      return isAdType(strField(p2, 2)) ? null : undefined;
    });
  });
}

function editModule(pm) {
  const type = strField(pm, 2);
  if (isAdType(type)) return null;
  // 信息流中间插入的横幅大图广告：没有 id/type，只有一个 field 10，里面是 AdFeedInfo
  if (type === '' && hasAdAny(pm)) return null;
  return editMsg(pm, (e, p) => (e.f === 4 && e.w === 2 ? editCards(p) : undefined));
}

// body.f1 = section { 1: name, 2: { 1: module ... } }
function editSections(body, onModule) {
  return editMsg(body, (e, p) => {
    if (e.f !== 1 || e.w !== 2) return undefined;
    return editMsg(p, (e2, p2) => {
      if (e2.f !== 2 || e2.w !== 2) return undefined;
      return editMsg(p2, (e3, p3) => (e3.f === 1 && e3.w === 2 ? onModule(p3) : undefined));
    });
  });
}

// 顶层 field 8：附加信息 Any 列表，删掉首页下拉刷新的广告横幅
function editExtraInfo(body) {
  return editMsg(body, (e, p) => {
    if (e.f !== 8 || e.w !== 2) return undefined;
    return editMsg(p, (e2, p2) => {
      if (e2.f !== 1 || e2.w !== 2) return undefined;
      // entry = { 1: id, 2: Any }
      for (const x of parseMsg(p2)) {
        if (x.f === 2 && x.w === 2 && anyTypeOf(p2.subarray(x.ps, x.pe)) === 'InnerAdPromotionEventList') return null;
      }
      return undefined;
    });
  });
}

// ───────────────────────── 底部导航：删除指定 tab ─────────────────────────
// tab.f22 内含入口标识：短剧 smallvideo_entrance，好物 goods_entrance
function editTabList(rsp, markers) {
  // GetTabListRsp = { 1: tab ... }；tab.f2 = 位置序号
  const ents = parseMsg(rsp);
  const tabs = ents.filter((e) => e.f === 1 && e.w === 2);
  const hidden = (t) => markers.some((m) => hasAscii(t, m));
  if (!tabs.some((e) => hidden(rsp.subarray(e.ps, e.pe)))) return rsp;

  const parts = [];
  let idx = 0;
  for (const e of ents) {
    if (!(e.f === 1 && e.w === 2)) { parts.push(rsp.subarray(e.s, e.e)); continue; }
    const t = rsp.subarray(e.ps, e.pe);
    if (hidden(t)) continue;
    const myIdx = idx++;
    // 其余 tab 的位置序号重新连续编号（首页本来就没有 f2，序号 0 为默认值）
    const nt = editMsg(t, (x) => (x.f === 2 && x.w === 0 ? { raw: concat([encVarint(16), encVarint(myIdx)]) } : undefined));
    parts.push(encLen(1, nt));
  }
  return concat(parts);
}

function editNav(body, markers) {
  // body.f1.f2.f1(module).f15 = Any{1:type_url, 2: GetTabListRsp}
  return editSections(body, (pm) =>
    editMsg(pm, (e, p) => {
      if (e.f !== 15 || e.w !== 2) return undefined;
      if (anyTypeOf(p) !== 'GetTabListRsp') return undefined;
      return editMsg(p, (e2, p2) => (e2.f === 2 && e2.w === 2 ? editTabList(p2, markers) : undefined));
    })
  );
}

// ───────────────────────── 其他独立接口 ─────────────────────────
// 「免费看」奖励挂件（GetFollowHeartRewardAdInfo）：f2 内含 follow-heart 活动页地址 / 奖励广告素材
// 两个特征同时出现才算（单独的 follow-heart 链接也会出现在 CheckUrl 网址校验响应里，不能误删）
const isFollowHeart = (b) => hasAscii(b, 'follow-heart/center.html') && hasAscii(b, 'ad_client/rewarded_ad');

// 个人中心广告 / 悬浮挂件 / 免费看挂件：顶层 f2、f3 里挂着广告数据，整条删除
function dropTopAdFields(body) {
  return editMsg(body, (e, p) => {
    if ((e.f === 2 || e.f === 3) && e.w === 2 && (hasAdAny(p) || isFollowHeart(p))) return null;
    return undefined;
  });
}

// 首页顶部游戏推荐：{2:"success", 3:{..."games"..}, 4:..} → 只保留 f2
function editGameSlip(body) {
  const ents = parseMsg(body);
  const ok = ents.some((e) => e.f === 2 && e.w === 2 && ascii(body.subarray(e.ps, e.pe)) === 'success');
  const games = ents.some((e) => e.f === 3 && e.w === 2 && strField(body.subarray(e.ps, e.pe), 2) === 'games');
  if (!ok || !games) return body;
  return editMsg(body, (e) => (e.f === 2 ? undefined : null));
}

// 判断是不是 MVL 版面：body.f1 = { 1: "normal"(版块名), 2: {...} }
function looksLikeMvl(body) {
  for (const e of parseMsg(body)) {
    if (e.f === 1 && e.w === 2) {
      const sec = body.subarray(e.ps, e.pe);
      const ents = parseMsg(sec);
      return ents.length >= 2 && ents[0].f === 1 && ents[0].w === 2 && ents[1].f === 2 && ents[1].w === 2;
    }
  }
  return false;
}

// ───────────────────────── gzip 兜底解压（Loon 一般已自动解压） ─────────────────────────
const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function huff(lengths) {
  const count = new Uint16Array(16), symbol = new Uint16Array(lengths.length);
  for (let i = 0; i < lengths.length; i++) count[lengths[i]]++;
  const offs = new Uint16Array(16);
  for (let l = 1; l < 15; l++) offs[l + 1] = offs[l] + count[l];
  for (let i = 0; i < lengths.length; i++) if (lengths[i]) symbol[offs[lengths[i]]++] = i;
  return { count, symbol };
}

function inflateRaw(src, pos) {
  let bitbuf = 0, bitcnt = 0;
  let out = new Uint8Array(Math.max(1024, src.length * 4)), op = 0;
  const bits = (n) => {
    while (bitcnt < n) {
      if (pos >= src.length) throw new Error('inflate eof');
      bitbuf |= src[pos++] << bitcnt; bitcnt += 8;
    }
    const v = bitbuf & ((1 << n) - 1);
    bitbuf >>>= n; bitcnt -= n;
    return v;
  };
  const decode = (h) => {
    let code = 0, first = 0, index = 0;
    for (let l = 1; l <= 15; l++) {
      code |= bits(1);
      const c = h.count[l];
      if (code - c < first) return h.symbol[index + (code - first)];
      index += c; first += c; first <<= 1; code <<= 1;
    }
    throw new Error('bad huffman code');
  };
  const put = (v) => {
    if (op >= out.length) { const n = new Uint8Array(out.length * 2); n.set(out); out = n; }
    out[op++] = v;
  };
  let fixedL = null, fixedD = null;
  let last;
  do {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      bitbuf = 0; bitcnt = 0;
      const len = src[pos] | (src[pos + 1] << 8);
      pos += 4;
      for (let i = 0; i < len; i++) put(src[pos++]);
    } else if (type === 1 || type === 2) {
      let hl, hd;
      if (type === 1) {
        if (!fixedL) {
          const l = new Uint8Array(288);
          for (let i = 0; i < 144; i++) l[i] = 8;
          for (let i = 144; i < 256; i++) l[i] = 9;
          for (let i = 256; i < 280; i++) l[i] = 7;
          for (let i = 280; i < 288; i++) l[i] = 8;
          fixedL = huff(l);
          fixedD = huff(new Uint8Array(30).fill(5));
        }
        hl = fixedL; hd = fixedD;
      } else {
        const nlen = bits(5) + 257, ndist = bits(5) + 1, ncode = bits(4) + 4;
        const cl = new Uint8Array(19);
        for (let i = 0; i < ncode; i++) cl[CLORDER[i]] = bits(3);
        const hc = huff(cl);
        const lens = new Uint8Array(nlen + ndist);
        let i = 0;
        while (i < nlen + ndist) {
          const sym = decode(hc);
          if (sym < 16) lens[i++] = sym;
          else {
            let prev = 0, rep;
            if (sym === 16) { prev = lens[i - 1]; rep = 3 + bits(2); }
            else if (sym === 17) rep = 3 + bits(3);
            else rep = 11 + bits(7);
            while (rep--) lens[i++] = prev;
          }
        }
        hl = huff(lens.subarray(0, nlen));
        hd = huff(lens.subarray(nlen));
      }
      for (;;) {
        const sym = decode(hl);
        if (sym < 256) put(sym);
        else if (sym === 256) break;
        else {
          const li = sym - 257;
          const len = LBASE[li] + bits(LEXT[li]);
          const di = decode(hd);
          const dist = DBASE[di] + bits(DEXT[di]);
          for (let k = 0; k < len; k++) put(out[op - dist]);
        }
      }
    } else throw new Error('bad block type');
  } while (!last);
  return out.subarray(0, op);
}

function gunzip(b) {
  let p = 10;
  const flg = b[3];
  if (flg & 4) p += 2 + (b[p] | (b[p + 1] << 8));
  if (flg & 8) { while (b[p++] !== 0); }
  if (flg & 16) { while (b[p++] !== 0); }
  if (flg & 2) p += 2;
  return inflateRaw(b, p);
}

// ───────────────────────── 主逻辑 ─────────────────────────
// 输入：响应体字节（可能是 gzip）；输出：{ body } 或 null（无需改动）
// 非 protobuf / 解析失败的响应（i.video.qq.com 上还有很多无关接口）一律原样放行
function transform(raw, args) {
  try {
    return transformUnsafe(raw, args);
  } catch (e) {
    return null;
  }
}

function transformUnsafe(raw, args) {
  let b = raw;
  if (b.length > 2 && b[0] === 0x1f && b[1] === 0x8b) b = gunzip(b);

  // tRPC 帧：magic(2)=0x0930 | type(1) | stream_type(1) | total(4) | hdr_len(2) | stream_id(4) | rsv(2)
  if (b.length < 16 || b[0] !== 0x09 || b[1] !== 0x30) return null;
  const total = ((b[4] << 24) | (b[5] << 16) | (b[6] << 8) | b[7]) >>> 0;
  const hdrLen = (b[8] << 8) | b[9];
  if (total !== b.length || 16 + hdrLen > b.length) return null;

  const frameHead = b.subarray(0, 16);
  const header = b.subarray(16, 16 + hdrLen);
  const body = b.subarray(16 + hdrLen);
  if (body.length === 0) return null;

  let nb = body;
  if (looksLikeMvl(nb)) {
    nb = editSections(nb, editModule);          // 删除广告卡片 / 广告模块
    nb = editExtraInfo(nb);                     // 删除下拉刷新广告横幅
    const markers = [];
    if (args.hideShortDrama) markers.push('smallvideo_entrance');
    if (args.hideGoods) markers.push('goods_entrance');
    if (markers.length && hasAscii(nb, 'GetTabListRsp')) nb = editNav(nb, markers);
  } else {
    nb = dropTopAdFields(nb);                   // 个人中心广告 / 免费看挂件
    nb = editGameSlip(nb);                      // 首页顶部游戏推荐
  }
  if (nb === body) return null;

  // 重新封帧：只需改 total（头部不变）
  const out = concat([frameHead, header, nb]);
  const t = out.length;
  out[4] = (t >>> 24) & 0xff; out[5] = (t >>> 16) & 0xff; out[6] = (t >>> 8) & 0xff; out[7] = t & 0xff;
  return { body: out };
}

// ───────────────────────── Loon 入口 ─────────────────────────
if (typeof $response !== 'undefined' && typeof $done === 'function') {
  try {
    const raw = $response.body;
    if (!(raw instanceof Uint8Array) || raw.length === 0) {
      $done({});
    } else {
      const r = transform(raw, parseArgs(typeof $argument !== 'undefined' ? $argument : null));
      if (!r) {
        $done({});
      } else {
        // body 已是解压后的明文，去掉 content-encoding / content-length，由 Loon 重新计算
        const headers = {};
        for (const k of Object.keys($response.headers || {})) {
          const lk = k.toLowerCase();
          if (lk === 'content-encoding' || lk === 'content-length') continue;
          headers[k] = $response.headers[k];
        }
        $done({ status: $response.status, headers, body: r.body });
      }
    }
  } catch (e) {
    console.log('[txvideo-adblock] ' + e);
    $done({});
  }
}

if (typeof module !== 'undefined') module.exports = { transform, transformUnsafe, parseArgs, gunzip, parseMsg };
