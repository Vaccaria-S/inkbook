import {
  activeLayer,
  createLayer,
  createPage,
  type InkBook,
  type Layer,
  type Outline,
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
  /**
   * 整本快照。
   *
   * 顺带带上 `outlines`：加页/删页会挪动目录里的页码，
   * 撤销这一步时要把目录一起还原，否则「撤销删页」之后目录指错了页。
   * 目录只有几十字节，附带的代价可以忽略。
   */
  | { kind: "book"; data: string; outlines?: Outline[] }
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
    }
  /**
   * 页顺序（重排）。
   *
   * 只存页 id 的排列，**不存整本快照**：重排只动数组顺序，每页的
   * 笔迹/图层对象原样不动，按 id 还原即可。整本快照会把几十 MB
   * 复制两遍，而且撤销后页对象变成新副本，后面记录在「旧页对象 id」上的
   * 笔迹增量历史就对不上了。
   *
   * apply 时把 data.pages 按 order 重排；order 里没出现的页（理论上不会
   * 有，防御性兜底）保持原有相对顺序补在末尾。
   *
   * 顺带带上 `outlines`：换序会让目录里的页下标失效（目录存的是下标），
   * 不带着一起还原的话，撤销换序之后目录会指着别的页。
   */
  | { kind: "order"; order: string[]; outlines?: Outline[] }
  /**
   * 本子目录（用户自己加的条目：名字 + 指向的页）。
   *
   * **单独一种条目**，不套用整本快照：
   *   · 整本快照是几十 MB 的 pages（857 页的本子），加一条目录就拷一遍
   *     整本书，代价完全不成比例；
   *   · 目录项本身只有几十字节（id + 名字 + 一个页下标），
   *     整份拷一份进历史条目既便宜又简单。
   *
   * `outlines` 为 undefined 表示「原来没有目录」——还原时要把这个字段
   * 整个去掉，而不是留一个空数组（空数组会被写回文件，多一个字段）。
   */
  | { kind: "outline"; outlines?: Outline[] };

/** 撤销栈最多保留多少条 */
const MAX_HISTORY = 60;

export class BookStore {
  data: InkBook;
  onChange: () => void = () => {};
  /**
   * 页顺序版本号：每次页顺序真的变化（movePage / 应用 order 历史）就 +1。
   *
   * 页数不变但顺序变了时，编辑器/侧栏靠它判断「必须重建 DOM」——
   * 只比 pageCount 会漏掉重排，导致主视图第 3 页还显示第 1 页的内容。
   */
  pageOrderRev = 0;
  /**
   * 目录版本号：目录内容真的变了就 +1。
   *
   * 侧栏靠它决定「要不要重建目录 DOM」。只比目录条数不够——
   * 改名、挪位置条数不变但内容变了；删一条和加一条条数相同但内容不同。
   * 版本号让 UI 一次比较就知道要不要重建，代价是 O(1)。
   */
  outlineRev = 0;
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
  /** 挂起快照只可能是页/整本/目录（层与页顺序都是即改即记，不挂起） */
  private pendingBefore:
    | Extract<HistoryEntry, { kind: "page" } | { kind: "book" } | { kind: "outline" }>
    | null = null;

  private captureBefore(
    entry: Extract<HistoryEntry, { kind: "page" } | { kind: "book" } | { kind: "outline" }>
  ): void {
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
              outlines: this.outlineSnapshot(),
            }
          : before.kind === "outline"
            ? { kind: "outline", outlines: this.outlineSnapshot() }
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
      // 带上目录：加页/删页会挪目录里的页码，撤销这一步要一起还原
      outlines: this.outlineSnapshot(),
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

