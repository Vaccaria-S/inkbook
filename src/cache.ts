/**
 * 位图 LRU 缓存：给底图这类"按需加载的大图"一个内存上限。
 *
 * 为什么不能直接用 Map 存着？
 * 一份 300 页的 PDF，每页 A4@2x 渲染出来约 1588×2246×4 ≈ 14MB。
 * 全部缓存 = 4GB+，浏览器直接崩。
 *
 * 所以这里按**字节预算**淘汰，而不是按条数：
 * 超过预算就淘汰最久没用的那些，并且调用 close() 真正把
 * GPU 显存还回去（ImageBitmap 不 close 的话显存不会立刻释放）。
 */

/** 缓存条目 */
interface Entry {
  bitmap: ImageBitmap;
  /** 占用的字节数 */
  bytes: number;
  /** 最后一次访问的时间戳 */
  touched: number;
  /**
   * 位图的像素宽度。
   *
   * 底图需要知道自己有多清晰——屏幕放大后要重新渲染更高分辨率的版本，
   * 所以缓存条目要记住自己渲染时的宽度。
   */
  width: number;
}

export interface BitmapCacheOptions {
  /** 字节预算，默认 192MB */
  budget?: number;
}

export class BitmapCache {
  private map = new Map<string, Entry>();
  private bytes = 0;
  private budget: number;
  private clock = 0;

  constructor(opts: BitmapCacheOptions = {}) {
    this.budget = opts.budget ?? 192 * 1024 * 1024;
  }

  get size(): number {
    return this.map.size;
  }

  get usedBytes(): number {
    return this.bytes;
  }

  get budgetBytes(): number {
    return this.budget;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  /** 取一张位图；命中会刷新它的新鲜度 */
  get(key: string): ImageBitmap | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    e.touched = ++this.clock;
    return e.bitmap;
  }

  /**
   * 取完整条目（含分辨率信息）。
   *
   * 底图要判断"缓存里的这张够不够清晰"，
   * 光看有没有这张图不够，还得知道它多宽。
   */
  getEntry(key: string): Entry | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    e.touched = ++this.clock;
    return e;
  }

  /**
   * 放一张位图。
   * 如果它本身就超过预算，就不缓存（但仍然返回给调用方使用）。
   */
  set(key: string, bitmap: ImageBitmap, width?: number): void {
    const existing = this.map.get(key);
    if (existing) {
      this.bytes -= existing.bytes;
      existing.bitmap.close();
      this.map.delete(key);
    }
    const bytes = bitmap.width * bitmap.height * 4;
    if (bytes > this.budget) {
      // 单张就超预算：直接还回去，不进缓存
      bitmap.close();
      return;
    }
    this.map.set(key, {
      bitmap,
      bytes,
      touched: ++this.clock,
      width: width ?? bitmap.width,
    });
    this.bytes += bytes;
    this.evict();
  }

  /** 淘汰到预算以内 */
  private evict(): void {
    if (this.bytes <= this.budget) return;
    // 找出最久没用的
    let oldestKey: string | null = null;
    let oldest = Infinity;
    for (const [k, e] of this.map) {
      if (e.touched < oldest) {
        oldest = e.touched;
        oldestKey = k;
      }
    }
    if (!oldestKey) return;
    const e = this.map.get(oldestKey)!;
    this.map.delete(oldestKey);
    this.bytes -= e.bytes;
    e.bitmap.close();
    this.evict();
  }

  delete(key: string): void {
    const e = this.map.get(key);
    if (!e) return;
    this.map.delete(key);
    this.bytes -= e.bytes;
    e.bitmap.close();
  }

  /** 清空并释放所有显存 */
  clear(): void {
    for (const e of this.map.values()) e.bitmap.close();
    this.map.clear();
    this.bytes = 0;
  }

  /** 只删掉 key 前缀匹配的（换文档时用） */
  clearPrefix(prefix: string): void {
    for (const k of Array.from(this.map.keys())) {
      if (k.startsWith(prefix)) this.delete(k);
    }
  }
}

/**
 * 同一个 key 的异步加载去重。
 *
 * 没有它的话，快速翻页会让同一页并发发起多次渲染——
 * pdf.js 每次都要重新光栅化，白白浪费 CPU。
 */
export class AsyncCache<T> {
  private values = new Map<string, T>();
  private pending = new Map<string, Promise<T>>();

  get(key: string): T | undefined {
    return this.values.get(key);
  }

  has(key: string): boolean {
    return this.values.has(key);
  }

  set(key: string, value: T): void {
    this.values.set(key, value);
  }

  /** 取缓存；没有就调 loader，loader 返回的 Promise 会被复用 */
  async load(key: string, loader: () => Promise<T>): Promise<T> {
    const hit = this.values.get(key);
    if (hit !== undefined) return hit;
    const inflight = this.pending.get(key);
    if (inflight) return inflight;
    const p = loader()
      .then((v) => {
        this.values.set(key, v);
        this.pending.delete(key);
        return v;
      })
      .catch((e) => {
        this.pending.delete(key);
        throw e;
      });
    this.pending.set(key, p);
    return p;
  }

  delete(key: string): void {
    this.values.delete(key);
    this.pending.delete(key);
  }

  clear(): void {
    this.values.clear();
    this.pending.clear();
  }

  get size(): number {
    return this.values.size;
  }
}
