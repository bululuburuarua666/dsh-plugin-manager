/**
 * No-shell package-manager runner: the deployment's own pnpm JavaScript entry
 * is resolved from the trusted `npm_execpath` environment and executed through
 * `process.execPath` with a fixed argument list — never a command string,
 * `exec()`, or a shell.
 */
/** How long one package-manager invocation may run. */
export declare const PACKAGE_MANAGER_TIMEOUT_MS = 600000;
/** Resolve the deployment's pnpm JavaScript entry; null when unusable. */
export declare function resolvePnpmEntry(env?: NodeJS.ProcessEnv): string | null;
/** Run one pnpm invocation with a fixed argv inside the profile directory. */
export declare function runPnpm(args: readonly string[], cwd: string, env?: NodeJS.ProcessEnv, timeoutMs?: number): Promise<void>;
//# sourceMappingURL=package-runner.d.ts.map