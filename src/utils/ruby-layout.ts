import type { LyricLanguage, LyricLine, LyricWord } from "../types";

/**
 * 行内宽度测量函数，由调用方提供（Canvas、浏览器字体或测试桩），本模块不依赖 DOM
 *
 * 重叠判定只比较正文与注音的相对位置，绝对尺度不影响结果，但正文（`fontRatio` 为 1）与
 * 注音必须用同一参考字号量取。渲染层按行的主语言选择字形，`language` 用于取到同一字体。
 */
export type RubyWidthMeasurer = (
  text: string,
  fontRatio: number,
  language?: LyricLanguage,
) => number;

/** 已绑定所在行主语言的量宽函数 */
type LineMeasurer = (text: string, fontRatio: number) => number;

/** 注音单元：注音文本与其注音盒，注音盒以所覆盖正文的中线为轴居中 */
interface RubyUnit {
  kana: string;
  left: number;
  right: number;
}

/** 注音组：行内一段连续的注音内容，对应输出中的一个歌词词 */
interface RubyGroup {
  wordStart: number;
  wordCount: number;
  baseLeft: number;
  baseRight: number;
  /** 按行内顺序排列，压缩后只剩一个 */
  units: RubyUnit[];
  /** 是否发生过词内或跨词合并 */
  collapsed: boolean;
}

/** 注音相对正文的字号比例，与两套渲染器的 CSS 默认值一致（`--lp-ruby-font-size`、`.rubyWord`） */
const RUBY_FONT_RATIO = 0.5;

/**
 * 量取一个注音盒：以所覆盖正文的中线为轴居中
 * @param measure - 行内量宽函数
 * @param baseLeft - 所覆盖正文的左边界
 * @param baseRight - 所覆盖正文的右边界
 * @param kana - 注音文本
 * @returns 注音单元
 */
const createRubyUnit = (
  measure: LineMeasurer,
  baseLeft: number,
  baseRight: number,
  kana: string,
): RubyUnit => {
  const half = measure(kana, RUBY_FONT_RATIO) / 2;
  const center = (baseLeft + baseRight) / 2;
  return { kana, left: center - half, right: center + half };
};

/**
 * 整组注音共用一行时的注音盒边界
 *
 * applemusic-like-lyrics 把一个词的注音渲染成居中且不参与整词计宽的一行，lyric-dom 逐字
 * 配对时只需比对单个注音盒；两种排布都可能相撞，因此两个盒都要测。
 * @param group - 注音组
 * @returns 注音盒的左右边界
 */
const groupRowEdges = (group: RubyGroup): [number, number] => {
  const width = group.units.reduce((total, unit) => total + unit.right - unit.left, 0);
  const center = (group.baseLeft + group.baseRight) / 2;
  return [center - width / 2, center + width / 2];
};

/**
 * 把注音组压缩为一个覆盖整段正文的注音单元：注音条目只剩一条而正文跨多个图素，两套渲染器
 * 必定走整词标注分支；注音宽度按拼接后的整串重新量取，而非各段宽度相加
 * @param group - 待压缩的注音组
 * @param measure - 行内量宽函数
 * @returns 压缩后的注音组
 */
const collapseRubyGroup = (group: RubyGroup, measure: LineMeasurer): RubyGroup => ({
  ...group,
  collapsed: true,
  units: [
    createRubyUnit(
      measure,
      group.baseLeft,
      group.baseRight,
      group.units.map((unit) => unit.kana).join(""),
    ),
  ],
});

/**
 * 判断相邻注音组是否需要合并：逐字注音盒在接缝处相撞，或整行注音盒相撞
 * @param previous - 左侧注音组
 * @param next - 右侧注音组
 * @returns 是否需要合并
 */
const shouldMergeGroups = (previous: RubyGroup, next: RubyGroup): boolean =>
  previous.wordStart + previous.wordCount === next.wordStart &&
  (previous.units[previous.units.length - 1].right > next.units[0].left ||
    groupRowEdges(previous)[1] > groupRowEdges(next)[0]);

/**
 * 逐词展开注音组：有效注音条目数与词内图素数一致时逐字配对，否则整词共用一条注音，空白注音
 * 条目按渲染器的过滤规则忽略，词内逐字注音互相相撞时先压缩为该词的整词注音。正文宽度整串
 * 量取，比逐字累加更贴近真实排布，正文里的空白因此能自然吸收相邻注音的溢出。
 * @param words - 歌词词序列
 * @param measure - 行内量宽函数
 * @returns 按行内顺序排列的注音组
 */
const buildRubyGroups = (words: LyricWord[], measure: LineMeasurer): RubyGroup[] => {
  const groups: RubyGroup[] = [];
  let cursor = 0;

  for (const [wordIndex, word] of words.entries()) {
    const spans = (word.ruby ?? []).filter((span) => span.word.trim().length > 0);
    const chars = spans.length > 0 ? Array.from(word.word) : [];
    const baseLeft = cursor;
    cursor += measure(word.word, 1);
    if (chars.length === 0 || baseLeft === cursor) continue;

    const units: RubyUnit[] = [];
    if (spans.length === chars.length && chars.length > 1) {
      let charLeft = baseLeft;
      for (const [charIndex, char] of chars.entries()) {
        const charRight = charLeft + measure(char, 1);
        units.push(createRubyUnit(measure, charLeft, charRight, spans[charIndex].word));
        charLeft = charRight;
      }
      cursor = charLeft;
    } else {
      units.push(
        createRubyUnit(measure, baseLeft, cursor, spans.map((span) => span.word).join("")),
      );
    }

    const group: RubyGroup = {
      wordStart: wordIndex,
      wordCount: 1,
      baseLeft,
      baseRight: cursor,
      units,
      collapsed: units.some((unit, index) => index > 0 && units[index - 1].right > unit.left),
    };
    groups.push(group.collapsed ? collapseRubyGroup(group, measure) : group);
  }

  return groups;
};

