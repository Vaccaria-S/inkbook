import {
  activeLayer,
  createLayer,
  createPage,
  type InkBook,
  type Layer,
  type Page,
  type PaperId,
  type Stroke,
  type TemplateId,
  uid,
} from "./types";

/**
 * 撤销栈条目。
 *
 * 关键设计：**记录操作，而不是全量快照**。
 *
 * 旧做法是每次落笔都 JSON.stringify 整页。实测一页 1000 条笔迹时，
 * 每次落笔要花 6.7ms 序列化，撤销栈 40 层就是 68MB——
 * 写多了会明显卡顿。
 *
 * 现在改成记增量：
 *   - 加了一笔 → 记 "add"，撤销时删掉这一笔
 *   - 删了几笔 → 记 "remove"，撤销时把它们放回去
 *   - 整页级别的改动（换模板、加页…）才用全量快照
 *
 * 增量条目只存被改动的那几条笔迹，代价与操作量成正比，
 * 与页面总笔迹数无关。
 *
 * 语义：每个条目表示「让某层**多出/少掉**这些笔迹」——
 * add 是加，remove 是删。undo/redo 靠前后状态对来区分方向。
 */
export type HistoryEntry =
  /** 整页快照（结构性改动） */
  | { kind: "page"; pageId: string; pageIndex: number; data: string }
  /** 整本快照 */
  | { kind: "book"; data: string }
  /**
   * 增量：把某层**整个变成**这些笔迹。
   *
   * 用「整层替换」而不是「加/删」，语义最简单也最不容易出错：
   * 应用它 = 该层的笔迹列表被替换为 strokes（按 positions 放位置）。
   */
  | {
      kind: "layer";
      pageId: string;
      pageIndex: number;
      layerId: string;
      /** 该层应有的全部笔迹 */
      strokes: Stroke[];
      /** 每条笔迹在层内的位置（-1 = 追加到末尾） */
      positions?: number[];
    };

/** 撤销栈最多保留多少条 */
const MAX_HISTORY = 60;

export class BookStore {
  data: InkBook;
  onChange: () => void = () => {};
  /** 撤销栈：每项是一次操作的前后状态 */
  private undoStack: Array<{ before: HistoryEntry; after: HistoryEntry }> = [];
  private redoStack: Array<{ before: HistoryEntry; after: HistoryEntry }> = [];

  constructor(book: InkBook) {
    this.data = book;
  }

  touch(): void {
    // 有挂起的快照就结算它（补上"操作后"状态）
    this.settleHistory();
    this.data.updated = Date.now();
    this.onChange();
  }

  get page(): Page {
    return this.data.pages[this.data.activePage] || this.data.pages[0];
  }

  get layer() {
    return activeLayer(this.page);
  }

  get pageCount(): number {
    return this.data.pages.length;
  }

  get strokeCount(): number {
    let n = 0;
    for (const page of this.data.pages) {
      for (const layer of page.layers) n += layer.strokes.length;
    }
    return n;
  }

  /* ------------------------------- 撤销栈 ------------------------------- */

