export interface CliArgs {
  service?: string;
  verbose: boolean;
  minimized: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { service: undefined, verbose: false, minimized: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--verbose' || a === '-v') args.verbose = true;
    else if (a === '--minimized') args.minimized = true;
    else if (a.startsWith('--service=')) args.service = a.slice('--service='.length);
    else if (a === '--service' && i + 1 < argv.length) args.service = argv[++i];
  }
  return args;
}
