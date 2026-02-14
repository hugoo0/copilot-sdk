/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcess } from "node:child_process";
import { Socket } from "node:net";
import {
    createMessageConnection,
    type MessageConnection,
    StreamMessageReader,
    StreamMessageWriter,
} from "vscode-jsonrpc/node.js";
import type { Transport } from "./transport.js";
import { getBundledCliPath } from "./stdio-transport.js";

export interface TcpTransportOptions {
    cliPath?: string;
    cliArgs?: string[];
    cwd?: string;
    logLevel?: string;
    env?: Record<string, string | undefined>;
    githubToken?: string;
    useLoggedInUser?: boolean;
    port?: number;
    host?: string;
    isExternalServer?: boolean;
    onExit?: (code: number | null) => void;
}

/**
 * Parse CLI URL into host and port.
 * Supports formats: "host:port", "http://host:port", "https://host:port", or just "port"
 */
export function parseCliUrl(url: string): { host: string; port: number } {
    let cleanUrl = url.replace(/^https?:\/\//, "");

    if (/^\d+$/.test(cleanUrl)) {
        return { host: "localhost", port: parseInt(cleanUrl, 10) };
    }

    const parts = cleanUrl.split(":");
    if (parts.length !== 2) {
        throw new Error(
            `Invalid cliUrl format: ${url}. Expected "host:port", "http://host:port", or "port"`
        );
    }

    const host = parts[0] || "localhost";
    const port = parseInt(parts[1], 10);

    if (isNaN(port) || port <= 0 || port > 65535) {
        throw new Error(`Invalid port in cliUrl: ${url}`);
    }

    return { host, port };
}

/**
 * Transport that communicates with the Copilot CLI via TCP socket.
 * Supports two modes: spawning a CLI process with --port, or connecting to an existing server.
 */
export class TcpTransport implements Transport {
    private cliProcess: ChildProcess | null = null;
    private socket: Socket | null = null;
    private _connection: MessageConnection | null = null;
    private actualPort: number | null;
    private readonly host: string;
    private readonly isExternalServer: boolean;
    private readonly opts: Required<
        Omit<
            TcpTransportOptions,
            "githubToken" | "useLoggedInUser" | "onExit" | "port" | "host" | "isExternalServer"
        >
    > &
        Pick<TcpTransportOptions, "githubToken" | "useLoggedInUser" | "onExit">;
    private readonly requestedPort: number;

    get connection(): MessageConnection | null {
        return this._connection;
    }

    constructor(options: TcpTransportOptions = {}) {
        this.host = options.host ?? "localhost";
        this.isExternalServer = options.isExternalServer ?? false;
        this.requestedPort = options.port ?? 0;
        this.actualPort = this.isExternalServer ? this.requestedPort : null;
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
        if (!this.isExternalServer) {
            await this.spawnCLI();
        }
        await this.connectTcp();
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

        if (this.socket) {
            try {
                this.socket.end();
            } catch (error) {
                errors.push(
                    new Error(
                        `Failed to close socket: ${error instanceof Error ? error.message : String(error)}`
                    )
                );
            }
            this.socket = null;
        }

        if (this.cliProcess && !this.isExternalServer) {
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

        this.actualPort = null;
        return errors;
    }

    async forceStop(): Promise<void> {
        if (this._connection) {
            try {
                this._connection.dispose();
            } catch {
                // Ignore errors during force stop
            }
            this._connection = null;
        }

        if (this.socket) {
            try {
                this.socket.destroy();
            } catch {
                // Ignore errors
            }
            this.socket = null;
        }

        if (this.cliProcess && !this.isExternalServer) {
            try {
                this.cliProcess.kill("SIGKILL");
            } catch {
                // Ignore errors
            }
            this.cliProcess = null;
        }

        this.actualPort = null;
    }

    private spawnCLI(): Promise<void> {
        return new Promise((resolve, reject) => {
            const args = [
                ...this.opts.cliArgs,
                "--headless",
                "--no-auto-update",
                "--log-level",
                this.opts.logLevel,
            ];

            if (this.requestedPort > 0) {
                args.push("--port", this.requestedPort.toString());
            }

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

            const stdioConfig: ["ignore", "pipe", "pipe"] = ["ignore", "pipe", "pipe"];

            this.cliProcess = spawn(this.opts.cliPath, args, {
                stdio: stdioConfig,
                cwd: this.opts.cwd,
                env: envWithoutNodeDebug,
            });

            let stdout = "";
            let resolved = false;

            // For TCP mode, wait for port announcement
            this.cliProcess.stdout?.on("data", (data: Buffer) => {
                stdout += data.toString();
                const match = stdout.match(/listening on port (\d+)/i);
                if (match && !resolved) {
                    this.actualPort = parseInt(match[1], 10);
                    resolved = true;
                    resolve();
                }
            });

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

    private connectTcp(): Promise<void> {
        if (!this.actualPort) {
            throw new Error("Server port not available");
        }

        return new Promise((resolve, reject) => {
            this.socket = new Socket();

            this.socket.connect(this.actualPort!, this.host, () => {
                this._connection = createMessageConnection(
                    new StreamMessageReader(this.socket!),
                    new StreamMessageWriter(this.socket!)
                );

                this._connection.listen();
                resolve();
            });

            this.socket.on("error", (error) => {
                reject(new Error(`Failed to connect to CLI server: ${error.message}`));
            });
        });
    }
}
