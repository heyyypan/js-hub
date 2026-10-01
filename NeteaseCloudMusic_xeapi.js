/*
 * 网易云音乐 xeapi 响应处理（Loon，需要 Build 988+）
 *
 * 背景：新版 App 的大部分接口从 /eapi/ 迁到了 /xeapi/，原脚本只匹配 /eapi/，
 *       所以界面开关（隐藏底部标签、首页模块等）对 xeapi 接口不生效。
 * 本脚本：AES-128-ECB 解密 -> (gzip 解压) -> 改 JSON -> (gzip 压缩) -> 加密 -> 回写。
 *         逻辑沿用原脚本，同时兼容 /eapi/ 与 /xeapi/。任何异常都放行原响应。
 *
 * 插件里需要：requires-body=true, binary-body-mode=true
 */

var KEY = (function () {
  var s = "e82ckenh8dichen8", a = new Uint8Array(s.length);
  for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
  return a;
})();

// ---------- UTF-8（JavaScriptCore 里没有 TextDecoder，手写） ----------
function bytesToStr(b) {
  var s = "", i = 0, n = b.length, out = [];
  while (i < n) {
    var c = b[i++];
    if (c < 128) out.push(c);
    else if (c < 224) out.push(((c & 31) << 6) | (b[i++] & 63));
    else if (c < 240) out.push(((c & 15) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63));
    else {
      var cp = ((c & 7) << 18) | ((b[i++] & 63) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63);
      cp -= 0x10000;
      out.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 1023));
    }
    if (out.length > 8192) { s += String.fromCharCode.apply(null, out); out.length = 0; }
  }
  return s + String.fromCharCode.apply(null, out);
}
function strToBytes(s) {
  var out = [];
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) {
      var d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d < 0xe000) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
    }
    if (c < 128) out.push(c);
    else if (c < 2048) out.push(192 | (c >> 6), 128 | (c & 63));
    else if (c < 65536) out.push(224 | (c >> 12), 128 | ((c >> 6) & 63), 128 | (c & 63));
    else out.push(240 | (c >> 18), 128 | ((c >> 12) & 63), 128 | ((c >> 6) & 63), 128 | (c & 63));
  }
  return new Uint8Array(out);
}

// ---------- 参数 ----------
function readArgs() {
  var a = typeof $argument === "undefined" ? null : $argument;
  if (typeof a === "string") {
    try { a = JSON.parse(a); } catch (e) { a = null; }
  }
  return a && typeof a === "object" ? a : null;
}
function isOn(v) { return v === true || v === 1 || v === "1" || v === "true"; }

// ---------- 业务处理 ----------
var HOME_BLOCKS = {
  PRGG: "PAGE_RECOMMEND_GREETING",
  PRDRD: "PAGE_RECOMMEND_DAILY_RECOMMEND",
  PRSCVPT: "PAGE_RECOMMEND_SPECIAL_CLOUD_VILLAGE_PLAYLIST",
  PRST: "PAGE_RECOMMEND_SHORTCUT",
  HMPR: "HOMEPAGE_MUSIC_PARTNER",
  PRRR: "PAGE_RECOMMEND_RADAR",
  PRRK: "PAGE_RECOMMEND_RANK",
  PRMST: "PAGE_RECOMMEND_MY_SHEET",
  PRCN: "PAGE_RECOMMEND_COMBINATION"
};
var HOME_KEEP_DEFAULT = [
  "PAGE_RECOMMEND_DAILY_RECOMMEND",
  "PAGE_RECOMMEND_SPECIAL_CLOUD_VILLAGE_PLAYLIST",
  "PAGE_RECOMMEND_SHORTCUT",
  "HOMEPAGE_MUSIC_PARTNER",
  "PAGE_RECOMMEND_RADAR",
  "PAGE_RECOMMEND_RANK"
];
// 开关为 false（不隐藏）的模块才保留
function homeKeepList(args) {
  if (!args) return HOME_KEEP_DEFAULT;
  return Object.keys(args)
    .filter(function (k) { return !isOn(args[k]) && HOME_BLOCKS[k]; })
    .map(function (k) { return HOME_BLOCKS[k]; });
}