  /**
   * 找出条目对应的页下标（只看有 pageId 的条目）
   */
  private pageIndexOf(
    entry: Exclude<HistoryEntry, { kind: "book" } | { kind: "order" } | { kind: "outline" }>
  ): number {
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
      /*
       * 目录一起还原：加页/删页会挪目录里的页码，
       * 不还原的话「撤销删页」之后目录还指着错位的页。
       * undefined = 当时没有目录 → 字段整个去掉。
       */
      this.data.outlines = entry.outlines && entry.outlines.length
        ? entry.outlines.map((o) => ({ ...o }))
        : undefined;
      this.bumpOutlineRev();
      // 整本快照也可能带来不同的页顺序（页数相同的情况），一并让 DOM 重建
      this.pageOrderRev += 1;
    } else if (entry.kind === "order") {
      /*
       * 按 id 重排。用 Map 而不是对每个 id 做 findIndex：
       * 857 页时 findIndex 是 O(n²)，撤销一次要扫几十万次。
       * 找不到的页（如历史与当前页集合不一致）保持原相对顺序补在末尾。
       */
      const byId = new Map(this.data.pages.map((p) => [p.id, p] as const));
      const activeId = this.data.pages[this.data.activePage]?.id;
      const next: Page[] = [];
      for (const id of entry.order) {
        const page = byId.get(id);
        if (!page) continue;
        next.push(page);
        byId.delete(id);
      }
      for (const page of this.data.pages) {
        if (byId.has(page.id)) next.push(page);
      }
      this.data.pages = next;
      // 当前页跟着自己的 id 走：撤销换序后用户视野里的还是同一页
      const at = activeId ? next.findIndex((p) => p.id === activeId) : -1;
      this.data.activePage =
        at >= 0 ? at : Math.min(this.data.activePage, Math.max(0, next.length - 1));
      // 目录一起还原：换序会让目录里的页下标失效
      this.data.outlines = entry.outlines && entry.outlines.length
        ? entry.outlines.map((o) => ({ ...o }))
        : undefined;
      this.bumpOutlineRev();
      this.pageOrderRev += 1;
    } else if (entry.kind === "outline") {
      /*
       * 目录：整份还原。
       *   · 记录是 undefined → 原来没有目录 → 把字段整个去掉（不留空数组）；
       *   · 记录有值 → 整份替换（拷贝一份，别让历史条目和当前数据共用数组，
       *     否则撤销两次会把「after」也一起改掉）。
       */
      this.data.outlines =
        entry.outlines && entry.outlines.length
          ? entry.outlines.map((o) => ({ ...o }))
          : undefined;
      this.bumpOutlineRev();
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
    // 后面所有页下标 +1 → 目录里指向它们的页码也要 +1（不然指错页了）
    this.shiftOutlines(after + 1, 1);
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
    // 插入的页往后挪 → 目录里指向它们后面的页码要 +pages.length
    this.shiftOutlines(clamped, pages.length);
    if (source) this.data.source = source;
    this.data.activePage = clamped;
    this.touch();
    return clamped;
  }

  deletePage(index: number): boolean {
    if (this.data.pages.length <= 1) return false;
    this.snapshotBook();
    this.data.pages.splice(index, 1);
    // 后面所有页下标 -1 → 目录跟着挪；正好指向被删页的那条夹到删掉的位置
    this.shiftOutlines(index, -1);
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
    // 复制页插在中间 → 后面的页下标 +1，目录跟着挪
    this.shiftOutlines(index + 1, 1);
    this.data.activePage = index + 1;
    this.touch();
    return index + 1;
  }