/**
 * 顺序扫描注音组，把相撞的相邻组合并，合并结果继续与左侧组比对直到不再相撞
 * @param groups - 按行内顺序排列的注音组
 * @param measure - 行内量宽函数
 * @returns 合并后的注音组
 */
const resolveGroupCollisions = (groups: RubyGroup[], measure: LineMeasurer): RubyGroup[] => {
  const resolved: RubyGroup[] = [];

  for (const group of groups) {
    let current = group;
    while (resolved.length > 0 && shouldMergeGroups(resolved[resolved.length - 1], current)) {
      const previous = resolved.pop() as RubyGroup;
      current = collapseRubyGroup(
        {
          wordStart: previous.wordStart,
          wordCount: previous.wordCount + current.wordCount,
          baseLeft: previous.baseLeft,
          baseRight: current.baseRight,
          units: [...previous.units, ...current.units],
          collapsed: true,
        },
        measure,
      );
    }
    resolved.push(current);
  }

  return resolved;
};

/**
 * 由压缩后的注音组重建歌词词：正文是若干完整原词的拼接，时间窗取覆盖词的并集，因此不产生
 * 半词或自造时间
 * @param group - 压缩后的注音组
 * @param words - 原始歌词词序列
 * @returns 重建后的歌词词
 */
const buildGroupWord = (group: RubyGroup, words: LyricWord[]): LyricWord => {
  const sources = words.slice(group.wordStart, group.wordStart + group.wordCount);
  const startTime = sources[0].startTime;
  const endTime = Math.max(startTime, sources[sources.length - 1].endTime);
  const ruby = [{ word: group.units[0].kana, startTime, endTime }];
  if (group.wordCount === 1) return { ...sources[0], ruby };

  const romanWord = sources
    .map((source) => source.romanWord?.trim() ?? "")
    .filter((roman) => roman.length > 0)
    .join(" ");
  const mergedWord: LyricWord = {
    ...sources[0],
    word: sources.map((source) => source.word).join(""),
    startTime,
    endTime,
    ruby,
    obscene: sources.some((source) => source.obscene === true),
    romanWord: romanWord.length > 0 ? romanWord : sources[0].romanWord,
  };
  const emptyBeat = sources.find((source) => source.emptyBeat !== undefined)?.emptyBeat;
  if (emptyBeat !== undefined) mergedWord.emptyBeat = emptyBeat;

  return mergedWord;
};

/**
 * 由合并后的注音组重建该行的词序列，未参与合并的词保持原对象
 * @param line - 歌词行
 * @param groups - 合并后的注音组
 * @returns 重建后的歌词词序列
 */
const rebuildLineWords = (line: LyricLine, groups: RubyGroup[]): LyricWord[] => {
  const words = line.words;
  const nextWords: LyricWord[] = [];
  let cursor = 0;

  for (const group of groups) {
    for (; cursor < group.wordStart; cursor++) nextWords.push(words[cursor]);
    nextWords.push(group.collapsed ? buildGroupWord(group, words) : words[group.wordStart]);
    cursor = group.wordStart + group.wordCount;
  }
  for (; cursor < words.length; cursor++) nextWords.push(words[cursor]);

  return nextWords;
};

/**
 * 消除相邻注音之间的边界重叠，避免注音互相压字
 *
 * 注音宽于其正文时向两侧溢出，压到相邻注音上。检测按图素粒度进行（词内逐字注音之间、跨词的
 * 注音之间都判定），相撞的相邻单元合并为一个多字整体注音单元，由渲染层整词居中排布；合并后
 * 仍与左右相邻相撞的继续沿正文顺序链式合并，未相撞的保持原样。合并只发生在完整歌词词之间，
 * 正文与词时间窗都取自原数据。
 * @param lines - 歌词行数组
 * @param measure - 行内宽度测量函数
 * @returns 规范化后的歌词行数组；未发生任何合并时返回入参数组
 */
export const normalizeRubyLayout = (
  lines: LyricLine[],
  measure: RubyWidthMeasurer,
): LyricLine[] => {
  let changed = false;

  const result = lines.map((line) => {
    if (!line.words.some((word) => (word.ruby?.length ?? 0) > 0)) return line;

    const lineMeasure: LineMeasurer = (text, ratio) => measure(text, ratio, line.language);
    const groups = buildRubyGroups(line.words, lineMeasure);
    const resolved = resolveGroupCollisions(groups, lineMeasure);
    if (resolved.length === groups.length && groups.every((group) => !group.collapsed)) {
      return line;
    }

    changed = true;
    return { ...line, words: rebuildLineWords(line, resolved) };
  });

  return changed ? result : lines;
};