function cleanComment(c) {
  if (!c) return;
  if (c.user) {
    if (c.user.followed === false) c.user.followed = true;
    c.user.vipRights = null;
    c.user.avatarDetail = null;
  }
  c.userBizLevels = null;
  c.pendantData = null;
  if (c.tag) { c.tag.extDatas = []; c.tag.contentPicDatas = null; }
}

function blankGreeting(dsl) {
  if (!dsl) return;
  Object.keys(dsl).forEach(function (k) {
    var list = dsl[k] && dsl[k].commonResourceList;
    if (!Array.isArray(list)) return;
    list.forEach(function (d) {
      if (d.summary || d.extraMap || d.title) {
        if (d.summary) d.summary = "";
        if (d.extraMap) d.extraMap = {};
        if (d.trp_id) d.trp_id = "";
        if (d.log) d.log = {};
        if (d.icon) d.icon = "";
        if (d.actionUrl) d.actionUrl = "";
        if (d.s_ctrp) d.s_ctrp = "";
        if (d.resourceType) d.resourceType = "";
      }
    });
  });
}

function handle(path, obj, args) {
  var d = obj && obj.data;
  switch (path) {
    case "/link/home/framework/tab": {
      var NAME = { MY: "漫游", DT: "笔记", FX: "发现" };
      var hide = args
        ? Object.keys(args).filter(function (k) { return NAME[k] && isOn(args[k]); }).map(function (k) { return NAME[k]; })
        : ["漫游"];
      if (hide.length === 0) return false;
      if (d && Array.isArray(d.commonResourceList)) {
        var before = d.commonResourceList.length;
        d.commonResourceList = d.commonResourceList.filter(function (i) { return hide.indexOf(i.title) === -1; });
        d.commonResourceList.forEach(function (i) {
          if (i.title === "发现" && Array.isArray(i.subCommonResourceList)) {
            i.subCommonResourceList = i.subCommonResourceList.filter(function (y) { return y.title !== "直播"; });
          }
        });
        console.log("底部菜单: 隐藏[" + hide.join(",") + "] " + before + "->" + d.commonResourceList.length);
      }
      return true;
    }
    case "/batch": {
      var setData = function (k, v) { if (obj[k] && obj[k].data) obj[k].data = v === undefined ? {} : v; };
      setData("/api/comment/tips/v2/get", { count: 0, offset: 0, records: [] });
      setData("/api/social/event/bff/ad/resources");
      setData("/api/ad/get", { code: 200, ads: {} });
      var cm = obj["/api/v2/resource/comments"];
      if (cm && cm.data && Array.isArray(cm.data.comments)) cm.data.comments.forEach(cleanComment);
      var ins = obj["/api/comment/feed/inserted/resources"];
      if (ins && ins.data) { ins.data = {}; if (ins.trp && ins.trp.rules) ins.trp.rules = []; }
      var tp = obj["/api/event/rcmd/topic/list"];
      if (tp && tp.data && tp.data.topicList) tp.data.topicList = [];
      var gr = obj["/api/platform/song/bff/grading/song/order/entrance"];
      if (gr && gr.data && gr.data.songOrderEntrance) gr.data.songOrderEntrance = {};
      return true;
    }
    case "/v2/resource/comment/floor/get": {
      if (d && d.ownerComment) {
        if (d.ownerComment.user) { d.ownerComment.user.vipRights = null; d.ownerComment.user.avatarDetail = {}; }
        d.ownerComment.pendantData = null;
      }
      if (d && Array.isArray(d.comments)) d.comments.forEach(cleanComment);
      return true;
    }
    case "/link/position/show/resource": {
      var cpr = d && d.crossPlatformResource;
      if (cpr && cpr.positionCode === "MyPageBar") d.crossPlatformResource = {};
      return true;
    }
    case "/user/follow/users/mixed/get/v2": {
      if (d && Array.isArray(d.records)) {
        d.records.forEach(function (r) {
          if (r.mutualFollowDay === null) {
            r.showContent = { message: "\u{1F4A2}\u4ED6/\u5979,\u672A\u5173\u6CE8\u4F60", time: 1e12, active: true, boxContent: {} };
          }
        });
      }
      return true;
    }
    case "/link/page/discovery/resource/show": {
      if (d && d.blockCodeOrderList) {
        try {
          d.blockCodeOrderList = JSON.stringify(JSON.parse(d.blockCodeOrderList).filter(function (i) { return i !== "PAGE_DISCOVERY_BANNER"; }));
        } catch (e) {}
      }
      if (d && Array.isArray(d.blocks)) d.blocks = d.blocks.filter(function (i) { return i.bizCode !== "PAGE_DISCOVERY_BANNER"; });
      return true;
    }
    case "/homepage/block/page": {
      if (d && Array.isArray(d.blocks)) {
        for (var i = 0; i < d.blocks.length; i++) {
          var b = d.blocks[i];
          if (b.showType === "BANNER" && b.extInfo && Array.isArray(b.extInfo.banners)) {
            b.extInfo.banners = b.extInfo.banners.filter(function (y) { return ["活动", "广告"].indexOf(y.typeTitle) === -1; });
            break;
          }
        }
      }
      return true;
    }
    case "/link/page/rcmd/resource/show": {
      var keep = homeKeepList(args);
      if (d && Array.isArray(d.blocks)) {
        d.blocks = d.blocks.filter(function (i) { return keep.indexOf(i.bizCode) !== -1; });
        d.blocks.forEach(function (blk) {
          if (blk.bizCode === "PAGE_RECOMMEND_GREETING") blankGreeting(blk.dslData);
        });
      }
      if (d && d.blockCodeOrderList) {
        try {
          d.blockCodeOrderList = JSON.stringify(JSON.parse(d.blockCodeOrderList).filter(function (i) { return keep.indexOf(i) !== -1; }));
        } catch (e) {}
      }
      return true;
    }
    case "/link/page/rcmd/block/resource/multi/refresh": {
      var keep2 = homeKeepList(args);
      if (Array.isArray(obj.data)) {
        obj.data = obj.data.filter(function (i) { return keep2.indexOf(i.blockCode) !== -1; });
        obj.data.forEach(function (it) {
          if (it.blockCode === "PAGE_RECOMMEND_GREETING" && it.block) blankGreeting(it.block.dslData);
        });
      }
      return true;
    }
  }
  return false;
}

