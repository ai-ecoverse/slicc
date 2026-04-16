/**
 * Fail closed when execution is expected to run inside defense async context.
 */
export declare function assertDefenseContext(requireDefenseContext: boolean | undefined, component: string, phase: string): void;
/**
 * Guard an async boundary by checking context both before and after await.
 */
export declare function awaitWithDefenseContext<T>(requireDefenseContext: boolean | undefined, component: string, phase: string, op: () => Promise<T>): Promise<T>;
/**
 * Bind a callback to the current defense async context and assert defense
 * invariants on callback entry.
 */
export declare function bindDefenseContextCallback<TArgs extends unknown[], TResult>(requireDefenseContext: boolean | undefined, component: string, phase: string, callback: (...args: TArgs) => TResult): (...args: TArgs) => TResult;
