/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { MessageConnection } from "vscode-jsonrpc/node.js";
import type { Transport } from "./transport.js";

/**
 * Interface for the WASM module exports.
 * The WASM module (built from the Rust runtime) exports these functions.
 */
export interface WasmModule {
    init(
        httpPostFn: (
            url: string,
            headersJson: string,
            bodyJson: string,
        ) => Promise<{ status: number; body: string }>,
        onEvent: (method: string, paramsJson: string) => void,
        onRequest: (method: string, paramsJson: string) => Promise<string>,
        authToken: string,
        apiUrl?: string,
    ): Promise<void>;

    send_jsonrpc(requestJson: string): Promise<string>;
}

export interface WasmTransportOptions {
    /** The WASM module instance or a loader function that returns one */
    wasmModule?: WasmModule | (() => Promise<WasmModule>);

    /** Auth token to pass to the WASM runtime */
    authToken?: string;

    /** Copilot API URL override */
    apiUrl?: string;

    /** Custom HTTP implementation. Defaults to fetch(). */
    httpPost?: (
        url: string,
        headersJson: string,
        bodyJson: string,
    ) => Promise<{ status: number; body: string }>;

    /** Handler for events (notifications) from the WASM runtime */
    onEvent?: (method: string, params: unknown) => void;

    /** Handler for requests from the WASM runtime (tool calls, permission requests, etc.) */
    onRequest?: (method: string, params: unknown) => Promise<unknown>;
}

/**
 * Lightweight adapter that mimics MessageConnection for WASM-based communication.
 * Instead of a stream-based JSON-RPC connection, this serializes requests and
 * calls the WASM module's send_jsonrpc directly.
 */
export class WasmConnection {
    private notificationHandlers: Map<string, ((params: unknown) => void)[]> = new Map();
    private requestHandlers: Map<string, (params: unknown) => Promise<unknown>> = new Map();
    private closeHandlers: (() => void)[] = [];
    private errorHandlers: ((error: Error) => void)[] = [];
    private disposed = false;
    private nextId = 1;

    constructor(private wasmModule: WasmModule) {}

    async sendRequest(method: string, params?: unknown): Promise<unknown> {
        if (this.disposed) throw new Error("Connection disposed");

        const request = JSON.stringify({
            jsonrpc: "2.0",
            id: this.nextId++,
            method,
            params: params ?? {},
        });

        const responseJson = await this.wasmModule.send_jsonrpc(request);
        const response = JSON.parse(
            typeof responseJson === "string" ? responseJson : JSON.stringify(responseJson),
        );

        if (response.error) {
            throw new Error(response.error.message || JSON.stringify(response.error));
        }

        return response.result;
    }

    sendNotification(method: string, params?: unknown): void {
        const request = JSON.stringify({
            jsonrpc: "2.0",
            method,
            params: params ?? {},
        });
        void this.wasmModule.send_jsonrpc(request);
    }

    onNotification(method: string, handler: (params: unknown) => void): void {
        if (!this.notificationHandlers.has(method)) {
            this.notificationHandlers.set(method, []);
        }
        this.notificationHandlers.get(method)!.push(handler);
    }

    onRequest(method: string, handler: (params: unknown) => Promise<unknown>): void {
        this.requestHandlers.set(method, handler);
    }

    onClose(handler: () => void): void {
        this.closeHandlers.push(handler);
    }

    onError(handler: (error: Error) => void): void {
        this.errorHandlers.push(handler);
    }

    listen(): void {
        // No-op for WASM — already connected
    }

    dispose(): void {
        this.disposed = true;
        for (const handler of this.closeHandlers) {
            try {
                handler();
            } catch {
                // Ignore errors during dispose
            }
        }
    }

    /** Called by the WASM bridge when the runtime fires an event */
    _dispatchEvent(method: string, paramsJson: string): void {
        const params = JSON.parse(paramsJson);
        const handlers = this.notificationHandlers.get(method);
        if (handlers) {
            for (const h of handlers) {
                try {
                    h(params);
                } catch {
                    // Ignore handler errors
                }
            }
        }
    }

    /** Called by the WASM bridge when the runtime makes a request */
    async _dispatchRequest(method: string, paramsJson: string): Promise<string> {
        const params = JSON.parse(paramsJson);
        const handler = this.requestHandlers.get(method);
        if (!handler) {
            return JSON.stringify({ error: { code: -32601, message: `Method not found: ${method}` } });
        }
        try {
            const result = await handler(params);
            return JSON.stringify(result);
        } catch (err) {
            return JSON.stringify({ error: { code: -32603, message: String(err) } });
        }
    }
}

/**
 * Transport that communicates with the Copilot runtime compiled to WebAssembly.
 * Loads a WASM module in-process and communicates via direct function calls
 * instead of spawning a process or connecting via TCP.
 */
