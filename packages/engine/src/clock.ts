export class VirtualClock {
  #virtual: number;
  #real: number;
  #listeners: ((time: Date) => void)[] = [];
  readonly #realNow: () => number;

  constructor(start: string | Date, realNow: () => number = () => performance.now()) {
    this.#realNow = realNow;
    this.#virtual = new Date(start).getTime();
    this.#real = realNow();
    if (Number.isNaN(this.#virtual)) throw new Error("Invalid virtual clock start time");
  }

  now(): Date {
    return new Date(this.#virtual + (this.#realNow() - this.#real));
  }

  anchor(time: string | Date): void {
    this.#virtual = new Date(time).getTime();
    this.#real = this.#realNow();
    const now = this.now();
    for (const listener of this.#listeners) listener(now);
  }

  onAnchor(listener: (time: Date) => void): void {
    this.#listeners.push(listener);
  }
}