// ---------- 主流程 ----------
(function main() {
  try {
    var m = $request.url.match(/^https?:\/\/[^\/]+\/(?:x?e?api)(\/[a-zA-Z0-9\-\/]+)(\?.*)?$/);
    if (!m) return $done({});
    var path = m[1];

    var body = $response.body;
    if (typeof body === "string" || !body || body.length === 0 || body.length % 16 !== 0) return $done({});
    if (typeof $crypto === "undefined" || !$crypto.aes) {
      console.log("当前 Loon 不支持 $crypto.aes（需要 Build 988+），放行");
      return $done({});
    }

    var plain = $crypto.aes.decrypt(body, { mode: "ecb", key: KEY, padding: "pkcs7" });
    var wasGzip = plain.length > 2 && plain[0] === 0x1f && plain[1] === 0x8b;
    if (wasGzip) {
      if (typeof $utils === "undefined" || typeof $utils.ungzip !== "function") return $done({});
      plain = $utils.ungzip(plain);
    }

    var obj = JSON.parse(bytesToStr(plain));
    var changed = handle(path, obj, readArgs());
    if (!changed) return $done({});

    var out = strToBytes(JSON.stringify(obj));
    if (wasGzip && typeof $utils.gzip === "function") out = $utils.gzip(out);
    var enc = $crypto.aes.encrypt(out, { mode: "ecb", key: KEY, padding: "pkcs7" }).ciphertext;
    return $done({ body: enc });
  } catch (e) {
    console.log("处理失败，放行原响应: " + (e && e.message ? e.message : e));
    return $done({});
  }
})();
