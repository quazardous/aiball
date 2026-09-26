/**
 * #3063 — the bus's wire format, shared by the daemon and its clients: JSON-RPC
 * 2.0 over a WebSocket at `BUS_PATH`, one text frame per message (a request, a
 * notification, a response, or a batch of them). No import: a client may load
 * this without loading the core. See docs/API-BUS.md.
 */

export const BUS_PATH = "/bus";

/** The protocol's version, sent in the connection's `bus.hello`. */
export const BUS_VERSION = 1;

/**
 * JSON-RPC's own error codes, for a message the bus could not run. A method's
 * refusal is not one of these: its `code` is the HTTP status it matches (400,
 * 403, 404, 409…), and `data.code` is aiball's error code (docs/API-ERRORS.md),
 * which is what a client reacts on.
 */
export const RPC_ERRORS = {
    PARSE_ERROR: -32700,
    INVALID_REQUEST: -32600,
    METHOD_NOT_FOUND: -32601,
    INVALID_PARAMS: -32602,
    INTERNAL_ERROR: -32603,
} as const;

export type RpcId = string | number | null;

export interface RpcRequest {
    jsonrpc: "2.0";
    /** Absent for a notification, which gets no response. */
    id?: RpcId;
    method: string;
    params?: unknown;
}

export interface RpcErrorData {
    /** aiball's error code (`ERROR_CODES`). */
    code: string;
    /** The HTTP status the refusal matches. */
    status: number;
    details?: Record<string, unknown>;
}

export interface RpcError {
    code: number;
    message: string;
    data?: RpcErrorData;
}

export type RpcResponse =
    | { jsonrpc: "2.0"; id: RpcId; result: unknown }
    | { jsonrpc: "2.0"; id: RpcId; error: RpcError };