  /**
   * 调整页顺序：把 from 页挪到 to（目标下标 = 移动完成后的最终位置）。
   *
   * 只重排 pages 数组，并记一条「页顺序」历史（存页 id 顺序，不复制页内容）。
   * 页 id 才是身份，下标在重排后全变了，所以历史和当前页都用 id 还原。
   *
   * @returns 是否真的移动了（越界或原地不动返回 false，不记历史）
   */
  movePage(from: number, to: number): boolean {
    const n = this.data.pages.length;
    if (!Number.isInteger(from) || !Number.isInteger(to)) return false;
    if (from < 0 || from >= n || to < 0 || to >= n || from === to) return false;
    const activeId = this.data.pages[this.data.activePage]?.id;
    const before = this.data.pages.map((p) => p.id);
    // 目录指向的是「哪一页」——换序时跟着那一页走（见 types.ts 的 Outline 注释）：
    // 先记下每条目录当时指的是哪个页 id，换完序再换算成新下标。
    const outlineBefore = this.outlineSnapshot();
    const pageIdsBefore = new Map(outlineBefore?.map((o) => [o.id, this.data.pages[o.page]?.id ?? ""]));
    const [page] = this.data.pages.splice(from, 1);
    this.data.pages.splice(to, 0, page);
    // 当前页跟着自己的 id 走：挪的不是当前页时，用户视野不跳
    const at = activeId ? this.data.pages.findIndex((p) => p.id === activeId) : -1;
    this.data.activePage = at >= 0 ? at : Math.min(this.data.activePage, n - 1);
    // 目录换算成新下标（按页 id 找，找不到就夹住）
    if (outlineBefore) {
      this.data.outlines = outlineBefore.map((o) => {
        const pid = pageIdsBefore.get(o.id) ?? "";
        const idx = pid ? this.data.pages.findIndex((p) => p.id === pid) : -1;
        return {
          id: o.id,
          title: o.title,
          page: idx >= 0 ? idx : Math.max(0, Math.min(this.data.pages.length - 1, o.page)),
        };
      });
      this.bumpOutlineRev();
    }
    this.pageOrderRev += 1;
    this.pushHistory(
      { kind: "order", order: before, outlines: outlineBefore },
      { kind: "order", order: this.data.pages.map((p) => p.id), outlines: this.outlineSnapshot() }
    );
    this.touch();
    return true;
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

  /* ------------------------------- 目录 ------------------------------- */

  /**
   * 目录的当前状态（进历史条目的那一份）。
   *
   * undefined = 本子**没有**目录（字段整个不存在）。
   * 空数组 = 有目录但一条没有——这两种在文件里是不同的形态：
   * 前者不写字段，后者写 `"outlines": []`。normalizeBook 的约定是
   * 「空目录不写回字段」，所以这里保持一致：没有条目时给 undefined。
   */
  private outlineSnapshot(): Outline[] | undefined {
    const list = this.data.outlines;
    if (!list || !list.length) return undefined;
    return list.map((o) => ({ ...o }));
  }

  /** 目录的当前列表（UI 用；没有目录时给空数组，不给 undefined） */
  get outlines(): Outline[] {
    return this.data.outlines ?? [];
  }

  /**
   * 拍一份「操作前」的目录状态。
   *
   * 目录改动**不用** snapshotBook：整本快照是几十 MB 的 pages，
   * 加一条目录就拷一遍整本书，代价完全不成比例。
   * 目录项只有几十字节，整份拷进一条专用历史条目既便宜又简单。
   */
  snapshotOutline(): void {
    this.captureBefore({ kind: "outline", outlines: this.outlineSnapshot() });
  }

  /**
   * 目录内容真的变了 → 版本号 +1（UI 靠它决定重建 DOM）。
   */
  private bumpOutlineRev(): void {
    this.outlineRev += 1;
  }

  /**
   * 目录指向的页下标 → 有效下标。
   *
   * 页被删了 / 目录指向的页超范围时夹住（夹到最后一页 / 第一页），
   * 不抛异常——跳到「最接近的那一页」比报错好。
   */
  clampOutlinePage(page: number): number {
    const n = this.data.pages.length;
    if (!n) return 0;
    const p = Math.trunc(Number(page));
    if (!Number.isFinite(p)) return 0;
    return Math.max(0, Math.min(n - 1, p));
  }

  /**
   * 加一条目录。
   *
   * @param title 名字（空 / 全空白视为无效，不加）
   * @param page 指向的页（0 起下标；越界会夹到有效范围）
   * @returns 新目录项的 id；无效时不加，返回 ""
   */
  addOutline(title: string, page: number): string {
    const name = String(title ?? "").trim();
    if (!name) return "";
    const at = this.clampOutlinePage(page);
    const id = uid("outline");
    this.snapshotOutline();
    const list = (this.data.outlines ?? []).slice();
    list.push({ id, title: name, page: at });
    this.data.outlines = list;
    this.bumpOutlineRev();
    this.touch();
    return id;
  }

  /**
   * 改目录项的名字。
   *
   * @returns 是否真的改了（找不到 / 名字没变 → false，不记历史）
   */
  renameOutline(id: string, title: string): boolean {
    const name = String(title ?? "").trim();
    if (!name) return false;
    const item = this.data.outlines?.find((o) => o.id === id);
    if (!item || item.title === name) return false;
    this.snapshotOutline();
    item.title = name;
    this.bumpOutlineRev();
    this.touch();
    return true;
  }

  /**
   * 改目录项指向的页。
   *
   * @param page 0 起下标；越界夹到有效范围
   * @returns 是否真的改了
   */
  setOutlinePage(id: string, page: number): boolean {
    const item = this.data.outlines?.find((o) => o.id === id);
    if (!item) return false;
    const at = this.clampOutlinePage(page);
    if (item.page === at) return false;
    this.snapshotOutline();
    item.page = at;
    this.bumpOutlineRev();
    this.touch();
    return true;
  }

  /**
   * 一次改完目录项的名字和页码（编辑弹窗的提交）。
   *
   * 走**一条**历史，而不是改名/改页各记一条——
   * 否则用户在弹窗里改一次（名字 + 页码），撤销要按两下才回得去，
   * 撤销一次反而落在「名字改了、页码没改」的中间态上。
   *
   * @returns 是否真的改了（都没变 → false，不记历史）
   */
  updateOutline(id: string, title: string, page: number): boolean {
    const name = String(title ?? "").trim();
    const item = this.data.outlines?.find((o) => o.id === id);
    if (!item || !name) return false;
    const at = this.clampOutlinePage(page);
    if (item.title === name && item.page === at) return false;
    this.snapshotOutline();
    item.title = name;
    item.page = at;
    this.bumpOutlineRev();
    this.touch();
    return true;
  }

  /**
   * 删除一条目录。
   *
   * @returns 是否真的删了
   */
  removeOutline(id: string): boolean {
    const list = this.data.outlines;
    if (!list || !list.some((o) => o.id === id)) return false;
    this.snapshotOutline();
    const next = list.filter((o) => o.id !== id);
    // 删到一条不剩 → 字段整个去掉（和 normalizeBook「空目录不写回」一致）
    this.data.outlines = next.length ? next : undefined;
    this.bumpOutlineRev();
    this.touch();
    return true;
  }

  /**
   * 把一条目录往前/往后挪。
   *
   * @param delta 位移（正数往后，负数往前）
   * @returns 是否真的挪了（越界 / 原地不动 → false，不记历史）
   */
  moveOutline(id: string, delta: number): boolean {
    const list = this.data.outlines;
    if (!list) return false;
    const at = list.findIndex((o) => o.id === id);
    if (at < 0) return false;
    const to = at + Math.trunc(Number(delta) || 0);
    if (to < 0 || to >= list.length || to === at) return false;
    this.snapshotOutline();
    const next = list.slice();
    const [item] = next.splice(at, 1);
    next.splice(to, 0, item);
    this.data.outlines = next;
    this.bumpOutlineRev();
    this.touch();
    return true;
  }

  /**
   * 页的位置变了之后，目录里的页码跟着挪。
   *
   * 目录存的是**页下标**，不是页 id——页一动，下标就变（这是下标语义的
   * 固有局限，与缩略图长按菜单一致，见 types.ts 的 Outline 注释）。
   * 这里让目录尽量还指着同一页内容：
   *   · 在 at 处**插入**一页：at 及其之后的页整体后移一位，
   *     指向它们的目录也 +1；
   *   · 删掉 at 这一页：at 之后的页整体前移一位，指向它们的目录 -1；
   *     正好指向被删页的那条 → 指向「原来下一页」现在所在的位置
   *     （删的是最后一页就指向前一页）。
   *
   * 为什么不干脆删掉那条目录：目录是用户手写的路标，删页是顺手的事，
   * 顺手把路标也删了等于替用户做决定。夹住之后目录还在，指向的是
   * 语义上最接近的那一页。
   */
  private shiftOutlines(insertAt: number, delta: number): void {
    const list = this.data.outlines;
    if (!list || !list.length) return;
    const n = this.data.pages.length;
    this.data.outlines = list.map((o) => {
      let page = o.page;
      if (delta > 0) {
        // 在 insertAt 处插入：insertAt 及其之后的 +1
        if (page >= insertAt) page += delta;
      } else if (delta < 0) {
        // 删掉 insertAt 这一页：insertAt 之后的 -1
        if (page > insertAt) page += delta;
        else if (page === insertAt) page = Math.min(insertAt, Math.max(0, n - 1));
      }
      return { ...o, page };
    });
    this.bumpOutlineRev();
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
