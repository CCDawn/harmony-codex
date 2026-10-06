// The viewer has an independent lifetime from the voice call.
export class CompanionComputerLifecycle {
  static foreground: boolean = true;
  static listener: ((foreground: boolean) => void) | null = null;

  static setForeground(foreground: boolean): void {
    CompanionComputerLifecycle.foreground = foreground;
    CompanionComputerLifecycle.listener?.(foreground);
  }
}
