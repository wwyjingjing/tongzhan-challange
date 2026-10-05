/**
 * 判定规则单测（Node 直接跑，不依赖服务与 OCR）
 * 覆盖：强广告特征 / 弱特征累积 / 课程内容 / 录屏界面噪声 / 空文本
 */
const path = require('path');
const fs = require('fs');

// 从 server.js 中提取判定相关代码段并求值，保证测试的就是线上那份逻辑
const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const start = src.indexOf('const CUT_STRONG');
const end = src.indexOf('// ---------- 5.');
if (start < 0 || end < 0) { console.error('无法定位判定代码段'); process.exit(1); }
const classify = new Function(src.slice(start, end) + '\n return classify;')();

const cases = [
  ['本视频由星辰教育独家赞助播出', 'cut'],
  ['关注公众号 领取课程资料', 'cut'],
  ['点赞投币收藏 一键三连', 'cut'],
  ['第三章 数据结构基础', 'keep'],
  ['我们来看二叉树的定义', 'keep'],
  ['接下来讲解遍历的三种方式', 'keep'],
  // 典型录屏界面文字：不应误判为广告
  ['80 12:14 18人正在看 EigenFlux Relakkes bilibili', 'keep'],
  ['Q)2人正在看 稿件己退回，仅自己可见 bilibili', 'keep'],
  ['音乐 861 131 播放 评论 简介', 'keep'],
  // 弱特征累积到阈值 -> cut
  ['关注 点赞 投币 收藏 订阅 公众号', 'cut'],
  ['', 'unsure'],
];

let fails = 0;
for (const [text, expect] of cases) {
  const r = classify(text);
  const ok = r.suggestion === expect;
  if (!ok) fails++;
  console.log(`${ok ? 'PASS ✔' : 'FAIL ✘'} [${r.suggestion.padEnd(6)}] 期望[${expect.padEnd(6)}]  ${text.slice(0, 40) || '(空)'}`);
  console.log(`        依据: ${r.reason}`);
}
console.log(`\n结果: ${cases.length - fails}/${cases.length} 通过` + (fails ? ` —— ${fails} 项不符` : ' —— ALL PASS'));
process.exit(fails ? 1 : 0);
