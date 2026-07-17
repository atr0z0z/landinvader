/**
 * Минимальная бинарная min-куча для пар (индекс клетки, приоритет).
 *
 * Зачем своя: волне атаки нужно тысячи раз за секунду доставать
 * «ближайшую к цели» клетку. Массив с сортировкой — O(n log n) на тик,
 * куча — O(log n) на операцию. Зависимость ради 40 строк не стоит того.
 *
 * Храним данные в двух плоских массивах (а не в объектах {index, priority}) —
 * меньше аллокаций и нагрузки на GC в горячем цикле.
 */
export class MinHeap {
  private items: number[] = [];
  private priorities: number[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: number, priority: number): void {
    this.items.push(item);
    this.priorities.push(priority);
    this.bubbleUp(this.items.length - 1);
  }

  /** Достаёт элемент с минимальным приоритетом. Пусто → undefined. */
  pop(): number | undefined {
    const n = this.items.length;
    if (n === 0) return undefined;

    const top = this.items[0];
    const lastItem = this.items.pop()!;
    const lastPriority = this.priorities.pop()!;

    if (n > 1) {
      this.items[0] = lastItem;
      this.priorities[0] = lastPriority;
      this.bubbleDown(0);
    }
    return top;
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.priorities[i]! >= this.priorities[parent]!) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  private bubbleDown(i: number): void {
    const n = this.items.length;
    for (;;) {
      const left = i * 2 + 1;
      const right = left + 1;
      let smallest = i;
      if (left < n && this.priorities[left]! < this.priorities[smallest]!) smallest = left;
      if (right < n && this.priorities[right]! < this.priorities[smallest]!) smallest = right;
      if (smallest === i) break;
      this.swap(i, smallest);
      i = smallest;
    }
  }

  private swap(a: number, b: number): void {
    [this.items[a], this.items[b]] = [this.items[b]!, this.items[a]!];
    [this.priorities[a], this.priorities[b]] = [this.priorities[b]!, this.priorities[a]!];
  }
}
