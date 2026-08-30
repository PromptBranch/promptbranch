interface CommandLineSwitches {
  hasSwitch(name: string): boolean;
  appendSwitch(name: string, value?: string): void;
}

export function configureLinuxDisplayBackend(
  platform: NodeJS.Platform,
  commandLine: CommandLineSwitches,
): void {
  if (platform === "linux" && !commandLine.hasSwitch("ozone-platform")) {
    commandLine.appendSwitch("ozone-platform", "x11");
  }
}
