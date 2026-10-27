/**
 * 两层选择器 UI（设计第 7 章）：
 * - TUI：ctx.ui.custom() 自绘（Input + SelectList + fuzzyFilter，空格切换搜索模式，对齐 /mcp 风格）；
 * - RPC：ctx.ui.select 全量列表降级（RPC 协议不支持自定义组件）；
 * - 无 UI：由调用方按 7.2 三档策略处理（工具路径 isError / 命令路径静默）。
 * 运行时依赖 pi-tui（jiti alias 保证可解析）；纯编排函数便于降级测试。
 */
import { Input, SelectList, fuzzyFilter, type SelectItem } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

/** 调用方注入的 UI 能力子集（与 pi ExtensionUIContext 结构兼容）。 */
export interface PickerUI {
  mode: string;
  hasUI: boolean;
  custom?: <T>(
    factory: (tui: TUI, theme: Theme, keybindings: unknown, done: (result: T) => void) => Component & { dispose?(): void },
  ) => Promise<T>;
  select?: (title: string, options: string[]) => Promise<string | undefined>;
  confirm?: (title: string, message: string) => Promise<boolean>;
  notify?: (message: string, type?: "info" | "warning" | "error") => void;
}

/** 自建 SelectList 主题（与 pi 内建 getSelectListTheme 同款配色）。 */
function buildSelectListTheme(theme: Theme) {
  return {
    selectedPrefix: (text: string) => theme.fg("accent", text),
    selectedText: (text: string) => theme.fg("accent", text),
    description: (text: string) => theme.fg("muted", text),
    scrollInfo: (text: string) => theme.fg("muted", text),
    noMatch: (text: string) => theme.fg("muted", text),
  };
}

/** 空格键的原始终端字节。 */
const SPACE = " ";

/** TUI 单层选择组件：标题 + 搜索行 + 列表 + 按键提示。 */
class LayerPickerComponent implements Component {
  private list: SelectList;
  private input = new Input();
  private searchMode = false;
  private query = "";

  constructor(
    private readonly title: string,
    private readonly items: string[],
    private readonly theme: Theme,
    private readonly done: (result: string | undefined) => void,
  ) {
    this.list = this.buildList("");
  }

  /** 按当前过滤词重建列表实例（SelectList 条目不可变，重建成本低）。 */
  private buildList(query: string): SelectList {
    const filtered = query === "" ? this.items : fuzzyFilter(this.items, query, (item) => item);
    const selectItems: SelectItem[] = filtered.map((name) => ({ value: name, label: name }));
    const list = new SelectList(
      selectItems.length > 0 ? selectItems : [{ value: "", label: "(无匹配项)" }],
      Math.min(10, Math.max(1, selectItems.length)),
      buildSelectListTheme(this.theme),
    );
    list.onSelect = (item) => {
      if (item.value !== "") {
        this.done(item.value);
      }
    };
    list.onCancel = () => this.done(undefined);
    return list;
  }

  /** pi-tui Component 契约：本组件为纯重绘渲染，无需失效处理。 */
  invalidate(): void {
    // 无内部缓存需要失效
  }

  render(_width: number): string[] {
    const lines: string[] = [];
    lines.push(this.theme.fg("accent", this.title));
    if (this.searchMode) {
      lines.push(this.theme.fg("muted", "搜索（空格退出）: ") + this.input.getValue() + "▏");
    } else {
      lines.push(this.theme.fg("muted", "空格进入搜索 · ↑/↓ 选择 · Enter 确认 · ESC 取消"));
    }
    lines.push(...this.list.render(_width));
    return lines;
  }

  handleInput(data: string): void {
    if (data === SPACE && !this.searchMode) {
      this.searchMode = true;
      return;
    }
    if (this.searchMode) {
      if (data === SPACE) {
        this.searchMode = false;
        return;
      }
      if (data === "\x1b") {
        // 搜索模式中 ESC：退出搜索并恢复全列表（层不取消，再次 ESC 才取消层）
        this.searchMode = false;
        this.query = "";
        this.input.setValue("");
        this.list = this.buildList("");
        return;
      }
      this.input.handleInput(data);
      const nextQuery = this.input.getValue();
      if (nextQuery !== this.query) {
        this.query = nextQuery;
        this.list = this.buildList(this.query);
      }
      return;
    }
    this.list.handleInput(data);
  }
}

/** TUI/RPC 通用的单层选择；无 UI 返回 undefined（由调用方降级）。 */
export async function pickOne(ui: PickerUI, title: string, items: string[]): Promise<string | undefined> {
  if (items.length === 0) {
    return undefined;
  }
  if (ui.mode === "tui" && typeof ui.custom === "function") {
    return ui.custom<string | undefined>((_tui, theme, _keybindings, done) => new LayerPickerComponent(title, items, theme, done));
  }
  if (typeof ui.select === "function") {
    return ui.select(title, items);
  }
  return undefined;
}

/** 二次确认（7.1：database 选中后强制确认，用户原始需求）。 */
export async function confirmSelection(ui: PickerUI, connection: string, database: string): Promise<boolean> {
  if (typeof ui.confirm !== "function") {
    return true;
  }
  return ui.confirm("确认使用", `连接：${connection}\ndatabase：${database}`);
}
