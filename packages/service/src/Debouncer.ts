export class Debouncer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private waitTime: number;

  constructor(waitTime: number) {
    this.waitTime = waitTime;
  }

  public debounce<T extends (...args: any[]) => void>(callback: T, ...args: Parameters<T>): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }

    this.timer = setTimeout(() => callback(...args), this.waitTime);
  }
}
