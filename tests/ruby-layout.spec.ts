import { describe, expect, it } from "vitest";
import type { LyricLine, LyricWord } from "../src/types";
import { normalizeRubyLayout, type RubyWidthMeasurer } from "../src/utils/ruby-layout";

/**
 * 宽度模型：CJK 与假名每字 100，拉丁每字 60，空白 30，注音按 fontRatio 缩放
 *
 * 因此 1 个假名（50）窄于 1 个汉字（100），2 个假名正好占满正文，3 个假名溢出 50。
 */
const advance = (char: string): number => {
  if (/\s/.test(char)) return 30;
  return (char.codePointAt(0) ?? 0) >= 0x2000 ? 100 : 60;
};

const measure: RubyWidthMeasurer = (text, fontRatio) =>
  Array.from(text).reduce((total, char) => total + advance(char), 0) * fontRatio;

const rubyWord = (
  word: string,
  kanaList: string[],
  startTime: number,
  endTime: number,
): LyricWord => ({
  word,
  startTime,
  endTime,
  ruby: kanaList.map((kana, index) => ({
    word: kana,
    startTime: startTime + index * 10,
    endTime: endTime - index * 10,
  })),
});

const plainWord = (word: string, startTime: number, endTime: number): LyricWord => ({
  word,
  startTime,
  endTime,
});

const toLine = (...words: LyricWord[]): LyricLine => ({
  words,
  translatedLyric: "",
  romanLyric: "",
  startTime: words[0]?.startTime ?? 0,
  endTime: words[words.length - 1]?.endTime ?? 0,
  isBG: false,
  isDuet: false,
});

/** 相邻单字注音溢出相撞的最小行 */
const collidingLine = (): LyricLine =>
  toLine(rubyWord("物", ["もの"], 0, 500), rubyWord("語", ["がたり"], 500, 1200));

const normalize = (line: LyricLine): { lines: LyricLine[]; source: LyricLine[] } => {
  const source = [line];
  return { lines: normalizeRubyLayout(source, measure), source };
};

const texts = (line: LyricLine): string[] => line.words.map((word) => word.word);
const rubyTexts = (line: LyricLine): (string[] | undefined)[] =>
  line.words.map((word) => word.ruby?.map((span) => span.word));