export class WasmTransport implements Transport {
    private wasmModule: WasmModule | null = null;
    private wasmConnection: WasmConnection | null = null;
    private readonly opts: WasmTransportOptions;

    get connection(): MessageConnection | null {
        // WasmConnection implements enough of MessageConnection for CopilotClient
        return this.wasmConnection as unknown as MessageConnection | null;
    }

    constructor(options: WasmTransportOptions = {}) {
        this.opts = options;
    }

    async start(): Promise<void> {
        if (!this.opts.wasmModule) {
            throw new Error("wasmModule is required for WASM transport");
        }

        this.wasmModule =
            typeof this.opts.wasmModule === "function"
                ? await this.opts.wasmModule()
                : this.opts.wasmModule;

        this.wasmConnection = new WasmConnection(this.wasmModule);

        const httpPost = this.opts.httpPost ?? defaultHttpPost;

        await this.wasmModule.init(
            httpPost,
            (method: string, paramsJson: string) => {
                this.translateAndDispatchEvent(method, paramsJson);
            },
            async (method: string, paramsJson: string): Promise<string> => {
                const translated = this.translateRequest(method, paramsJson);
                return await this.wasmConnection!._dispatchRequest(translated.method, JSON.stringify(translated.params));
            },
            this.opts.authToken ?? "",
            this.opts.apiUrl,
        );
    }

    /**
     * Translates WASM runtime callback names (emit_*, invoke_*) into the
     * SDK's session.event notification format used by stdio/TCP transports.
     */
    private translateAndDispatchEvent(method: string, paramsJson: string): void {
        const params = JSON.parse(paramsJson);
        const sessionId = params.sessionId ?? "";
        const ts = new Date().toISOString();
        const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;

        let eventType: string | undefined;
        let data: Record<string, unknown> = {};
        let ephemeral = false;

        switch (method) {
            case "emit_text_delta":
                eventType = "assistant.message_delta";
                data = { messageId: id, deltaContent: params.delta };
                ephemeral = true;
                break;
            case "emit_assistant_message":
                eventType = "assistant.message";
                data = { messageId: id, content: params.content };
                break;
            case "emit_tool_start":
                eventType = "tool.execution_start";
                data = { toolCallId: params.toolCallId, toolName: params.toolName, arguments: params.args };
                break;
            case "emit_tool_complete":
                eventType = "tool.execution_complete";
                data = { toolCallId: params.toolCallId, success: true, result: { content: params.result } };
                break;
            case "emit_idle":
                eventType = "session.idle";
                ephemeral = true;
                break;
            case "emit_error":
                eventType = "session.error";
                data = { message: params.message };
                break;
            default:
                // Unrecognized callbacks (e.g. hook invocations handled via onRequest)
                return;
        }

        const notification = {
            sessionId,
            event: {
                type: eventType,
                id,
                parentId: null,
                timestamp: ts,
                ...(ephemeral && { ephemeral: true }),
                data: { ...data, sessionId },
            },
        };

        this.wasmConnection!._dispatchEvent("session.event", JSON.stringify(notification));
    }

    /**
     * Translates WASM runtime request callbacks (invoke_*_hook) into the
     * SDK's hooks.invoke request format.
     */
    private translateRequest(method: string, paramsJson: string): { method: string; params: unknown } {
        const params = JSON.parse(paramsJson);

        const hookMap: Record<string, string> = {
            invoke_pre_tool_use_hook: "preToolUse",
            invoke_post_tool_use_hook: "postToolUse",
            invoke_user_prompt_submitted_hook: "userPromptSubmitted",
            invoke_session_start_hook: "sessionStart",
            invoke_session_end_hook: "sessionEnd",
            invoke_error_occurred_hook: "errorOccurred",
        };

        const hookType = hookMap[method];
        if (hookType) {
            return {
                method: "hooks.invoke",
                params: {
                    sessionId: params.sessionId,
                    hookType,
                    input: params,
                },
            };
        }

        // Pass through unrecognized requests as-is
        return { method, params };
    }

    async stop(): Promise<Error[]> {
        const errors: Error[] = [];
        if (this.wasmConnection) {
            try {
                this.wasmConnection.dispose();
            } catch (e) {
                errors.push(e instanceof Error ? e : new Error(String(e)));
            }
            this.wasmConnection = null;
        }
        this.wasmModule = null;
        return errors;
    }

    async forceStop(): Promise<void> {
        if (this.wasmConnection) {
            try {
                this.wasmConnection.dispose();
            } catch {
                // Ignore errors during force stop
            }
            this.wasmConnection = null;
        }
        this.wasmModule = null;
    }
}

async function defaultHttpPost(
    url: string,
    headersJson: string,
    bodyJson: string,
): Promise<{ status: number; body: string }> {
    const headers = JSON.parse(headersJson);
    const response = await fetch(url, {
        method: "POST",
        headers,
        body: bodyJson,
    });
    const body = await response.text();
    return { status: response.status, body };
}
