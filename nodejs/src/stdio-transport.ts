/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcess } from "node:child_process";
import {
    createMessageConnection,
    type MessageConnection,
    StreamMessageReader,
    StreamMessageWriter,
} from "vscode-jsonrpc/node.js";
import type { Transport } from "./transport.js";

/**
 * Gets the path to the copilot-core CLI binary.
 * Assumes copilot-core is available on PATH.
 */
export function getBundledCliPath(): string {
    return "copilot-core";
}

export interface StdioTransportOptions {
    cliPath?: string;
    cliArgs?: string[];
    cwd?: string;
    logLevel?: string;
    env?: Record<string, string | undefined>;
    githubToken?: string;
    useLoggedInUser?: boolean;
    onExit?: (code: number | null) => void;
}

/**
 * Transport that communicates with the Copilot CLI via stdin/stdout pipes.
 */
export class StdioTransport implements Transport {
    private cliProcess: ChildProcess | null = null;
    private _connection: MessageConnection | null = null;
    private forceStopping = false;
    private readonly opts: Required<
        Omit<StdioTransportOptions, "githubToken" | "useLoggedInUser" | "onExit">
    > &
        Pick<StdioTransportOptions, "githubToken" | "useLoggedInUser" | "onExit">;

    get connection(): MessageConnection | null {
        return this._connection;
    }

    constructor(options: StdioTransportOptions = {}) {
        this.opts = {
            cliPath: options.cliPath || getBundledCliPath(),
            cliArgs: options.cliArgs ?? [],
            cwd: options.cwd ?? process.cwd(),
            logLevel: options.logLevel || "debug",
            env: options.env ?? process.env,
            githubToken: options.githubToken,
            useLoggedInUser: options.useLoggedInUser,
            onExit: options.onExit,
        };
    }

    async start(): Promise<void> {
        await this.spawnCLI();
        this.connectStdio();
    }

    async stop(): Promise<Error[]> {
        const errors: Error[] = [];

        if (this._connection) {
            try {
                this._connection.dispose();
            } catch (error) {
                errors.push(
                    new Error(
                        `Failed to dispose connection: ${error instanceof Error ? error.message : String(error)}`
                    )
                );
            }
            this._connection = null;
        }

        if (this.cliProcess) {
            try {
                this.cliProcess.kill();
            } catch (error) {
                errors.push(
                    new Error(
                        `Failed to kill CLI process: ${error instanceof Error ? error.message : String(error)}`
                    )
                );
            }
            this.cliProcess = null;
        }

        return errors;
    }

    async forceStop(): Promise<void> {
        this.forceStopping = true;

        if (this._connection) {
            try {
                this._connection.dispose();
            } catch {
                // Ignore errors during force stop
            }
            this._connection = null;
        }

        if (this.cliProcess) {
            try {
                this.cliProcess.kill("SIGKILL");
            } catch {
                // Ignore errors
            }
            this.cliProcess = null;
        }
    }

    private spawnCLI(): Promise<void> {
        return new Promise((resolve, reject) => {
            const args = [
                ...this.opts.cliArgs,
                "--headless",
                "--no-auto-update",
                "--log-level",
                this.opts.logLevel,
                "--stdio",
            ];

            if (this.opts.githubToken) {
                args.push("--auth-token-env", "COPILOT_SDK_AUTH_TOKEN");
            }
            if (!this.opts.useLoggedInUser) {
                args.push("--no-auto-login");
            }

            const envWithoutNodeDebug = { ...this.opts.env };
            delete envWithoutNodeDebug.NODE_DEBUG;
            if (this.opts.githubToken) {
                envWithoutNodeDebug.COPILOT_SDK_AUTH_TOKEN = this.opts.githubToken;
            }

            const stdioConfig: ["pipe", "pipe", "pipe"] = ["pipe", "pipe", "pipe"];

            this.cliProcess = spawn(this.opts.cliPath, args, {
                stdio: stdioConfig,
                cwd: this.opts.cwd,
                env: envWithoutNodeDebug,
            });

            let resolved = false;

            // For stdio mode, we're ready immediately after spawn
            resolved = true;
            resolve();

            this.cliProcess.stderr?.on("data", (data: Buffer) => {
                const lines = data.toString().split("\n");
                for (const line of lines) {
                    if (line.trim()) {
                        process.stderr.write(`[CLI subprocess] ${line}\n`);
                    }
                }
            });

            this.cliProcess.on("error", (error) => {
                if (!resolved) {
                    resolved = true;
                    reject(new Error(`Failed to start CLI server: ${error.message}`));
                }
            });

            this.cliProcess.on("exit", (code) => {
                if (!resolved) {
                    resolved = true;
                    reject(new Error(`CLI server exited with code ${code}`));
                } else {
                    this.opts.onExit?.(code);
                }
            });

            setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    reject(new Error("Timeout waiting for CLI server to start"));
                }
            }, 10000);
        });
    }

    private connectStdio(): void {
        if (!this.cliProcess) {
            throw new Error("CLI process not started");
        }

        this.cliProcess.stdin?.on("error", (err) => {
            if (!this.forceStopping) {
                throw err;
            }
        });

        this._connection = createMessageConnection(
            new StreamMessageReader(this.cliProcess.stdout!),
            new StreamMessageWriter(this.cliProcess.stdin!)
        );

        this._connection.listen();
    }
}