describe("normalizeRubyLayout", () => {
  it("相邻单字注音溢出相撞时合并为一个多字整体注音词", () => {
    const { lines } = normalize(collidingLine());

    expect(texts(lines[0])).toEqual(["物語"]);
    expect(rubyTexts(lines[0])).toEqual([["ものがたり"]]);
    expect(lines[0].words[0].startTime).toBe(0);
    expect(lines[0].words[0].endTime).toBe(1200);
  });

  it("多字整体注音与单字注音相撞时同样合并", () => {
    const { lines } = normalize(
      toLine(rubyWord("話", ["はなす"], 0, 400), rubyWord("術", ["じゅつ"], 400, 800)),
    );

    expect(texts(lines[0])).toEqual(["話術"]);
    expect(rubyTexts(lines[0])).toEqual([["はなすじゅつ"]]);
  });

  it("注音未溢出且相邻注音内收时保持独立并返回原数组", () => {
    const { lines, source } = normalize(
      toLine(rubyWord("木", ["き"], 0, 400), rubyWord("立", ["た"], 400, 800)),
    );

    expect(lines).toBe(source);
    expect(texts(lines[0])).toEqual(["木", "立"]);
  });

  it("链式相撞连续合并，直到注音盒不再重叠", () => {
    const { lines } = normalize(
      toLine(
        rubyWord("話", ["はなす"], 0, 300),
        rubyWord("術", ["じゅつ"], 300, 600),
        rubyWord("場", ["ば"], 600, 700),
        rubyWord("合", ["ごう"], 700, 1000),
        rubyWord("木", ["き"], 1000, 1200),
      ),
    );

    expect(texts(lines[0])).toEqual(["話術場合", "木"]);
    expect(rubyTexts(lines[0])).toEqual([["はなすじゅつばごう"], ["き"]]);
  });

  it("词内逐字注音相撞时压缩为该词的整词注音", () => {
    const { lines } = normalize(
      toLine(rubyWord("明日", ["あした", "はな"], 0, 800), plainWord("の", 800, 900)),
    );

    expect(texts(lines[0])).toEqual(["明日", "の"]);
    expect(rubyTexts(lines[0])).toEqual([["あしたはな"], undefined]);
    expect(lines[0].words[0].startTime).toBe(0);
    expect(lines[0].words[0].endTime).toBe(800);
  });

  it("整行注音超出正文时合并，即使首末字注音盒恰好相切", () => {
    // 逐字注音宽窄交替：每个字盒都不越出正文接缝，但整行注音总宽超出正文，
    // 整行居中后仍会压到右侧词的注音上（applemusic-like-lyrics 的排布模型）
    const { lines } = normalize(
      toLine(
        rubyWord("アウオエ", ["アアア", "エ", "オオオ", "エ"], 0, 400),
        rubyWord("空", ["さむら"], 400, 800),
      ),
    );

    expect(texts(lines[0])).toEqual(["アウオエ空"]);
    expect(rubyTexts(lines[0])).toEqual([["アアアエオオオエさむら"]]);
  });

  it("正文之间的空白按实际宽度吸收溢出，足够宽时不合并", () => {
    const { lines, source } = normalize(
      toLine(rubyWord("話", ["はなす"], 0, 400), rubyWord("        術", ["じゅつ"], 400, 800)),
    );

    expect(lines).toBe(source);
    expect(texts(lines[0])).toEqual(["話", "        術"]);
  });

  it("未注音的词隔开相邻注音，不跨词合并", () => {
    const { lines } = normalize(
      toLine(
        rubyWord("話", ["はなす"], 0, 400),
        plainWord("な", 400, 600),
        rubyWord("術", ["じゅつ"], 600, 1000),
      ),
    );

    expect(texts(lines[0])).toEqual(["話", "な", "術"]);
  });

  it("只有空白注音的词不会被丢弃，其余注音照常合并", () => {
    const blank = rubyWord("空", [" "], 0, 100);
    const { lines } = normalize(
      toLine(blank, rubyWord("物", ["もの"], 100, 500), rubyWord("語", ["がたり"], 500, 900)),
    );

    expect(texts(lines[0])).toEqual(["空", "物語"]);
    expect(rubyTexts(lines[0])).toEqual([[" "], ["ものがたり"]]);
    expect(lines[0].words[0]).toBe(blank);
  });

  it("空白的注音条目被忽略后按整词注音衡量溢出", () => {
    const { lines } = normalize(
      toLine(rubyWord("日本", ["にっぽん", "  "], 0, 400), rubyWord("語", ["がたり"], 400, 800)),
    );

    expect(texts(lines[0])).toEqual(["日本語"]);
    expect(rubyTexts(lines[0])).toEqual([["にっぽんがたり"]]);
  });

  it("合并保留罗马音、脏词标记与空拍", () => {
    const first = {
      ...rubyWord("話", ["はなす"], 0, 400),
      romanWord: "hana",
      obscene: true,
      emptyBeat: 2,
    };
    const second = { ...rubyWord("術", ["じゅつ"], 400, 800), romanWord: "jutsu" };
    const merged = normalize(toLine(first, second)).lines[0].words[0];

    expect(merged.word).toBe("話術");
    expect(merged.romanWord).toBe("hana jutsu");
    expect(merged.obscene).toBe(true);
    expect(merged.emptyBeat).toBe(2);
    expect(merged.startTime).toBe(0);
    expect(merged.endTime).toBe(800);
  });

  it("注音恰好占满正文宽度时不算重叠", () => {
    const { lines, source } = normalize(
      toLine(rubyWord("本", ["ほん"], 0, 500), rubyWord("当", ["とう"], 500, 1000)),
    );

    expect(lines).toBe(source);
  });

  it("量宽时带上行主语言，供调用方选用渲染层同字体", () => {
    const seen: (string | undefined)[] = [];
    const spy: RubyWidthMeasurer = (text, fontRatio, language) => {
      seen.push(language);
      return measure(text, fontRatio);
    };
    const line = { ...collidingLine(), language: "ja" as const };

    normalizeRubyLayout([line], spy);

    expect(seen.every((language) => language === "ja")).toBe(true);
  });

  it("背景行同样规范化并保留行属性", () => {
    const line = { ...collidingLine(), isBG: true };
    const { lines } = normalize(line);

    expect(texts(lines[0])).toEqual(["物語"]);
    expect(lines[0].isBG).toBe(true);
    expect(lines[0].endTime).toBe(line.endTime);
  });

  it("无注音的行与整首无重叠时返回原数组", () => {
    const source = [toLine(plainWord("Hello", 0, 300)), toLine(rubyWord("木", ["き"], 0, 300))];
    const result = normalizeRubyLayout(source, measure);

    expect(result).toBe(source);
    expect(result[0]).toBe(source[0]);
  });

  it("规范化幂等，重复执行不再改动数据", () => {
    const once = normalize(
      toLine(
        rubyWord("話", ["はなす"], 0, 300),
        rubyWord("術", ["じゅつ"], 300, 600),
        rubyWord("明日", ["あした", "はな"], 600, 900),
      ),
    ).lines;

    expect(normalizeRubyLayout(once, measure)).toBe(once);
  });

  it("输出正文与原文逐字一致，不丢字也不重复", () => {
    const source = [
      toLine(
        rubyWord("話", ["はなす"], 0, 300),
        rubyWord("術", ["じゅつ"], 300, 600),
        plainWord("の", 600, 700),
        rubyWord("木々", ["き", "うま"], 700, 900),
        rubyWord("馬", ["うるま"], 900, 1200),
        rubyWord("空", [" "], 1200, 1300),
      ),
    ];
    const lineText = (lyricLines: LyricLine[]): string =>
      lyricLines.map((line) => line.words.map((word) => word.word).join("")).join("|");
    const lines = normalizeRubyLayout(source, measure);

    expect(lineText(lines)).toBe(lineText(source));
  });

  it("未参与合并的词沿用原对象引用", () => {
    const tail = rubyWord("    木", ["き"], 800, 1000);
    const { lines } = normalize(
      toLine(rubyWord("話", ["はなす"], 0, 400), rubyWord("術", ["じゅつ"], 400, 800), tail),
    );

    expect(texts(lines[0])).toEqual(["話術", "    木"]);
    expect(lines[0].words[1]).toBe(tail);
  });
});
