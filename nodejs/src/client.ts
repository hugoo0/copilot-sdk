/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Copilot CLI SDK Client - Main entry point for the Copilot SDK.
 *
 * This module provides the {@link CopilotClient} class, which manages the connection
 * to the Copilot CLI server and provides session management capabilities.
 *
 * @module client
 */

import type { MessageConnection } from "vscode-jsonrpc/node.js";
import { getSdkProtocolVersion } from "./sdkProtocolVersion.js";
import { CopilotSession } from "./session.js";
import type { Transport } from "./transport.js";
import { StdioTransport, getBundledCliPath } from "./stdio-transport.js";
import { TcpTransport, parseCliUrl } from "./tcp-transport.js";
import { WasmTransport } from "./wasm-transport.js";
import type {
    ConnectionState,
    CopilotClientOptions,
    ForegroundSessionInfo,
    GetAuthStatusResponse,
    GetStatusResponse,
    ModelInfo,
    ResumeSessionConfig,
    SessionConfig,
    SessionEvent,
    SessionLifecycleEvent,
    SessionLifecycleEventType,
    SessionLifecycleHandler,
    SessionMetadata,
    Tool,
    ToolCallRequestPayload,
    ToolCallResponsePayload,
    ToolHandler,
    ToolResult,
    ToolResultObject,
    TypedSessionLifecycleHandler,
} from "./types.js";

/**
 * Check if value is a Zod schema (has toJSONSchema method)
 */
function isZodSchema(value: unknown): value is { toJSONSchema(): Record<string, unknown> } {
    return (
        value != null &&
        typeof value === "object" &&
        "toJSONSchema" in value &&
        typeof (value as { toJSONSchema: unknown }).toJSONSchema === "function"
    );
}

/**
 * Convert tool parameters to JSON schema format for sending to CLI
 */
function toJsonSchema(parameters: Tool["parameters"]): Record<string, unknown> | undefined {
    if (!parameters) return undefined;
    if (isZodSchema(parameters)) {
        return parameters.toJSONSchema();
    }
    return parameters;
}

/**
 * Main client for interacting with the Copilot CLI.
 *
 * The CopilotClient manages the connection to the Copilot CLI server and provides
 * methods to create and manage conversation sessions. It can either spawn a CLI
 * server process or connect to an existing server.
 *
 * @example
 * ```typescript
 * import { CopilotClient } from "@github/copilot-sdk";
 *
 * // Create a client with default options (spawns CLI server)
 * const client = new CopilotClient();
 *
 * // Or connect to an existing server
 * const client = new CopilotClient({ cliUrl: "localhost:3000" });
 *
 * // Create a session
 * const session = await client.createSession({ model: "gpt-4.1" });
 *
 * // Send messages and handle responses
 * session.on((event) => {
 *   if (event.type === "assistant.message") {
 *     console.log(event.data.content);
 *   }
 * });
 * await session.send({ prompt: "Hello!" });
 *
 * // Clean up
 * await session.destroy();
 * await client.stop();
 * ```
 */

export class CopilotClient {
    private transport: Transport | null = null;
    private connection: MessageConnection | null = null;
    private state: ConnectionState = "disconnected";
    private sessions: Map<string, CopilotSession> = new Map();
    private options: Required<
        Omit<CopilotClientOptions, "cliUrl" | "githubToken" | "useLoggedInUser" | "runtime" | "wasmModule" | "apiUrl" | "httpPost">
    > & {
        cliUrl?: string;
        githubToken?: string;
        useLoggedInUser?: boolean;
        runtime?: "native" | "wasm";
        wasmModule?: CopilotClientOptions["wasmModule"];
        apiUrl?: string;
        httpPost?: CopilotClientOptions["httpPost"];
    };
    private modelsCache: ModelInfo[] | null = null;
    private modelsCacheLock: Promise<void> = Promise.resolve();
    private sessionLifecycleHandlers: Set<SessionLifecycleHandler> = new Set();
    private typedLifecycleHandlers: Map<
        SessionLifecycleEventType,
        Set<(event: SessionLifecycleEvent) => void>
    > = new Map();

