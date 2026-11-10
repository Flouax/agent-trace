/**
 * lib/host-text.cjs — 剥离 Cindy 宿主注入块（cc 与 pi 共用）。
 *
 * Cindy 不管底下跑哪个引擎，都会把 [Task delivery] / [UI language] / [消息来源] / [Session fork … 等说明拼在用户文字前后。
 * 这些不是用户亲手输入的，要归入 context；剥完剩下的才是 user。规则用本机真实转录核对过（见 cc.cjs 头注释）。
 */

'use strict';

const TEXT = {
  image: '[图片]',
  hostNote: '宿主说明',
  systemReminder: '系统提醒',
  imageRefs: '图片引用',
  hostGroupSep: ' · ',
};

/**
 * 宿主注入块（真实转录核对：同一条用户记录的字符串里依次拼着这些块，后面才是真正的内容；块之间可能只隔一个换行）。
 * 一行要「已知头 + 固定特征文字」才算，避免把用户正文里碰巧以 [UI language] 开头的行吞掉；
 * 而且只在段落首行，或紧跟在另一个注入块之后时才匹配（块与块之间常常只隔一个换行）。
 */
const HOST_LINES = [
  { label: '[Task delivery]', re: /^\[Task delivery\] Host bookkeeping/ },
  { label: '[UI language]', re: /^\[UI language\] System note/ },
  { label: '[消息来源]', re: /^\[消息来源\] (本条由|宿主已核实)/ },
  { label: '[客户端说明]', re: /^\[客户端说明\] 系统追加/ },
  { label: '[任务来源]', re: /^\[任务来源\] 本任务由/, followLine: /^任务\s*ID\s*[：:]/ }, // 其后紧跟的「任务 ID：」行一并剥离
];
/** 多行块：从头行起到结束行（含）。找不到结束行时只剥到段落末，不会吞掉后面的用户文字。 */
const HOST_SPANS = [
  { label: '[Session fork]', start: /^\[Session (fork|handoff) · internal context\]/, end: /^==.*==\s*$/, maxLines: 12 },
];
/** 成对标签块：只要标签单独占一行开头就匹配（该标签不会出现在用户正文里）。 */
const HOST_TAGS = [
  { tag: 'cindy-host-image-references', label: TEXT.imageRefs },
  { tag: 'system-reminder', label: TEXT.systemReminder },
  { tag: 'local-command-caveat', label: TEXT.hostNote },
];

/**
 * 把一段文本按行切开，剥离宿主注入块。返回 [{ kind:'context', label, text } | { kind:'user', text }]，保持原顺序。
 * 剥完没有剩下用户文字时返回的全是 context。
 */
function splitHost(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let userBuf = [];
  const flushUser = () => {
    const t = userBuf.join('\n').trim();
    if (t) out.push({ kind: 'user', text: t });
    userBuf = [];
  };
  const inject = (label, taken) => {
    flushUser();
    out.push({ kind: 'context', label, text: taken.join('\n') });
  };
  let paraStart = true; // 上一行是空行或文本开头
  let chained = false; // 上一行是被剥离的注入块
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const t = line.trimStart();
    if (!t) { userBuf.push(line); paraStart = true; chained = false; continue; }
    let consumed = 0;
    let label = '';
    const tagDef = HOST_TAGS.find((d) => t.startsWith(`<${d.tag}>`));
    if (tagDef) {
      // 有结束标签就剥到那里（标签块内部可以有空行）；找不到就只剥这一行
      const close = `</${tagDef.tag}>`;
      let k = i;
      while (k < lines.length && !lines[k].includes(close)) k += 1;
      consumed = k < lines.length ? k - i + 1 : 1;
      label = tagDef.label;
    } else if (paraStart || chained) {
      const lineDef = HOST_LINES.find((d) => d.re.test(t));
      const spanDef = lineDef ? null : HOST_SPANS.find((d) => d.start.test(t));
      if (lineDef) {
        consumed = 1;
        label = lineDef.label;
        if (lineDef.followLine) {
          let j = i + 1;
          while (j < lines.length && !lines[j].trim()) j += 1;
          if (j < lines.length && lineDef.followLine.test(lines[j].trim())) consumed = j - i + 1;
        }
      } else if (spanDef) {
        label = spanDef.label;
        let end = -1;
        for (let j = i + 1; j < lines.length && j <= i + spanDef.maxLines; j += 1) {
          if (spanDef.end.test(lines[j].trim())) { end = j; break; }
        }
        if (end >= 0) consumed = end - i + 1;
        else {
          let j = i + 1;
          while (j < lines.length && lines[j].trim()) j += 1;
          consumed = j - i;
        }
      }
    }
    if (consumed) {
      inject(label, lines.slice(i, i + consumed));
      i += consumed - 1;
      paraStart = false;
      chained = true;
    } else {
      userBuf.push(line);
      paraStart = false;
      chained = false;
    }
  }
  flushUser();
  return out;
}

/**
 * 一条记录里的所有段 → 步骤序列：相邻的 context 合成一个（label 用「 · 」连接去重后的来源），
 * 所有 user 文字与图片合成一个 user 步骤，放在第一段用户内容的位置（一条记录就是一轮输入）。
 * 段的 kind 可以是 user / image（带 media）/ context，或调用方自定义的其他 kind（原样保留，缺 label 的补「宿主说明」）。
 */
function mergeSegments(segments) {
  const out = [];
  const texts = [];
  const attachments = [];
  let slot = -1;
  for (const seg of segments) {
    if (seg.kind === 'user' || seg.kind === 'image') {
      if (slot < 0) { slot = out.length; out.push(null); }
      if (seg.kind === 'user') texts.push(seg.text);
      else attachments.push({ name: TEXT.image, type: seg.media || 'image' });
    } else if (seg.kind === 'context' && out.length && out[out.length - 1] && out[out.length - 1].kind === 'context') {
      const prev = out[out.length - 1];
      const labels = prev.label.split(TEXT.hostGroupSep);
      if (seg.label && !labels.includes(seg.label)) prev.label += TEXT.hostGroupSep + seg.label;
      prev.text += '\n\n' + seg.text;
    } else {
      out.push({ ...seg, label: seg.label || TEXT.hostNote });
    }
  }
  if (slot >= 0) {
    const user = { kind: 'user', text: texts.join('\n\n') };
    if (attachments.length) user.attachments = attachments;
    out[slot] = user;
  }
  return out;
}

module.exports = { splitHost, mergeSegments };
