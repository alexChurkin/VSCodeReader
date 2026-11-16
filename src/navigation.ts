import type { Locator } from './book';

const equal = (a: Locator, b: Locator) => a.chapter === b.chapter && a.offset === b.offset;
export class NavigationHistory {
  private back: Locator[] = [];
  private forward: Locator[] = [];
  get canGoBack(): boolean { return this.back.length > 0; }
  get canGoForward(): boolean { return this.forward.length > 0; }
  record(from: Locator, to: Locator): void {
    if (equal(from, to)) return;
    this.push(this.back, from); this.forward = [];
  }
  travel(current: Locator, direction: number): Locator | undefined {
    const source = direction < 0 ? this.back : this.forward;
    const destination = direction < 0 ? this.forward : this.back;
    const target = source.pop();
    if (target) this.push(destination, current);
    return target;
  }
  private push(stack: Locator[], position: Locator): void {
    if (!stack.length || !equal(stack[stack.length - 1], position)) stack.push({ ...position });
    if (stack.length > 100) stack.shift();
  }
}