    /**
     * Creates a new CopilotClient instance.
     *
     * @param options - Configuration options for the client
     * @throws Error if mutually exclusive options are provided (e.g., cliUrl with useStdio or cliPath)
     *
     * @example
     * ```typescript
     * // Default options - spawns CLI server using stdio
     * const client = new CopilotClient();
     *
     * // Connect to an existing server
     * const client = new CopilotClient({ cliUrl: "localhost:3000" });
     *
     * // Custom CLI path with specific log level
     * const client = new CopilotClient({
     *   cliPath: "/usr/local/bin/copilot",
     *   logLevel: "debug"
     * });
     * ```
     */
    constructor(options: CopilotClientOptions = {}) {
        // Validate runtime option
        if (
            options.runtime === "wasm" &&
            (options.cliPath || options.cliUrl || options.useStdio === true)
        ) {
            throw new Error(
                "runtime 'wasm' is mutually exclusive with cliPath, cliUrl, and useStdio"
            );
        }

        if (options.runtime === "wasm" && !options.wasmModule) {
            throw new Error("wasmModule is required when runtime is 'wasm'");
        }

        // Validate mutually exclusive options
        if (options.cliUrl && (options.useStdio === true || options.cliPath)) {
            throw new Error("cliUrl is mutually exclusive with useStdio and cliPath");
        }

        // Validate auth options with external server
        if (options.cliUrl && (options.githubToken || options.useLoggedInUser !== undefined)) {
            throw new Error(
                "githubToken and useLoggedInUser cannot be used with cliUrl (external server manages its own auth)"
            );
        }

        this.options = {
            cliPath: options.runtime === "wasm" ? undefined : (options.cliPath || getBundledCliPath()),
            cliArgs: options.cliArgs ?? [],
            cwd: options.cwd ?? process.cwd(),
            port: options.port || 0,
            useStdio: options.cliUrl ? false : (options.useStdio ?? true),
            cliUrl: options.cliUrl,
            logLevel: options.logLevel || "debug",
            autoStart: options.autoStart ?? true,
            autoRestart: options.autoRestart ?? true,
            env: options.env ?? process.env,
            githubToken: options.githubToken,
            // Default useLoggedInUser to false (secure by default)
            useLoggedInUser: options.useLoggedInUser ?? false,
            runtime: options.runtime,
            wasmModule: options.wasmModule,
            apiUrl: options.apiUrl,
            httpPost: options.httpPost,
        };

        // Create the appropriate transport
        if (options.runtime === "wasm") {
            this.transport = new WasmTransport({
                wasmModule: options.wasmModule,
                authToken: options.githubToken,
                apiUrl: options.apiUrl,
                httpPost: options.httpPost,
            });
        } else if (options.cliUrl) {
            const { host, port } = parseCliUrl(options.cliUrl);
            this.transport = new TcpTransport({
                host,
                port,
                isExternalServer: true,
            });
        } else if (this.options.useStdio) {
            this.transport = new StdioTransport({
                cliPath: this.options.cliPath,
                cliArgs: this.options.cliArgs,
                cwd: this.options.cwd,
                logLevel: this.options.logLevel,
                env: this.options.env,
                githubToken: this.options.githubToken,
                useLoggedInUser: this.options.useLoggedInUser,
                onExit: () => {
                    if (this.options.autoRestart && this.state === "connected") {
                        void this.reconnect();
                    }
                },
            });
        } else {
            this.transport = new TcpTransport({
                cliPath: this.options.cliPath,
                cliArgs: this.options.cliArgs,
                cwd: this.options.cwd,
                logLevel: this.options.logLevel,
                env: this.options.env,
                githubToken: this.options.githubToken,
                useLoggedInUser: this.options.useLoggedInUser,
                port: this.options.port,
                onExit: () => {
                    if (this.options.autoRestart && this.state === "connected") {
                        void this.reconnect();
                    }
                },
            });
        }
    }

    /**
     * Starts the CLI server and establishes a connection.
     *
     * If connecting to an external server (via cliUrl), only establishes the connection.
     * Otherwise, spawns the CLI server process and then connects.
     *
     * This method is called automatically when creating a session if `autoStart` is true (default).
     *
     * @returns A promise that resolves when the connection is established
     * @throws Error if the server fails to start or the connection fails
     *
     * @example
     * ```typescript
     * const client = new CopilotClient({ autoStart: false });
     * await client.start();
     * // Now ready to create sessions
     * ```
     */
    async start(): Promise<void> {
        if (this.state === "connected") {
            return;
        }

        this.state = "connecting";

        try {
            await this.transport!.start();
            this.connection = this.transport!.connection;

            // Attach session routing handlers
            this.attachConnectionHandlers();

            // Verify protocol version compatibility
            await this.verifyProtocolVersion();

            this.state = "connected";
        } catch (error) {
            this.state = "error";
            throw error;
        }
    }

