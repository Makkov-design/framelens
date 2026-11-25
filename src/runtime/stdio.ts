import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { RequestState } from "../tools/children.js";

type Id = string | number;
const idOf = (message: JSONRPCMessage): Id | undefined => ("id" in message && (typeof message.id === "string" || typeof message.id === "number") ? message.id : undefined);

/**
 * Counts the requests a connected transport has received and not yet answered, so the server can let them finish
 * when the client closes stdin. A request counts as answered when its response has been written, or when the
 * client cancels it (the SDK sends no response then). Call after `server.connect(transport)`, which sets `onmessage`.
 */
export function trackRequests(transport: Transport): RequestState {
  const open = new Set<Id>();
  let waiters: (() => void)[] = [];
  const settle = () => {
    if (open.size) return;
    const ready = waiters;
    waiters = [];
    for (const callback of ready) callback();
  };
  const receive = transport.onmessage;
  transport.onmessage = (message, extra) => {
    const id = idOf(message);
    if (id !== undefined && "method" in message) open.add(id);
    if ("method" in message && message.method === "notifications/cancelled") {
      const requestId = (message.params as { requestId?: Id } | undefined)?.requestId;
      if (requestId !== undefined && open.delete(requestId)) queueMicrotask(settle);
    }
    receive?.(message, extra);
  };
  const send = transport.send.bind(transport);
  transport.send = async (message, options) => {
    try {
      await send(message, options);
    } finally {
      const id = idOf(message);
      if (id !== undefined && !("method" in message) && open.delete(id)) settle();
    }
  };
  let pings = 0;
  return {
    pending: () => open.size,
    // A ping is valid from either side at any time (MCP). Its only use here is the write: once the client is gone,
    // writing to its stdout fails, and the server stops instead of finishing calls nobody will read.
    probe: () => transport.send({ jsonrpc: "2.0", id: `framelens-alive-${++pings}`, method: "ping" }),
    whenIdle: (callback) => {
      waiters.push(callback);
      settle();
    },
  };
}