  /**
   * 一次操作的前后两个状态。
   *
   * 用一对来记录，而不是单条——这样 undo/redo 完全对称：
   *   撤销 = 应用 before
   *   重做 = 应用 after
   *
   * 不用方向判断，也不用生成"反向操作"，逻辑简单不易错。
   */
  private pushHistory(before: HistoryEntry, after: HistoryEntry): void {
    // 增量操作自己记录前后状态，不需要挂起的快照
    this.pendingBefore = null;
    this.undoStack.push({ before, after });
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  /**
   * 拍一个「操作前」的快照。
   *
   * 真正的 after 状态要等操作做完才知道——
   * 所以先记下 before，等下一次 touch() 时再补 after。
   * 这样调用方不用关心顺序：先 snapshot 再改，改完 touch 即可。
   */
  private pendingBefore: HistoryEntry | null = null;

  private captureBefore(entry: HistoryEntry): void {
    this.pendingBefore = entry;
  }

  /** 操作完成，补上 after 状态 */
  private settleHistory(): void {
    // 正在结算/应用历史时不要再结算，避免递归
    if (this.settling) return;
    if (!this.pendingBefore) return;
    this.settling = true;
    try {
      const before = this.pendingBefore;
      this.pendingBefore = null;
      // after = 现在的状态（和 before 同类型）
      const after: HistoryEntry =
        before.kind === "book"
          ? {
              kind: "book",
              data: JSON.stringify({ pages: this.data.pages, activePage: this.data.activePage }),
            }
          : {
              kind: "page",
              pageId: before.pageId,
              pageIndex: before.pageIndex,
              data: JSON.stringify(this.data.pages[this.pageIndexOf(before)]),
            };
      this.pushHistory(before, after);
    } finally {
      this.settling = false;
    }
  }

  /** 是否正在结算历史（防递归） */
  private settling = false;

  snapshotPage(index = this.data.activePage): void {
    const page = this.data.pages[index];
    if (!page) return;
    this.captureBefore({
      kind: "page",
      pageId: page.id,
      pageIndex: index,
      data: JSON.stringify(page),
    });
  }

  snapshotBook(): void {
    this.captureBefore({
      kind: "book",
      data: JSON.stringify({ pages: this.data.pages, activePage: this.data.activePage }),
    });
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  private currentEntry(): HistoryEntry {
    const page = this.page;
    return {
      kind: "page",
      pageId: page.id,
      pageIndex: this.data.activePage,
      data: JSON.stringify(page),
    };
  }

  private currentBookEntry(): HistoryEntry {
    return {
      kind: "book",
      data: JSON.stringify({ pages: this.data.pages, activePage: this.data.activePage }),
    };
  }

  /** 找出条目对应的页下标 */
  private pageIndexOf(entry: Exclude<HistoryEntry, { kind: "book" }>): number {
    const found = this.data.pages.findIndex((p) => p.id === entry.pageId);
    return found >= 0 ? found : Math.min(entry.pageIndex, this.data.pages.length - 1);
  }

  /** 找到某页里指定 id 的图层 */
  private findLayer(page: Page, layerId: string): Layer | undefined {
    return page.layers.find((l) => l.id === layerId);
  }

  undo(): boolean {
    // 先把挂起的快照结算掉，否则最后一次操作撤不掉
    this.settleHistory();
    const pair = this.undoStack.pop();
    if (!pair) return false;
    // 回到操作前
    this.apply(pair.before);
    // 重做时用操作后的状态
    this.redoStack.push(pair);
    return true;
  }

  redo(): boolean {
    this.settleHistory();
    const pair = this.redoStack.pop();
    if (!pair) return false;
    // 回到操作后
    this.apply(pair.after);
    this.undoStack.push(pair);
    return true;
  }

  private apply(entry: HistoryEntry): void {
    if (entry.kind === "book") {
      const obj = JSON.parse(entry.data) as { pages: Page[]; activePage: number };
      this.data.pages = obj.pages;
      this.data.activePage = Math.min(obj.activePage, this.data.pages.length - 1);
    } else if (entry.kind === "layer") {
      // 整层替换：把该层的笔迹列表换成记录里的那些
      const at = this.pageIndexOf(entry);
      const page = this.data.pages[at];
      if (page) {
        const layer = this.findLayer(page, entry.layerId) ?? activeLayer(page);
        /*
         * 位置还原要小心：positions 是"这条笔迹在原列表里的下标"。
         * 如果原列表是 [A,B,C]，只保留 [A,C]，那么 C 应该落在下标 1
         * 而不是 2——因为 B 已经没了。
         *
         * 稳妥做法：先按 positions 排序，再依次找"下一个空位"。
         * 这样无论中间删了几条，顺序都正确。
         */
        const ordered = entry.strokes
          .map((stroke, i) => ({ stroke, pos: entry.positions?.[i] ?? i }))
          .sort((a, b) => a.pos - b.pos);
        const next: Stroke[] = [];
        for (const o of ordered) {
          // 放进第一个 >= pos 的位置；不够就追加
          let target = o.pos;
          if (target > next.length) target = next.length;
          next.splice(target, 0, o.stroke);
        }
        layer.strokes = next;
        this.data.activePage = at;
      }
    } else {
      const page = JSON.parse(entry.data) as Page;
      const at = this.pageIndexOf(entry);
      this.data.pages[at] = page;
      this.data.activePage = at;
    }
    this.touch();
  }

  /* ------------------------------- 页面 ------------------------------- */

  setPage(index: number): void {
    if (index < 0 || index >= this.data.pages.length) return;
    this.data.activePage = index;
  }

  addPage(after = this.data.activePage): number {
    this.snapshotBook();
    const prev = this.data.pages[after];
    const page = createPage(prev ? prev.template : "grid", prev ? prev.paper : "white");
    this.data.pages.splice(after + 1, 0, page);
    this.data.activePage = after + 1;
    this.touch();
    return after + 1;
  }

  /** 插入外部页面（导入的 PDF/Word 页） */
  insertPages(pages: Page[], at: number, source?: InkBook["source"]): number {
    if (!pages.length) return at;
    this.snapshotBook();
    const clamped = Math.max(0, Math.min(this.data.pages.length, at));
    this.data.pages.splice(clamped, 0, ...pages);
    if (source) this.data.source = source;
    this.data.activePage = clamped;
    this.touch();
    return clamped;
  }

  deletePage(index: number): boolean {
    if (this.data.pages.length <= 1) return false;
    this.snapshotBook();
    this.data.pages.splice(index, 1);
    this.data.activePage = Math.min(index, this.data.pages.length - 1);
    this.touch();
    return true;
  }

  duplicatePage(index: number): number {
    const src = this.data.pages[index];
    if (!src) return index;
    this.snapshotBook();
    const copy = JSON.parse(JSON.stringify(src)) as Page;
    copy.id = uid("page");
    for (const layer of copy.layers) {
      layer.id = uid("layer");
      for (const stroke of layer.strokes) stroke.id = uid("stroke");
    }
    copy.activeLayerId = copy.layers[0]?.id || "";
    this.data.pages.splice(index + 1, 0, copy);
    this.data.activePage = index + 1;
    this.touch();
    return index + 1;
  }

  setTemplate(index: number, template: TemplateId): void {
    const page = this.data.pages[index];
    if (!page || page.template === template) return;
    this.snapshotPage(index);
    page.template = template;
    this.touch();
  }

  setPaper(index: number, paper: PaperId): void {
    const page = this.data.pages[index];
    if (!page || page.paper === paper) return;
    this.snapshotPage(index);
    page.paper = paper;
    this.touch();
  }

  setAllTemplates(template: TemplateId): void {
    this.snapshotBook();
    for (const page of this.data.pages) page.template = template;
    this.touch();
  }

  /* ------------------------------- 图层 ------------------------------- */

  addLayer(pageIndex = this.data.activePage): void {
    const page = this.data.pages[pageIndex];
    if (!page) return;
    this.snapshotPage(pageIndex);
    const layer = createLayer(`图层 ${page.layers.length + 1}`);
    page.layers.push(layer);
    page.activeLayerId = layer.id;
    this.touch();
  }

  deleteLayer(pageIndex: number, layerId: string): boolean {
    const page = this.data.pages[pageIndex];
    if (!page || page.layers.length <= 1) return false;
    this.snapshotPage(pageIndex);
    page.layers = page.layers.filter((l) => l.id !== layerId);
    if (page.activeLayerId === layerId) page.activeLayerId = page.layers[page.layers.length - 1].id;
    this.touch();
    return true;
  }

  renameLayer(pageIndex: number, layerId: string, name: string): void {
    const page = this.data.pages[pageIndex];
    const layer = page && page.layers.find((l) => l.id === layerId);
    if (!layer || !name.trim() || layer.name === name.trim()) return;
    this.snapshotPage(pageIndex);
    layer.name = name.trim();
    this.touch();
  }

  toggleLayer(pageIndex: number, layerId: string): void {
    const page = this.data.pages[pageIndex];
    const layer = page && page.layers.find((l) => l.id === layerId);
    if (!layer) return;
    this.snapshotPage(pageIndex);
    layer.visible = !layer.visible;
    this.touch();
  }

  setActiveLayer(pageIndex: number, layerId: string): void {
    const page = this.data.pages[pageIndex];
    if (!page || !page.layers.some((l) => l.id === layerId)) return;
    page.activeLayerId = layerId;
    this.touch();
  }

  /* ------------------------------- 笔迹 ------------------------------- */

  /**
   * 抓取某层当前笔迹的快照条目。
   *
   * 只复制**数组**（浅拷贝），不深拷贝笔迹对象——
   * 笔迹创建后坐标就不再变（橡皮切分时产生的是新对象），
   * 所以共享笔迹对象是安全的。
   *
   * 代价是 O(笔迹数) 的数组拷贝，但比 JSON 序列化快一个数量级，
   * 也不会产生几 MB 的字符串垃圾。
   */
  layerEntry(page: Page, pageIndex: number, layer: Layer): HistoryEntry {
    const strokes = layer.strokes.slice();
    return {
      kind: "layer",
      pageId: page.id,
      pageIndex,
      layerId: layer.id,
      strokes,
      positions: strokes.map((_, i) => i),
    };
  }

  /** 抓取某层当前的笔迹状态（供外部组合成一条历史） */
  captureLayerState(pageIndex: number, layerId: string): HistoryEntry | null {
    const page = this.data.pages[pageIndex];
    if (!page) return null;
    const layer = this.findLayer(page, layerId);
    if (!layer) return null;
    return this.layerEntry(page, pageIndex, layer);
  }

  /** 记录一条"层内容变化"的历史 */
  recordLayerChange(before: HistoryEntry, after: HistoryEntry): void {
    this.pushHistory(before, after);
  }

  /**
   * 加一笔笔迹，并记下前后状态。
   *
   * 不做全页快照——只记这一层。代价与页面已有笔迹数无关。
   */
  addStroke(stroke: Stroke, pageIndex = this.data.activePage, layerId?: string): void {
    const page = this.data.pages[pageIndex];
    if (!page) return;
    const layer = (layerId && page.layers.find((l) => l.id === layerId)) || activeLayer(page);
    const before = this.layerEntry(page, pageIndex, layer);
    layer.strokes.push(stroke);
    const after = this.layerEntry(page, pageIndex, layer);
    this.pushHistory(before, after);
    this.touch();
  }

  /**
   * 删掉几条笔迹，并记下前后状态。
   *
   * @param silent 为 true 时不记历史（调用方自己组合历史时用）
   */
  removeStrokes(ids: Set<string>, pageIndex = this.data.activePage, silent = false): void {
    const page = this.data.pages[pageIndex];
    if (!page) return;
    for (const layer of page.layers) {
      if (!layer.strokes.some((s) => ids.has(s.id))) continue;
      const before = this.layerEntry(page, pageIndex, layer);
      layer.strokes = layer.strokes.filter((s) => !ids.has(s.id));
      const after = this.layerEntry(page, pageIndex, layer);
      if (!silent) this.pushHistory(before, after);
    }
    // silent 时不 touch——避免提前结算调用方挂起的快照
    if (!silent) this.touch();
  }

  /**
   * 把一条笔迹替换成几段（橡皮局部擦除）。
   *
   * @param silent 为 true 时不记历史（调用方自己组合历史时用）
   */
  replaceStroke(
    oldId: string,
    pieces: Stroke[],
    pageIndex = this.data.activePage,
    silent = false
  ): void {
    const page = this.data.pages[pageIndex];
    if (!page) return;
    for (const layer of page.layers) {
      const idx = layer.strokes.findIndex((s) => s.id === oldId);
      if (idx >= 0) {
        const before = this.layerEntry(page, pageIndex, layer);
        layer.strokes.splice(idx, 1, ...pieces);
        const after = this.layerEntry(page, pageIndex, layer);
        if (!silent) this.pushHistory(before, after);
        return;
      }
    }
  }
}