    /**
     * Stops the CLI server and closes all active sessions.
     *
     * This method performs graceful cleanup:
     * 1. Destroys all active sessions with retry logic
     * 2. Closes the JSON-RPC connection
     * 3. Terminates the CLI server process (if spawned by this client)
     *
     * @returns A promise that resolves with an array of errors encountered during cleanup.
     *          An empty array indicates all cleanup succeeded.
     *
     * @example
     * ```typescript
     * const errors = await client.stop();
     * if (errors.length > 0) {
     *   console.error("Cleanup errors:", errors);
     * }
     * ```
     */
    async stop(): Promise<Error[]> {
        const errors: Error[] = [];

        // Destroy all active sessions with retry logic
        for (const session of this.sessions.values()) {
            const sessionId = session.sessionId;
            let lastError: Error | null = null;

            // Try up to 3 times with exponential backoff
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    await session.destroy();
                    lastError = null;
                    break; // Success
                } catch (error) {
                    lastError = error instanceof Error ? error : new Error(String(error));

                    if (attempt < 3) {
                        // Exponential backoff: 100ms, 200ms
                        const delay = 100 * Math.pow(2, attempt - 1);
                        await new Promise((resolve) => setTimeout(resolve, delay));
                    }
                }
            }

            if (lastError) {
                errors.push(
                    new Error(
                        `Failed to destroy session ${sessionId} after 3 attempts: ${lastError.message}`
                    )
                );
            }
        }
        this.sessions.clear();

        // Clear models cache
        this.modelsCache = null;

        // Stop transport (handles connection, socket, process cleanup)
        if (this.transport) {
            const transportErrors = await this.transport.stop();
            errors.push(...transportErrors);
        }
        this.connection = null;

        this.state = "disconnected";

        return errors;
    }

    /**
     * Forcefully stops the CLI server without graceful cleanup.
     *
     * Use this when {@link stop} fails or takes too long. This method:
     * - Clears all sessions immediately without destroying them
     * - Force closes the connection
     * - Sends SIGKILL to the CLI process (if spawned by this client)
     *
     * @returns A promise that resolves when the force stop is complete
     *
     * @example
     * ```typescript
     * // If normal stop hangs, force stop
     * const stopPromise = client.stop();
     * const timeout = new Promise((_, reject) =>
     *   setTimeout(() => reject(new Error("Timeout")), 5000)
     * );
     *
     * try {
     *   await Promise.race([stopPromise, timeout]);
     * } catch {
     *   await client.forceStop();
     * }
     * ```
     */
    async forceStop(): Promise<void> {
        // Clear sessions immediately without trying to destroy them
        this.sessions.clear();

        // Clear models cache
        this.modelsCache = null;

        // Force stop transport (handles connection, socket, process cleanup)
        if (this.transport) {
            await this.transport.forceStop();
        }
        this.connection = null;

        this.state = "disconnected";
    }

    /**
     * Creates a new conversation session with the Copilot CLI.
     *
     * Sessions maintain conversation state, handle events, and manage tool execution.
     * If the client is not connected and `autoStart` is enabled, this will automatically
     * start the connection.
     *
     * @param config - Optional configuration for the session
     * @returns A promise that resolves with the created session
     * @throws Error if the client is not connected and autoStart is disabled
     *
     * @example
     * ```typescript
     * // Basic session
     * const session = await client.createSession();
     *
     * // Session with model and tools
     * const session = await client.createSession({
     *   model: "gpt-4.1",
     *   tools: [{
     *     name: "get_weather",
     *     description: "Get weather for a location",
     *     parameters: { type: "object", properties: { location: { type: "string" } } },
     *     handler: async (args) => ({ temperature: 72 })
     *   }]
     * });
     * ```
     */
    async createSession(config: SessionConfig = {}): Promise<CopilotSession> {
        if (!this.connection) {
            if (this.options.autoStart) {
                await this.start();
            } else {
                throw new Error("Client not connected. Call start() first.");
            }
        }

        const response = await this.connection!.sendRequest("session.create", {
            model: config.model,
            sessionId: config.sessionId,
            reasoningEffort: config.reasoningEffort,
            tools: config.tools?.map((tool) => ({
                name: tool.name,
                description: tool.description,
                parameters: toJsonSchema(tool.parameters),
            })),
            systemMessage: config.systemMessage,
            availableTools: config.availableTools,
            excludedTools: config.excludedTools,
            provider: config.provider,
            requestPermission: !!config.onPermissionRequest,
            requestUserInput: !!config.onUserInputRequest,
            hooks: !!(config.hooks && Object.values(config.hooks).some(Boolean)),
            workingDirectory: config.workingDirectory,
            streaming: config.streaming,
            mcpServers: config.mcpServers,
            customAgents: config.customAgents,
            configDir: config.configDir,
            skillDirectories: config.skillDirectories,
            disabledSkills: config.disabledSkills,
            infiniteSessions: config.infiniteSessions,
            configDiscovery: config.configDiscovery,
            agentDiscovery: config.agentDiscovery,
            sessionStorage: config.sessionStorage,
        });

        const { sessionId, workspacePath } = response as {
            sessionId: string;
            workspacePath?: string;
        };
        const session = new CopilotSession(sessionId, this.connection!, workspacePath);
        session.registerTools(config.tools);
        if (config.onPermissionRequest) {
            session.registerPermissionHandler(config.onPermissionRequest);
        }
        if (config.onUserInputRequest) {
            session.registerUserInputHandler(config.onUserInputRequest);
        }
        if (config.hooks) {
            session.registerHooks(config.hooks);
        }
        this.sessions.set(sessionId, session);

        return session;
    }

    /**
     * Resumes an existing conversation session by its ID.
     *
     * This allows you to continue a previous conversation, maintaining all
     * conversation history. The session must have been previously created
     * and not deleted.
     *
     * @param sessionId - The ID of the session to resume
     * @param config - Optional configuration for the resumed session
     * @returns A promise that resolves with the resumed session
     * @throws Error if the session does not exist or the client is not connected
     *
     * @example
     * ```typescript
     * // Resume a previous session
     * const session = await client.resumeSession("session-123");
     *
     * // Resume with new tools
     * const session = await client.resumeSession("session-123", {
     *   tools: [myNewTool]
     * });
     * ```
     */
    async resumeSession(
        sessionId: string,
        config: ResumeSessionConfig = {}
    ): Promise<CopilotSession> {
        if (!this.connection) {
            if (this.options.autoStart) {
                await this.start();
            } else {
                throw new Error("Client not connected. Call start() first.");
            }
        }

        const response = await this.connection!.sendRequest("session.resume", {
            sessionId,
            model: config.model,
            reasoningEffort: config.reasoningEffort,
            systemMessage: config.systemMessage,
            availableTools: config.availableTools,
            excludedTools: config.excludedTools,
            tools: config.tools?.map((tool) => ({
                name: tool.name,
                description: tool.description,
                parameters: toJsonSchema(tool.parameters),
            })),
            provider: config.provider,
            requestPermission: !!config.onPermissionRequest,
            requestUserInput: !!config.onUserInputRequest,
            hooks: !!(config.hooks && Object.values(config.hooks).some(Boolean)),
            workingDirectory: config.workingDirectory,
            configDir: config.configDir,
            streaming: config.streaming,
            mcpServers: config.mcpServers,
            customAgents: config.customAgents,
            skillDirectories: config.skillDirectories,
            disabledSkills: config.disabledSkills,
            infiniteSessions: config.infiniteSessions,
            disableResume: config.disableResume,
            configDiscovery: config.configDiscovery,
            agentDiscovery: config.agentDiscovery,
            sessionStorage: config.sessionStorage,
        });

        const { sessionId: resumedSessionId, workspacePath } = response as {
            sessionId: string;
            workspacePath?: string;
        };
        const session = new CopilotSession(resumedSessionId, this.connection!, workspacePath);
        session.registerTools(config.tools);
        if (config.onPermissionRequest) {
            session.registerPermissionHandler(config.onPermissionRequest);
        }
        if (config.onUserInputRequest) {
            session.registerUserInputHandler(config.onUserInputRequest);
        }
        if (config.hooks) {
            session.registerHooks(config.hooks);
        }
        this.sessions.set(resumedSessionId, session);

        return session;
    }

    /**
     * Gets the current connection state of the client.
     *
     * @returns The current connection state: "disconnected", "connecting", "connected", or "error"
     *
     * @example
     * ```typescript
     * if (client.getState() === "connected") {
     *   const session = await client.createSession();
     * }
     * ```
     */
    getState(): ConnectionState {
        return this.state;
    }

    /**
     * Sends a ping request to the server to verify connectivity.
     *
     * @param message - Optional message to include in the ping
     * @returns A promise that resolves with the ping response containing the message and timestamp
     * @throws Error if the client is not connected
     *
     * @example
     * ```typescript
     * const response = await client.ping("health check");
     * console.log(`Server responded at ${new Date(response.timestamp)}`);
     * ```
     */
    async ping(
        message?: string
    ): Promise<{ message: string; timestamp: number; protocolVersion?: number }> {
        if (!this.connection) {
            throw new Error("Client not connected");
        }

        const result = await this.connection.sendRequest("ping", { message });
        return result as {
            message: string;
            timestamp: number;
            protocolVersion?: number;
        };
    }

    /**
     * Get CLI status including version and protocol information
     */
    async getStatus(): Promise<GetStatusResponse> {
        if (!this.connection) {
            throw new Error("Client not connected");
        }

        const result = await this.connection.sendRequest("status.get", {});
        return result as GetStatusResponse;
    }

    /**
     * Get current authentication status
     */
    async getAuthStatus(): Promise<GetAuthStatusResponse> {
        if (!this.connection) {
            throw new Error("Client not connected");
        }

        const result = await this.connection.sendRequest("auth.getStatus", {});
        return result as GetAuthStatusResponse;
    }

    /**
     * List available models with their metadata.
     *
     * Results are cached after the first successful call to avoid rate limiting.
     * The cache is cleared when the client disconnects.
     *
     * @throws Error if not authenticated
     */
    async listModels(): Promise<ModelInfo[]> {
        if (!this.connection) {
            throw new Error("Client not connected");
        }

        // Use promise-based locking to prevent race condition with concurrent calls
        await this.modelsCacheLock;

        let resolveLock: () => void;
        this.modelsCacheLock = new Promise((resolve) => {
            resolveLock = resolve;
        });

        try {
            // Check cache (already inside lock)
            if (this.modelsCache !== null) {
                return [...this.modelsCache]; // Return a copy to prevent cache mutation
            }

            // Cache miss - fetch from backend while holding lock
            const result = await this.connection.sendRequest("models.list", {});
            const response = result as { models: ModelInfo[] };
            const models = response.models;

            // Update cache before releasing lock
            this.modelsCache = models;

            return [...models]; // Return a copy to prevent cache mutation
        } finally {
            resolveLock!();
        }
    }

    /**
     * Verify that the server's protocol version matches the SDK's expected version
     */
    private async verifyProtocolVersion(): Promise<void> {
        const expectedVersion = getSdkProtocolVersion();
        const pingResult = await this.ping();
        const serverVersion = pingResult.protocolVersion;

        if (serverVersion === undefined) {
            throw new Error(
                `SDK protocol version mismatch: SDK expects version ${expectedVersion}, but server does not report a protocol version. ` +
                    `Please update your server to ensure compatibility.`
            );
        }

        if (serverVersion !== expectedVersion) {
            throw new Error(
                `SDK protocol version mismatch: SDK expects version ${expectedVersion}, but server reports version ${serverVersion}. ` +
                    `Please update your SDK or server to ensure compatibility.`
            );
        }
    }

    /**
     * Gets the ID of the most recently updated session.
     *
     * This is useful for resuming the last conversation when the session ID
     * was not stored.
     *
     * @returns A promise that resolves with the session ID, or undefined if no sessions exist
     * @throws Error if the client is not connected
     *
     * @example
     * ```typescript
     * const lastId = await client.getLastSessionId();
     * if (lastId) {
     *   const session = await client.resumeSession(lastId);
     * }
     * ```
     */
    async getLastSessionId(): Promise<string | undefined> {
        if (!this.connection) {
            throw new Error("Client not connected");
        }

        const response = await this.connection.sendRequest("session.getLastId", {});
        return (response as { sessionId?: string }).sessionId;
    }

    /**
     * Deletes a session and its data from disk.
     *
     * This permanently removes the session and all its conversation history.
     * The session cannot be resumed after deletion.
     *
     * @param sessionId - The ID of the session to delete
     * @returns A promise that resolves when the session is deleted
     * @throws Error if the session does not exist or deletion fails
     *
     * @example
     * ```typescript
     * await client.deleteSession("session-123");
     * ```
     */
    async deleteSession(sessionId: string): Promise<void> {
        if (!this.connection) {
            throw new Error("Client not connected");
        }

        const response = await this.connection.sendRequest("session.delete", {
            sessionId,
        });

        const { success, error } = response as { success: boolean; error?: string };
        if (!success) {
            throw new Error(`Failed to delete session ${sessionId}: ${error || "Unknown error"}`);
        }

        // Remove from local sessions map if present
        this.sessions.delete(sessionId);
    }

    /**
     * Lists all available sessions known to the server.
     *
     * Returns metadata about each session including ID, timestamps, and summary.
     *
     * @returns A promise that resolves with an array of session metadata
     * @throws Error if the client is not connected
     *
     * @example
     * ```typescript
     * const sessions = await client.listSessions();
     * for (const session of sessions) {
     *   console.log(`${session.sessionId}: ${session.summary}`);
     * }
     * ```
     */
    async listSessions(): Promise<SessionMetadata[]> {
        if (!this.connection) {
            throw new Error("Client not connected");
        }

        const response = await this.connection.sendRequest("session.list", {});
        const { sessions } = response as {
            sessions: Array<{
                sessionId: string;
                startTime: string;
                modifiedTime: string;
                summary?: string;
                isRemote: boolean;
            }>;
        };

        return sessions.map((s) => ({
            sessionId: s.sessionId,
            startTime: new Date(s.startTime),
            modifiedTime: new Date(s.modifiedTime),
            summary: s.summary,
            isRemote: s.isRemote,
        }));
    }

    /**
     * Gets the foreground session ID in TUI+server mode.
     *
     * This returns the ID of the session currently displayed in the TUI.
     * Only available when connecting to a server running in TUI+server mode (--ui-server).
     *
     * @returns A promise that resolves with the foreground session ID, or undefined if none
     * @throws Error if the client is not connected
     *
     * @example
     * ```typescript
     * const sessionId = await client.getForegroundSessionId();
     * if (sessionId) {
     *   console.log(`TUI is displaying session: ${sessionId}`);
     * }
     * ```
     */
    async getForegroundSessionId(): Promise<string | undefined> {
        if (!this.connection) {
            throw new Error("Client not connected");
        }

        const response = await this.connection.sendRequest("session.getForeground", {});
        return (response as ForegroundSessionInfo).sessionId;
    }

    /**
     * Sets the foreground session in TUI+server mode.
     *
     * This requests the TUI to switch to displaying the specified session.
     * Only available when connecting to a server running in TUI+server mode (--ui-server).
     *
     * @param sessionId - The ID of the session to display in the TUI
     * @returns A promise that resolves when the session is switched
     * @throws Error if the client is not connected or if the operation fails
     *
     * @example
     * ```typescript
     * // Switch the TUI to display a specific session
     * await client.setForegroundSessionId("session-123");
     * ```
     */
    async setForegroundSessionId(sessionId: string): Promise<void> {
        if (!this.connection) {
            throw new Error("Client not connected");
        }

        const response = await this.connection.sendRequest("session.setForeground", { sessionId });
        const result = response as { success: boolean; error?: string };

        if (!result.success) {
            throw new Error(result.error || "Failed to set foreground session");
        }
    }

    /**
     * Subscribes to a specific session lifecycle event type.
     *
     * Lifecycle events are emitted when sessions are created, deleted, updated,
     * or change foreground/background state (in TUI+server mode).
     *
     * @param eventType - The specific event type to listen for
     * @param handler - A callback function that receives events of the specified type
     * @returns A function that, when called, unsubscribes the handler
     *
     * @example
     * ```typescript
     * // Listen for when a session becomes foreground in TUI
     * const unsubscribe = client.on("session.foreground", (event) => {
     *   console.log(`Session ${event.sessionId} is now displayed in TUI`);
     * });
     *
     * // Later, to stop receiving events:
     * unsubscribe();
     * ```
     */
    on<K extends SessionLifecycleEventType>(
        eventType: K,
        handler: TypedSessionLifecycleHandler<K>
    ): () => void;

    /**
     * Subscribes to all session lifecycle events.
     *
     * @param handler - A callback function that receives all lifecycle events
     * @returns A function that, when called, unsubscribes the handler
     *
     * @example
     * ```typescript
     * const unsubscribe = client.on((event) => {
     *   switch (event.type) {
     *     case "session.foreground":
     *       console.log(`Session ${event.sessionId} is now in foreground`);
     *       break;
     *     case "session.created":
     *       console.log(`New session created: ${event.sessionId}`);
     *       break;
     *   }
     * });
     *
     * // Later, to stop receiving events:
     * unsubscribe();
     * ```
     */
    on(handler: SessionLifecycleHandler): () => void;

    on<K extends SessionLifecycleEventType>(
        eventTypeOrHandler: K | SessionLifecycleHandler,
        handler?: TypedSessionLifecycleHandler<K>
    ): () => void {
        // Overload 1: on(eventType, handler) - typed event subscription
        if (typeof eventTypeOrHandler === "string" && handler) {
            const eventType = eventTypeOrHandler;
            if (!this.typedLifecycleHandlers.has(eventType)) {
                this.typedLifecycleHandlers.set(eventType, new Set());
            }
            const storedHandler = handler as (event: SessionLifecycleEvent) => void;
            this.typedLifecycleHandlers.get(eventType)!.add(storedHandler);
            return () => {
                const handlers = this.typedLifecycleHandlers.get(eventType);
                if (handlers) {
                    handlers.delete(storedHandler);
                }
            };
        }

        // Overload 2: on(handler) - wildcard subscription
        const wildcardHandler = eventTypeOrHandler as SessionLifecycleHandler;
        this.sessionLifecycleHandlers.add(wildcardHandler);
        return () => {
            this.sessionLifecycleHandlers.delete(wildcardHandler);
        };
    }

    private attachConnectionHandlers(): void {
        if (!this.connection) {
            return;
        }

        this.connection.onNotification("session.event", (notification: unknown) => {
            this.handleSessionEventNotification(notification);
        });

        this.connection.onNotification("session.lifecycle", (notification: unknown) => {
            this.handleSessionLifecycleNotification(notification);
        });

        this.connection.onRequest(
            "tool.call",
            async (params: ToolCallRequestPayload): Promise<ToolCallResponsePayload> =>
                await this.handleToolCallRequest(params)
        );

        this.connection.onRequest(
            "permission.request",
            async (params: {
                sessionId: string;
                permissionRequest: unknown;
            }): Promise<{ result: unknown }> => await this.handlePermissionRequest(params)
        );

        this.connection.onRequest(
            "userInput.request",
            async (params: {
                sessionId: string;
                question: string;
                choices?: string[];
                allowFreeform?: boolean;
            }): Promise<{ answer: string; wasFreeform: boolean }> =>
                await this.handleUserInputRequest(params)
        );

        this.connection.onRequest(
            "hooks.invoke",
            async (params: {
                sessionId: string;
                hookType: string;
                input: unknown;
            }): Promise<{ output?: unknown }> => await this.handleHooksInvoke(params)
        );

        this.connection.onClose(() => {
            if (this.state === "connected" && this.options.autoRestart) {
                void this.reconnect();
            }
        });

        this.connection.onError((_error) => {
            // Connection errors are handled via autoRestart if enabled
        });
    }

    private handleSessionEventNotification(notification: unknown): void {
        if (
            typeof notification !== "object" ||
            !notification ||
            !("sessionId" in notification) ||
            typeof (notification as { sessionId?: unknown }).sessionId !== "string" ||
            !("event" in notification)
        ) {
            return;
        }

        const session = this.sessions.get((notification as { sessionId: string }).sessionId);
        if (session) {
            session._dispatchEvent((notification as { event: SessionEvent }).event);
        }
    }

    private handleSessionLifecycleNotification(notification: unknown): void {
        if (
            typeof notification !== "object" ||
            !notification ||
            !("type" in notification) ||
            typeof (notification as { type?: unknown }).type !== "string" ||
            !("sessionId" in notification) ||
            typeof (notification as { sessionId?: unknown }).sessionId !== "string"
        ) {
            return;
        }

        const event = notification as SessionLifecycleEvent;

        // Dispatch to typed handlers for this specific event type
        const typedHandlers = this.typedLifecycleHandlers.get(event.type);
        if (typedHandlers) {
            for (const handler of typedHandlers) {
                try {
                    handler(event);
                } catch {
                    // Ignore handler errors
                }
            }
        }

        // Dispatch to wildcard handlers
        for (const handler of this.sessionLifecycleHandlers) {
            try {
                handler(event);
            } catch {
                // Ignore handler errors
            }
        }
    }

    private async handleToolCallRequest(
        params: ToolCallRequestPayload
    ): Promise<ToolCallResponsePayload> {
        if (
            !params ||
            typeof params.sessionId !== "string" ||
            typeof params.toolCallId !== "string" ||
            typeof params.toolName !== "string"
        ) {
            throw new Error("Invalid tool call payload");
        }

        const session = this.sessions.get(params.sessionId);
        if (!session) {
            throw new Error(`Unknown session ${params.sessionId}`);
        }

        const handler = session.getToolHandler(params.toolName);
        if (!handler) {
            return { result: this.buildUnsupportedToolResult(params.toolName) };
        }

        return await this.executeToolCall(handler, params);
    }

    private async executeToolCall(
        handler: ToolHandler,
        request: ToolCallRequestPayload
    ): Promise<ToolCallResponsePayload> {
        try {
            const invocation = {
                sessionId: request.sessionId,
                toolCallId: request.toolCallId,
                toolName: request.toolName,
                arguments: request.arguments,
            };
            const result = await handler(request.arguments, invocation);

            return { result: this.normalizeToolResult(result) };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
                result: {
                    // Don't expose detailed error information to the LLM for security reasons
                    textResultForLlm:
                        "Invoking this tool produced an error. Detailed information is not available.",
                    resultType: "failure",
                    error: message,
                    toolTelemetry: {},
                },
            };
        }
    }

    private async handlePermissionRequest(params: {
        sessionId: string;
        permissionRequest: unknown;
    }): Promise<{ result: unknown }> {
        if (!params || typeof params.sessionId !== "string" || !params.permissionRequest) {
            throw new Error("Invalid permission request payload");
        }

        const session = this.sessions.get(params.sessionId);
        if (!session) {
            throw new Error(`Session not found: ${params.sessionId}`);
        }

        try {
            const result = await session._handlePermissionRequest(params.permissionRequest);
            return { result };
        } catch (_error) {
            // If permission handler fails, deny the permission
            return {
                result: {
                    kind: "denied-no-approval-rule-and-could-not-request-from-user",
                },
            };
        }
    }

    private async handleUserInputRequest(params: {
        sessionId: string;
        question: string;
        choices?: string[];
        allowFreeform?: boolean;
    }): Promise<{ answer: string; wasFreeform: boolean }> {
        if (
            !params ||
            typeof params.sessionId !== "string" ||
            typeof params.question !== "string"
        ) {
            throw new Error("Invalid user input request payload");
        }

        const session = this.sessions.get(params.sessionId);
        if (!session) {
            throw new Error(`Session not found: ${params.sessionId}`);
        }

        const result = await session._handleUserInputRequest({
            question: params.question,
            choices: params.choices,
            allowFreeform: params.allowFreeform,
        });
        return result;
    }

    private async handleHooksInvoke(params: {
        sessionId: string;
        hookType: string;
        input: unknown;
    }): Promise<{ output?: unknown }> {
        if (
            !params ||
            typeof params.sessionId !== "string" ||
            typeof params.hookType !== "string"
        ) {
            throw new Error("Invalid hooks invoke payload");
        }

        const session = this.sessions.get(params.sessionId);
        if (!session) {
            throw new Error(`Session not found: ${params.sessionId}`);
        }

        const output = await session._handleHooksInvoke(params.hookType, params.input);
        return { output };
    }

    private normalizeToolResult(result: unknown): ToolResultObject {
        if (result === undefined || result === null) {
            return {
                textResultForLlm: "Tool returned no result",
                resultType: "failure",
                error: "tool returned no result",
                toolTelemetry: {},
            };
        }

        // ToolResultObject passes through directly (duck-type check)
        if (this.isToolResultObject(result)) {
            return result;
        }

        // Everything else gets wrapped as a successful ToolResultObject
        const textResult = typeof result === "string" ? result : JSON.stringify(result);
        return {
            textResultForLlm: textResult,
            resultType: "success",
            toolTelemetry: {},
        };
    }

    private isToolResultObject(value: unknown): value is ToolResultObject {
        return (
            typeof value === "object" &&
            value !== null &&
            "textResultForLlm" in value &&
            typeof (value as ToolResultObject).textResultForLlm === "string" &&
            "resultType" in value
        );
    }

    private buildUnsupportedToolResult(toolName: string): ToolResult {
        return {
            textResultForLlm: `Tool '${toolName}' is not supported by this client instance.`,
            resultType: "failure",
            error: `tool '${toolName}' not supported`,
            toolTelemetry: {},
        };
    }

    /**
     * Attempt to reconnect to the server
     */
    private async reconnect(): Promise<void> {
        this.state = "disconnected";
        try {
            await this.stop();
            await this.start();
        } catch (_error) {
            // Reconnection failed
        }
    }
}
