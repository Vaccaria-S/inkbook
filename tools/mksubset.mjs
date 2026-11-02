/**
 * 把 fontsource 的 Noto Sans SC（woff2）转成可内联的子集 TTF。
 *
 * 目的：导出 PDF 时用 drawText 写用户批注，文字要能选中/搜索，
 * 就必须嵌一份中文字体。完整 Noto Sans SC 转 TTF 有 8MB+，
 * base64 内联会把 main.js 撑爆，所以按 GB2312 字符集做子集。
 */
import fs from "node:fs";
import path from "node:path";
import subsetFont from "subset-font";

const SRC =
  "node_modules/@fontsource/noto-sans-sc/files/noto-sans-sc-chinese-simplified-400-normal.woff2";

/** 遍历 GB2312 双字节区，解码出全部汉字与符号 */
function gb2312Chars() {
  const dec = new TextDecoder("gbk");
  const out = new Set();
  for (let hi = 0xa1; hi <= 0xf7; hi += 1) {
    for (let lo = 0xa1; lo <= 0xfe; lo += 1) {
      const s = dec.decode(new Uint8Array([hi, lo]));
      if (s && s.length === 1 && s !== "\ufffd") out.add(s);
    }
  }
  return out;
}

const ascii = Array.from({ length: 0x7e - 0x20 + 1 }, (_, i) =>
  String.fromCharCode(0x20 + i)
).join("");

// 全角标点、常用符号、以及几组 GB2312 里没有但日常会打到的字
const extra =
  "、。，．·；：？！…—～《》〈〉「」『』（）【】〔〕｛｝“”‘’％＋－＝／＼＠＃＆＊｜＿＾～　" +
  "①②③④⑤⑥⑦⑧⑨⑩℃±×÷≠≤≥∞√∑∏∫≈∵∴⊙○●△▲□■◇◆★☆→←↑↓↔" +
  "㈠㈡㈢㈣㈤㈥㈦㈧㈨㈩";

const words = [
  "黄帝内经伤寒论金匮要略温病条辨神农本草经难经针灸甲乙经脉经诸病源候论千金要方外台秘要",
  "阴阳五行藏象经络气血津液营卫三焦命门君臣佐使升降浮沉寒热温凉酸苦甘辛咸",
  "证候辨证论治望闻问切四诊八纲表里虚实寒热补泻和解清热温里攻下逐水消导吐法汗法下法",
  "瘛疭鼽衄衄血嘤嘤噫哕呃逆嗳气痞满嘈杂吞酸吐酸嘈杂脘腹胀满胁痛黄疸眩晕瘿瘤瘰疬",
  "龋齿齘齿䐜胀䐜满瞤动瞀闷怫郁懊憹㿠白㿠肿黧黑萎黄晦暗黧黑",
];

const chars = new Set([...ascii, ...gb2312Chars(), ...extra, ...words.join("")]);
const text = [...chars].join("");

const src = fs.readFileSync(SRC);
console.log("源字体", SRC, (src.length / 1024).toFixed(0) + "KB woff2");
console.log("字符数", text.length);

const full = await subsetFont(src, text, { targetFormat: "truetype" });
const outDir = "assets";
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "NotoSansSC-subset.ttf");
fs.writeFileSync(outPath, full);
console.log("子集 TTF", (full.length / 1024).toFixed(0) + "KB →", outPath);

// 再试一个更小的：只有 ASCII + 3500 常用字（看看能省多少）
const common = [...text].slice(0, 3600).join("");
const small = await subsetFont(src, common, { targetFormat: "truetype" });
console.log("（参考）只取前 3600 字：", (small.length / 1024).toFixed(0) + "KB");
